#!/usr/bin/env python3
"""Overlay court lines on a padel video using a homography JSON.

Court elements:
  - Court lines (white)  : service lines, center service line
  - Net        (amber)   : y = 10 m
  - Glass walls (cyan)   : back walls + first/last 4 m of side walls
  - Fence      (gray)    : dashed, middle section of side walls (y = 4–16 m)

Line geometry is projected from world (metre) coordinates to pixel space via
the inverse homography matrix and composited onto every frame.

Usage:
    python3 tools/overlay_homographic.py \\
        --video input.mp4 \\
        --homography homography_video.json \\
        --output output.mp4 \\
        [--alpha 0.55]
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np

# ── Court constants (metres) ─────────────────────────────────────────────────
NET_Y        = 10.0
SVC_Y_NEAR   =  3.05   # near service line (3.05 m from near baseline)
SVC_Y_FAR    = 16.95   # far service line  (3.05 m from far baseline)
GLASS_SIDE_Y =  4.0    # glass corner panels occupy first/last 4 m of each side wall

# ── Colours (BGR) ───────────────────────────────────────────────────────────
_WHITE  = (220, 220, 220)   # playing-field lines
_AMBER  = (  0, 195, 255)   # net
_GLASS  = (210, 230, 255)   # glass back-walls + glass side corners
_FENCE  = (130, 135, 140)   # metal mesh side fence


# ── Projection helpers ───────────────────────────────────────────────────────

def _px(H_inv: np.ndarray, wx: float, wy: float):
    """World (m) → pixel (int, int); returns None if degenerate."""
    p = H_inv @ np.array([wx, wy, 1.0])
    if abs(p[2]) < 1e-9:
        return None
    return (int(round(p[0] / p[2])), int(round(p[1] / p[2])))


def _line(canvas, H_inv, wx1, wy1, wx2, wy2, color, thickness=2):
    p1, p2 = _px(H_inv, wx1, wy1), _px(H_inv, wx2, wy2)
    if p1 and p2:
        cv2.line(canvas, p1, p2, color, thickness, cv2.LINE_AA)


def _dashed(canvas, H_inv, wx1, wy1, wx2, wy2, color, thickness=2, dash_m=0.5):
    """Draw a dashed line by sampling in world-space intervals."""
    world_len = math.hypot(wx2 - wx1, wy2 - wy1)
    n = max(2, int(world_len / (dash_m / 2)))
    for i in range(0, n, 2):
        t1, t2 = i / n, min((i + 1) / n, 1.0)
        p1 = _px(H_inv, wx1 + t1 * (wx2 - wx1), wy1 + t1 * (wy2 - wy1))
        p2 = _px(H_inv, wx1 + t2 * (wx2 - wx1), wy1 + t2 * (wy2 - wy1))
        if p1 and p2:
            cv2.line(canvas, p1, p2, color, thickness, cv2.LINE_AA)


# ── Court overlay builder ────────────────────────────────────────────────────

def build_overlay(H_inv: np.ndarray, height: int, width: int) -> np.ndarray:
    """
    Draw all court elements onto a black canvas.
    Returns uint8 (H, W, 3) with lines at full colour; alpha blending is
    applied per-frame in the processing loop.
    """
    c = np.zeros((height, width, 3), dtype=np.uint8)

    # Service lines (white)
    _line(c, H_inv, 0, SVC_Y_NEAR, 10, SVC_Y_NEAR, _WHITE, 2)
    _line(c, H_inv, 0, SVC_Y_FAR,  10, SVC_Y_FAR,  _WHITE, 2)
    # Center service line (white)
    _line(c, H_inv, 5, SVC_Y_NEAR,  5, SVC_Y_FAR,  _WHITE, 2)

    # Net (amber, thicker)
    _line(c, H_inv, 0, NET_Y, 10, NET_Y, _AMBER, 3)

    # Glass back walls (cyan-white, solid, drawn over baseline position)
    _line(c, H_inv,  0, 0,  10, 0,  _GLASS, 3)
    _line(c, H_inv,  0, 20, 10, 20, _GLASS, 3)

    # Glass side corner panels (solid cyan-white)
    for x in (0.0, 10.0):
        _line(c, H_inv, x,  0,                x, GLASS_SIDE_Y,         _GLASS, 3)
        _line(c, H_inv, x,  20 - GLASS_SIDE_Y, x, 20,                  _GLASS, 3)

    # Fence sections — metal mesh between the glass corners (dashed gray)
    for x in (0.0, 10.0):
        _dashed(c, H_inv, x, GLASS_SIDE_Y, x, 20 - GLASS_SIDE_Y, _FENCE, 2, dash_m=0.4)

    return c


# ── CLI ──────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="Overlay court lines on a padel video via homography."
    )
    p.add_argument("--video",      required=True, help="Input video")
    p.add_argument("--homography", required=True, help="Homography JSON")
    p.add_argument("--output",     required=True, help="Output video")
    p.add_argument("--alpha",      type=float, default=0.55,
                   help="Line opacity 0–1 (default: 0.55)")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    with open(args.homography) as f:
        hom = json.load(f)

    H     = np.array(hom["H"], dtype=np.float64)
    H_inv = np.linalg.inv(H)
    cal_w = hom["frame_size"]["width"]
    cal_h = hom["frame_size"]["height"]

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"ERROR: cannot open {args.video}", file=sys.stderr)
        return 1

    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps    = cap.get(cv2.CAP_PROP_FPS)
    total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # If the video resolution differs from calibration, scale H_inv
    if width != cal_w or height != cal_h:
        sx, sy = width / cal_w, height / cal_h
        S = np.diag([sx, sy, 1.0])
        H_inv = S @ H_inv

    # Build the static overlay once
    court_canvas = build_overlay(H_inv, height, width)
    court_mask   = court_canvas.sum(axis=2) > 0   # bool mask where lines exist
    court_f32    = court_canvas.astype(np.float32)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)

    use_ffmpeg = shutil.which("ffmpeg") is not None
    write_path = args.output
    if use_ffmpeg:
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".mp4")
        os.close(tmp_fd)
        write_path = tmp_path

    out = cv2.VideoWriter(
        write_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height)
    )
    if not out.isOpened():
        print(f"ERROR: cannot open output {write_path}", file=sys.stderr)
        cap.release()
        return 1

    alpha = args.alpha
    print(f"Processing {total} frames  (alpha={alpha})…")
    fi = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break

        # Alpha-composite court lines only where they were drawn
        result = frame.astype(np.float32)
        result[court_mask] = (
            result[court_mask] * (1.0 - alpha) + court_f32[court_mask] * alpha
        )
        out.write(np.clip(result, 0, 255).astype(np.uint8))

        fi += 1
        if fi % 300 == 0:
            print(f"  {fi}/{total} ({100 * fi // total}%)")

    cap.release()
    out.release()

    if use_ffmpeg:
        print("Re-encoding with H.264…")
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_path,
             "-c:v", "libx264", "-preset", "fast", "-crf", "18",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart",
             args.output],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        os.unlink(tmp_path)

    print(f"Done → {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
