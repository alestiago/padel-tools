#!/usr/bin/env python3
"""Overlay ball velocity vectors on a padel video.

Usage:
    python3 tools/overlay_velocity.py \\
        --csv .dev/ball_velocity_*.csv \\
        --video .dev/padel_short_3min.mp4 \\
        --homography .dev/homography_video_short.json \\
        --output out.mp4

The --homography flag is needed when the CSV pixel coordinates were produced
from a different resolution than the output video (e.g. 4K homography but
1080p video). The script reads the homography frame_size and scales accordingly.
"""

import argparse
import csv
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np

# Max time gap between consecutive detections to trust the direction vector.
MAX_GAP_S = 0.5

# How many extra video frames to keep showing an overlay after a detection.
# At 30 fps, 15 frames = 0.5 s of visible overlay per detection.
DEFAULT_HOLD_FRAMES = 15

# Arrow length scaling: pixels per km/h, capped at MAX_ARROW_PX.
PX_PER_KMH = 0.9
MAX_ARROW_PX = 160

BALL_COLOR = (50, 255, 50)    # green
ARROW_COLOR = (0, 200, 255)   # yellow-orange
TEXT_COLOR = (0, 200, 255)
BALL_RADIUS = 14


def load_detections(csv_path: str) -> list[dict]:
    """Load rows that have a ball position, sorted by time."""
    rows = []
    with open(csv_path, newline="") as f:
        for row in csv.DictReader(f):
            if not row["ball_u_px"]:
                continue
            rows.append({
                "time_s": float(row["time_s"]),
                "u": float(row["ball_u_px"]),
                "v": float(row["ball_v_px"]),
                "velocity": float(row["velocity_kmh"]) if row["velocity_kmh"] else None,
            })
    return sorted(rows, key=lambda r: r["time_s"])


def compute_directions(detections: list[dict]) -> list[tuple[float, float] | None]:
    """Return a direction unit vector for each detection (parallel list).

    Prefer look-ahead (current → next) when close enough, fall back to
    look-behind, so the arrow points where the ball is heading.
    """
    directions: list[tuple[float, float] | None] = []
    n = len(detections)
    for i, det in enumerate(detections):
        direction = None

        if i < n - 1:
            nxt = detections[i + 1]
            if nxt["time_s"] - det["time_s"] <= MAX_GAP_S:
                du = nxt["u"] - det["u"]
                dv = nxt["v"] - det["v"]
                length = math.hypot(du, dv)
                if length > 0:
                    direction = (du / length, dv / length)

        if direction is None and i > 0:
            prev = detections[i - 1]
            if det["time_s"] - prev["time_s"] <= MAX_GAP_S:
                du = det["u"] - prev["u"]
                dv = det["v"] - prev["v"]
                length = math.hypot(du, dv)
                if length > 0:
                    direction = (du / length, dv / length)

        directions.append(direction)
    return directions


def build_frame_map(
    detections: list[dict],
    directions: list[tuple | None],
    fps: float,
    hold_frames: int,
) -> dict[int, dict]:
    """Map video frame numbers → overlay data, holding each detection visible
    for `hold_frames` extra frames so it's not a single-frame flash."""
    # First pass: exact detection frames (later detections override earlier holds)
    exact: dict[int, dict] = {}
    for det, direction in zip(detections, directions):
        vf = round(det["time_s"] * fps)
        exact[vf] = {"u": det["u"], "v": det["v"], "velocity": det["velocity"], "direction": direction}

    # Second pass: expand each detection forward by hold_frames, but stop if
    # a newer detection starts (don't clobber it with stale data)
    frame_map: dict[int, dict] = {}
    exact_frames = sorted(exact.keys())
    for i, vf in enumerate(exact_frames):
        entry = exact[vf]
        next_detection = exact_frames[i + 1] if i + 1 < len(exact_frames) else vf + hold_frames + 1
        limit = min(vf + hold_frames, next_detection - 1)
        for f in range(vf, limit + 1):
            frame_map[f] = entry

    return frame_map


def draw_overlay(
    frame: np.ndarray,
    u: float,
    v: float,
    velocity: float | None,
    direction: tuple[float, float] | None,
) -> None:
    cx, cy = int(round(u)), int(round(v))

    cv2.circle(frame, (cx, cy), BALL_RADIUS, BALL_COLOR, 2, cv2.LINE_AA)
    cv2.circle(frame, (cx, cy), 3, BALL_COLOR, -1, cv2.LINE_AA)

    if direction is not None and velocity is not None and velocity > 0:
        arrow_len = min(velocity * PX_PER_KMH, MAX_ARROW_PX)
        dx, dy = direction
        ex = int(round(cx + dx * arrow_len))
        ey = int(round(cy + dy * arrow_len))
        cv2.arrowedLine(frame, (cx, cy), (ex, ey), ARROW_COLOR, 2, cv2.LINE_AA, tipLength=0.25)

    if velocity is not None:
        label = f"{velocity:.0f} km/h"
        tx, ty = cx + BALL_RADIUS + 6, cy - 6
        cv2.putText(frame, label, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX, 0.65, TEXT_COLOR, 2, cv2.LINE_AA)


def main() -> None:
    parser = argparse.ArgumentParser(description="Overlay ball velocity vectors on a padel video.")
    parser.add_argument("--csv", required=True, help="Path to ball velocity CSV")
    parser.add_argument("--video", required=True, help="Path to input video")
    parser.add_argument("--homography", help="Path to homography JSON (used to scale pixel coordinates)")
    parser.add_argument("--output", default="output_overlay.mp4", help="Output video path")
    parser.add_argument(
        "--hold-frames",
        type=int,
        default=DEFAULT_HOLD_FRAMES,
        help=f"Frames to keep the overlay visible after each detection (default {DEFAULT_HOLD_FRAMES})",
    )
    args = parser.parse_args()

    print(f"Loading detections from {args.csv}...")
    detections = load_detections(args.csv)
    directions = compute_directions(detections)
    print(f"  {len(detections)} detections, {sum(d is not None for d in directions)} with direction vectors")

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"Error: could not open {args.video}", file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    coord_scale = 1.0
    if args.homography:
        with open(args.homography) as f:
            hdata = json.load(f)
        h_width = hdata["frame_size"]["width"]
        h_height = hdata["frame_size"]["height"]
        scale_x = width / h_width
        scale_y = height / h_height
        if abs(scale_x - scale_y) > 0.01:
            print(f"Warning: non-uniform scale ({scale_x:.3f} x {scale_y:.3f}), using x-scale", file=sys.stderr)
        coord_scale = scale_x
        print(f"  Homography {h_width}x{h_height} → video {width}x{height}: coord scale {coord_scale:.4f}")

    if coord_scale != 1.0:
        for det in detections:
            det["u"] *= coord_scale
            det["v"] *= coord_scale

    frame_map = build_frame_map(detections, directions, fps, args.hold_frames)
    print(f"  {len(frame_map)} video frames will carry an overlay (hold={args.hold_frames} frames each)")
    print(f"  Video: {width}x{height} @ {fps:.2f} fps, {total_frames} total frames")

    # Write to a temp file with mp4v, then re-encode to H.264 with ffmpeg if available
    use_ffmpeg = shutil.which("ffmpeg") is not None
    if use_ffmpeg:
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".mp4")
        os.close(tmp_fd)
        write_path = tmp_path
    else:
        write_path = args.output

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(write_path, fourcc, fps, (width, height))
    if not out.isOpened():
        print(f"Error: could not open output {write_path}", file=sys.stderr)
        cap.release()
        sys.exit(1)

    print("Processing frames...")
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx in frame_map:
            entry = frame_map[frame_idx]
            draw_overlay(frame, entry["u"], entry["v"], entry["velocity"], entry["direction"])

        out.write(frame)
        frame_idx += 1

        if frame_idx % 500 == 0:
            print(f"  {frame_idx}/{total_frames} ({100 * frame_idx // total_frames}%)")

    cap.release()
    out.release()

    if use_ffmpeg:
        print("Re-encoding to H.264 for compatibility...")
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", tmp_path,
                "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                args.output,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        os.unlink(tmp_path)

    print(f"Done. Output: {args.output}")

    # Print timestamps so the user knows where to look
    detection_times = sorted({round(d["time_s"]) for d in detections})
    print(f"\nDetections visible at approximately: {', '.join(f'{t}s' for t in detection_times)}")


if __name__ == "__main__":
    main()
