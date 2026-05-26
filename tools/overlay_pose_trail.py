#!/usr/bin/env python3
"""Overlay a glowing comet-trail on a video using a keypoint from a pose-labeller JSON.

Usage:
    python3 tools/overlay_pose_trail.py \
        --poses ~/Documents/ep3/source_writ_poses.json \
        --video ~/Documents/ep3/source_writ.mp4 \
        --output .dev/ep3/wrist_trail.mp4

The poses JSON is the multi-frame export from pose-labeller-tool (version 2).
Each frame is expected to carry a single wrist keypoint, but any keypoint works.

Options:
    --keypoint NAME     Keypoint to trail (default: auto-detect most common in data).
    --smoothness FLOAT        Temporal Gaussian sigma in frames to smooth labelling jitter (e.g. 3.5).
                              0 = off (default). Uses a bilateral filter to avoid lag on fast motion.
    --smooth-spatial FLOAT    Spatial sigma in pixels for the bilateral filter (default 12).
                              Lower = less influence from spatially distant neighbors (sharper on fast moves).
                              Set to 0 to fall back to plain Gaussian (which lags during fast motion).
    --trail-length N          Past positions to keep (default 22).
    --lerp                    Legacy alias for --smoothness with --lerp-sigma value.
    --lerp-sigma FLOAT        Gaussian sigma used by --lerp (default 1.5).
    --lerp-max-gap INT        Max frame gap to interpolate across (default 8).
    --no-head-circle    Omit filled circle at current position.
    --no-aureola        Omit outer glow ring.
    --gradient NAME     Colour preset: comet (default), yellow, fire, ice, naranja, red.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, deque

import cv2
import numpy as np

TRAIL_LENGTH_DEFAULT = 22
BALL_RADIUS = 9
GLOW_RADIUS = 24

GRADIENTS: dict[str, list[tuple[int, int, int]]] = {
    "comet": [
        (110, 10,  50),
        (220, 50, 170),
        (255, 230, 60),
        (230, 255, 255),
    ],
    "yellow": [
        (0,  30,  80),
        (0, 100, 200),
        (0, 230, 255),
        (200, 255, 255),
    ],
    "fire": [
        (0,   0,  60),
        (0,  30, 180),
        (0, 140, 255),
        (0, 230, 255),
    ],
    "ice": [
        (80,  20,  10),
        (200, 100, 40),
        (255, 210, 120),
        (255, 255, 240),
    ],
    "naranja": [
        (0,   20,  80),
        (0,  111, 255),
        (0,  200, 255),
        (120, 230, 255),
    ],
    "red": [
        (0,   0,  50),
        (0,   0, 160),
        (0,   0, 248),
        (180, 180, 255),
    ],
}
DEFAULT_GRADIENT = "comet"


def lerp_color(t: float, gradient: list[tuple]) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    n = len(gradient) - 1
    idx = t * n
    lo = int(idx)
    hi = min(lo + 1, n)
    f = idx - lo
    return tuple(int(gradient[lo][c] * (1.0 - f) + gradient[hi][c] * f) for c in range(3))


def load_poses_json(
    path: str, keypoint: str | None
) -> tuple[dict[int, tuple[float, float]], str, float | None]:
    """Return (positions_by_frame, keypoint_used, fps)."""
    with open(path) as f:
        data = json.load(f)

    version = data.get("version", 1)
    fps = data.get("fps")

    if version == 2:
        poses = data.get("poses", [])
    elif version == 1:
        # Single-frame export — wrap in a list
        poses = [data]
    else:
        sys.exit(f"Error: unsupported pose file version {version}")

    # Auto-detect the most common visible keypoint when none is specified
    if keypoint is None:
        counter: Counter[str] = Counter()
        for pose in poses:
            for kp_name, kp in pose.get("keypoints", {}).items():
                if kp.get("visibility") == "visible":
                    counter[kp_name] += 1
        if not counter:
            sys.exit("Error: no visible keypoints found in poses file")
        keypoint = counter.most_common(1)[0][0]
        print(f"Auto-detected keypoint: {keypoint} ({counter[keypoint]} frames)")

    positions: dict[int, tuple[float, float]] = {}
    for pose in poses:
        frame = int(pose["frame"])
        kp = pose.get("keypoints", {}).get(keypoint)
        if kp and kp.get("visibility") == "visible":
            positions[frame] = (float(kp["x"]), float(kp["y"]))

    return positions, keypoint, float(fps) if fps is not None else None


def _fill_gaps(
    positions: dict[int, tuple[float, float]],
    max_gap: int,
) -> dict[int, tuple[float, float]]:
    """Linear interpolation across gaps up to max_gap frames wide."""
    sorted_frames = sorted(positions.keys())
    dense = dict(positions)
    for prev, curr in zip(sorted_frames, sorted_frames[1:]):
        if 1 < curr - prev <= max_gap:
            for f_mid in range(prev + 1, curr):
                t = (f_mid - prev) / (curr - prev)
                dense[f_mid] = (
                    positions[prev][0] + t * (positions[curr][0] - positions[prev][0]),
                    positions[prev][1] + t * (positions[curr][1] - positions[prev][1]),
                )
    return dense


def smooth_positions(
    positions: dict[int, tuple[float, float]],
    sigma: float = 1.5,
    max_gap: int = 8,
    spatial_sigma: float = 12.0,
) -> dict[int, tuple[float, float]]:
    """Bilateral filter in time: weight neighbors by both temporal and spatial distance.

    Pure Gaussian smoothing lags during fast motion because it averages in positions
    from frames where the keypoint was far behind. The spatial weight here reduces the
    influence of temporally-nearby-but-spatially-distant positions, so the trail tracks
    fast motion accurately while still removing small labelling jitter.

    spatial_sigma: pixel distance at which neighbor weight drops to ~37%. Set to 0
    to fall back to plain Gaussian smoothing.
    """
    if len(positions) < 2:
        return dict(positions)

    dense = _fill_gaps(positions, max_gap)
    frames = sorted(dense.keys())
    radius = max(1, int(3.0 * sigma))

    result: dict[int, tuple[float, float]] = {}
    for i, f in enumerate(frames):
        cx, cy = dense[f]
        total_w = 0.0
        sx, sy = 0.0, 0.0
        for j in range(max(0, i - radius), min(len(frames), i + radius + 1)):
            nf = frames[j]
            nx, ny = dense[nf]
            t_w = np.exp(-0.5 * (nf - f) ** 2 / sigma ** 2)
            if spatial_sigma > 0:
                dist2 = (nx - cx) ** 2 + (ny - cy) ** 2
                s_w = np.exp(-0.5 * dist2 / spatial_sigma ** 2)
            else:
                s_w = 1.0
            w = t_w * s_w
            sx += w * nx
            sy += w * ny
            total_w += w
        result[f] = (sx / total_w, sy / total_w)

    return result


def draw_trail(
    frame: np.ndarray,
    trail: list[tuple[float, float]],
    gradient: list[tuple[int, int, int]],
    show_head_circle: bool = True,
    show_aureola: bool = True,
    opacity: float = 0.92,
) -> None:
    n = len(trail)
    if n == 0:
        return

    overlay = np.zeros_like(frame, dtype=np.uint8)
    n_eff = max(n - 1, 1)

    for i in range(1, n):
        t = i / n_eff
        color = lerp_color(t, gradient)
        thickness = max(1, int(1 + t * 5))
        p1 = (int(round(trail[i - 1][0])), int(round(trail[i - 1][1])))
        p2 = (int(round(trail[i][0])), int(round(trail[i][1])))
        cv2.line(overlay, p1, p2, color, thickness, cv2.LINE_AA)

    for i, (x, y) in enumerate(trail):
        t = i / n_eff
        color = lerp_color(t, gradient)
        r = max(2, int(2 + t * (BALL_RADIUS - 2)))
        cv2.circle(overlay, (int(round(x)), int(round(y))), r, color, -1, cv2.LINE_AA)

    hx, hy = int(round(trail[-1][0])), int(round(trail[-1][1]))
    head_color = lerp_color(1.0, gradient)
    if show_aureola:
        cv2.circle(overlay, (hx, hy), GLOW_RADIUS, head_color, 2, cv2.LINE_AA)
    if show_head_circle:
        cv2.circle(overlay, (hx, hy), BALL_RADIUS + 3, head_color, -1, cv2.LINE_AA)

    alpha = (np.max(overlay, axis=2).astype(np.float32) / 255.0 * opacity)[..., np.newaxis]
    blended = frame.astype(np.float32) * (1.0 - alpha) + overlay.astype(np.float32) * alpha
    np.copyto(frame, np.clip(blended, 0, 255).astype(np.uint8))


def main() -> None:
    parser = argparse.ArgumentParser(description="Keypoint comet-trail overlay from pose-labeller JSON.")
    parser.add_argument("--poses", required=True, help="Pose labels JSON (pose-labeller-tool export)")
    parser.add_argument("--video", required=True, help="Input video path")
    parser.add_argument("--output", default="output_pose_trail.mp4", help="Output video path")
    parser.add_argument("--keypoint", default=None, help="Keypoint name to trail (default: auto-detect)")
    parser.add_argument(
        "--trail-length", type=int, default=TRAIL_LENGTH_DEFAULT,
        help=f"Trail length in frames (default {TRAIL_LENGTH_DEFAULT})",
    )
    parser.add_argument(
        "--smoothness", type=float, default=0.0, metavar="SIGMA",
        help="Temporal Gaussian sigma in frames to smooth labelling jitter (0 = off)",
    )
    parser.add_argument(
        "--smooth-spatial", type=float, default=12.0, metavar="PIXELS",
        help="Spatial sigma (px) for bilateral smoothing — 0 = plain Gaussian (default 12)",
    )
    parser.add_argument("--lerp", action="store_true", help="Legacy alias for --smoothness (uses --lerp-sigma)")
    parser.add_argument("--lerp-sigma", type=float, default=1.5)
    parser.add_argument("--lerp-max-gap", type=int, default=8)
    parser.add_argument("--no-head-circle", action="store_true")
    parser.add_argument("--no-aureola", action="store_true")
    parser.add_argument(
        "--overlay-only", action="store_true",
        help="Render trail on a black background with no video beneath (for compositing)",
    )
    parser.add_argument(
        "--opacity", type=float, default=0.92, metavar="0-1",
        help="Overall trail opacity (default 0.92)",
    )
    parser.add_argument(
        "--gradient", default=DEFAULT_GRADIENT, choices=list(GRADIENTS),
        help=f"Colour preset (default: {DEFAULT_GRADIENT})",
    )
    args = parser.parse_args()

    poses_path = os.path.expanduser(args.poses)
    video_path = os.path.expanduser(args.video)

    positions, keypoint_used, label_fps = load_poses_json(poses_path, args.keypoint)
    print(f"Loaded {len(positions)} positions for '{keypoint_used}' from {poses_path}")

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        sys.exit(f"Error: could not open video {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f"Video: {width}x{height} @ {fps:.2f} fps — {total} frames")

    if label_fps is not None and abs(label_fps - fps) > 0.5:
        ratio = fps / label_fps
        print(f"Label fps ({label_fps}) differs from video fps ({fps:.2f}) — remapping by ×{ratio:.4f}")
        positions = {int(round(f * ratio)): pos for f, pos in positions.items()}

    sigma = args.smoothness if args.smoothness > 0 else (args.lerp_sigma if args.lerp else 0.0)
    if sigma > 0:
        positions = smooth_positions(
            positions, sigma=sigma, max_gap=args.lerp_max_gap, spatial_sigma=args.smooth_spatial
        )
        print(f"  After smoothing (sigma={sigma}, spatial_sigma={args.smooth_spatial}, max_gap={args.lerp_max_gap}): {len(positions)} positions")

    gradient = GRADIENTS[args.gradient]
    print(f"Gradient: {args.gradient}  |  head circle: {not args.no_head_circle}  |  aureola: {not args.no_aureola}")

    use_ffmpeg = shutil.which("ffmpeg") is not None
    if use_ffmpeg:
        fd, tmp_path = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)
        write_path = tmp_path
    else:
        write_path = args.output

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(write_path, fourcc, fps, (width, height))
    if not out.isOpened():
        cap.release()
        sys.exit(f"Error: could not open output writer for {write_path}")

    trail: deque[tuple[float, float]] = deque(maxlen=args.trail_length)
    frame_idx = 0

    print("Rendering trail...")
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if args.overlay_only:
            frame[:] = 0

        if frame_idx in positions:
            trail.append(positions[frame_idx])

        if trail:
            draw_trail(
                frame, list(trail), gradient,
                show_head_circle=not args.no_head_circle,
                show_aureola=not args.no_aureola,
                opacity=args.opacity,
            )

        out.write(frame)
        frame_idx += 1

        if frame_idx % 300 == 0:
            print(f"  {frame_idx}/{total} ({100 * frame_idx // total}%)")

    cap.release()
    out.release()

    if use_ffmpeg:
        print("Re-encoding to H.264...")
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", tmp_path,
                "-i", video_path,
                "-map", "0:v:0",
                "-map", "1:a?",
                "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                "-c:a", "copy",
                args.output,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        os.unlink(tmp_path)

    print(f"\nDone → {args.output}")


if __name__ == "__main__":
    main()
