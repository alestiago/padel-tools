#!/usr/bin/env python3
"""Overlay a glowing comet-trail effect on a padel video using labelled ball positions.

Usage:
    python3 tools/overlay_trail.py \
        --labels .dev/jugada1/jugada1_labels.json \
        --video  .dev/jugada1/jugada1.mp4 \
        --output .dev/jugada1/jugada1_trail.mp4

Options:
    --lerp              Smooth label positions with Gaussian filtering and fill
                        small gaps via linear interpolation (reduces pixel jitter).
    --lerp-sigma FLOAT  Gaussian sigma in frames for smoothing (default 1.5).
    --lerp-max-gap INT  Max frame gap to interpolate across (default 8).
    --no-head-circle    Omit the filled circle drawn on the current ball position
                        so the real ball in the video remains visible.
    --no-aureola        Omit the thin outer glow ring drawn around the head.
    --gradient NAME     Trail colour preset. Choices: comet (default), yellow, fire, ice.
"""

import argparse
import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections import deque

import cv2
import numpy as np

TRAIL_LENGTH_DEFAULT = 22
BALL_RADIUS = 9
GLOW_RADIUS = 24

# Named BGR gradients, oldest (tail) → newest (head).
# Add new entries here to expose them via --gradient.
GRADIENTS: dict[str, list[tuple[int, int, int]]] = {
    "comet": [          # deep purple → electric blue → cyan → white
        (110, 10,  50),
        (220, 50, 170),
        (255, 230, 60),
        (230, 255, 255),
    ],
    "yellow": [         # dark brown → orange → yellow → white-yellow (ball-like)
        (0,  30,  80),
        (0, 100, 200),
        (0, 230, 255),
        (200, 255, 255),
    ],
    "fire": [           # near-black → deep red → orange → bright yellow
        (0,   0,  60),
        (0,  30, 180),
        (0, 140, 255),
        (0, 230, 255),
    ],
    "ice": [            # dark navy → steel blue → light cyan → white
        (80,  20,  10),
        (200, 100, 40),
        (255, 210, 120),
        (255, 255, 240),
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


def load_labels_json(path: str) -> dict[int, tuple[float, float]]:
    with open(path) as f:
        data = json.load(f)
    result = {}
    for label in data.get("labels", []):
        if label.get("visibility") == "visible":
            result[int(label["frame"])] = (float(label["x"]), float(label["y"]))
    return result


def load_labels_csv(path: str) -> dict[int, tuple[float, float]]:
    result = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            if row.get("visibility") == "visible":
                result[int(row["frame"])] = (float(row["x"]), float(row["y"]))
    return result


def _gaussian_smooth_1d(arr: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian smooth a 1-D array using reflect-padding to avoid edge pull."""
    radius = max(1, int(3.0 * sigma))
    k = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-0.5 * k ** 2 / sigma ** 2)
    kernel /= kernel.sum()
    padded = np.pad(arr, radius, mode="reflect")
    return np.convolve(padded, kernel, mode="valid")


def smooth_labels(
    labels: dict[int, tuple[float, float]],
    sigma: float = 1.5,
    max_gap: int = 8,
) -> dict[int, tuple[float, float]]:
    """Fill small gaps via linear interpolation then Gaussian-smooth x and y.

    Segments separated by gaps larger than max_gap are smoothed independently
    so a long occlusion doesn't pull positions on either side toward each other.
    """
    if len(labels) < 2:
        return dict(labels)

    sorted_frames = sorted(labels.keys())

    # --- 1. split into contiguous segments (gap <= max_gap) ---
    segments: list[list[int]] = []
    seg: list[int] = [sorted_frames[0]]
    for prev, curr in zip(sorted_frames, sorted_frames[1:]):
        if curr - prev <= max_gap:
            seg.append(curr)
        else:
            segments.append(seg)
            seg = [curr]
    segments.append(seg)

    result: dict[int, tuple[float, float]] = {}
    for seg_frames in segments:
        # fill in frames within the segment
        dense: dict[int, tuple[float, float]] = {}
        for i, f in enumerate(seg_frames):
            dense[f] = labels[f]
            if i < len(seg_frames) - 1:
                f_next = seg_frames[i + 1]
                for f_mid in range(f + 1, f_next):
                    t = (f_mid - f) / (f_next - f)
                    x = labels[f][0] + t * (labels[f_next][0] - labels[f][0])
                    y = labels[f][1] + t * (labels[f_next][1] - labels[f][1])
                    dense[f_mid] = (x, y)

        dense_frames = sorted(dense.keys())
        xs = np.array([dense[f][0] for f in dense_frames], dtype=np.float64)
        ys = np.array([dense[f][1] for f in dense_frames], dtype=np.float64)

        xs_s = _gaussian_smooth_1d(xs, sigma)
        ys_s = _gaussian_smooth_1d(ys, sigma)

        for i, f in enumerate(dense_frames):
            result[f] = (float(xs_s[i]), float(ys_s[i]))

    return result


def draw_trail(
    frame: np.ndarray,
    trail: list[tuple[float, float]],
    gradient: list[tuple[int, int, int]],
    show_head_circle: bool = True,
    show_aureola: bool = True,
) -> None:
    """Alpha-blend a comet trail onto frame in-place. trail is oldest-first."""
    n = len(trail)
    if n == 0:
        return

    overlay = np.zeros_like(frame, dtype=np.uint8)
    n_eff = max(n - 1, 1)

    # Connecting line segments — thicker and brighter near the head
    for i in range(1, n):
        t = i / n_eff
        color = lerp_color(t, gradient)
        thickness = max(1, int(1 + t * 5))
        p1 = (int(round(trail[i - 1][0])), int(round(trail[i - 1][1])))
        p2 = (int(round(trail[i][0])), int(round(trail[i][1])))
        cv2.line(overlay, p1, p2, color, thickness, cv2.LINE_AA)

    # Dots at each position — grow toward the head
    for i, (x, y) in enumerate(trail):
        t = i / n_eff
        color = lerp_color(t, gradient)
        r = max(2, int(2 + t * (BALL_RADIUS - 2)))
        cv2.circle(overlay, (int(round(x)), int(round(y))), r, color, -1, cv2.LINE_AA)

    # Head: optional glow ring and/or filled circle
    hx, hy = int(round(trail[-1][0])), int(round(trail[-1][1]))
    head_color = lerp_color(1.0, gradient)
    if show_aureola:
        cv2.circle(overlay, (hx, hy), GLOW_RADIUS, head_color, 2, cv2.LINE_AA)
    if show_head_circle:
        cv2.circle(overlay, (hx, hy), BALL_RADIUS + 3, head_color, -1, cv2.LINE_AA)

    # Per-pixel alpha: brighter overlay pixels blend more strongly
    gray = cv2.cvtColor(overlay, cv2.COLOR_BGR2GRAY)
    alpha = (gray.astype(np.float32) / 255.0 * 0.92)[..., np.newaxis]
    blended = frame.astype(np.float32) * (1.0 - alpha) + overlay.astype(np.float32) * alpha
    np.copyto(frame, np.clip(blended, 0, 255).astype(np.uint8))


def main() -> None:
    parser = argparse.ArgumentParser(description="Ball comet-trail overlay for padel video.")
    parser.add_argument("--labels", required=True, help="Labels JSON or CSV path")
    parser.add_argument("--video", required=True, help="Input video path")
    parser.add_argument("--output", default="output_trail.mp4", help="Output video path")
    parser.add_argument(
        "--trail-length",
        type=int,
        default=TRAIL_LENGTH_DEFAULT,
        help=f"Number of past positions to keep in the trail (default {TRAIL_LENGTH_DEFAULT})",
    )
    parser.add_argument(
        "--lerp",
        action="store_true",
        help="Smooth label positions (Gaussian) and fill small gaps via linear interpolation",
    )
    parser.add_argument(
        "--lerp-sigma",
        type=float,
        default=1.5,
        help="Gaussian sigma in frames for --lerp smoothing (default 1.5)",
    )
    parser.add_argument(
        "--lerp-max-gap",
        type=int,
        default=8,
        help="Max frame gap to interpolate across with --lerp (default 8)",
    )
    parser.add_argument(
        "--no-head-circle",
        action="store_true",
        help="Omit the filled head circle so the real ball is not occluded",
    )
    parser.add_argument(
        "--no-aureola",
        action="store_true",
        help="Omit the thin outer glow ring drawn around the head position",
    )
    parser.add_argument(
        "--gradient",
        default=DEFAULT_GRADIENT,
        choices=list(GRADIENTS),
        help=f"Trail colour preset (default: {DEFAULT_GRADIENT}). Choices: {', '.join(GRADIENTS)}",
    )
    args = parser.parse_args()

    if args.labels.endswith(".json"):
        labels = load_labels_json(args.labels)
    else:
        labels = load_labels_csv(args.labels)
    print(f"Loaded {len(labels)} visible ball positions from {args.labels}")

    if args.lerp:
        labels = smooth_labels(labels, sigma=args.lerp_sigma, max_gap=args.lerp_max_gap)
        print(f"  After lerp/smooth: {len(labels)} positions (sigma={args.lerp_sigma}, max_gap={args.lerp_max_gap})")

    gradient = GRADIENTS[args.gradient]
    print(f"Gradient: {args.gradient}  |  head circle: {not args.no_head_circle}  |  aureola: {not args.no_aureola}")

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit(f"Error: could not open video {args.video}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f"Video: {width}x{height} @ {fps:.2f} fps — {total} frames")

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

        if frame_idx in labels:
            trail.append(labels[frame_idx])

        if trail:
            draw_trail(
                frame, list(trail), gradient,
                show_head_circle=not args.no_head_circle,
                show_aureola=not args.no_aureola,
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
                "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
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
