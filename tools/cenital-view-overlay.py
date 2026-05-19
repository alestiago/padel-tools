#!/usr/bin/env python3
"""Render a top-down (cenital) court mini-map in the top-right corner of a video.

Player positions are sourced from a players CSV (court_x_m, court_y_m columns).
The court is drawn in portrait orientation (1:2 aspect ratio matching 10×20 m).

Usage:
    python3 tools/cenital-view-overlay.py \\
        --video .dev/player-detectors/overlay_players_v2.mp4 \\
        --csv .dev/player-detectors/players_v2.csv \\
        --output out_cenital.mp4 \\
        [--map-height 300] [--bg-alpha 0.45] [--alpha 0.9] [--margin 12] \\
        [--trail 20] [--lerp 0.25]
"""

import argparse
import collections
import csv
import math
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np

# ── Court constants (metres) ─────────────────────────────────────────────────
_COURT_W      = 10.0
_COURT_H      = 20.0
_NET_Y        = 10.0
_SVC_Y_NEAR   =  3.05
_SVC_Y_FAR    = 16.95
_GLASS_SIDE_Y =  4.0

# ── Colours (BGR) ───────────────────────────────────────────────────────────
_PLAYER_COLORS = {
    1: ( 50, 220,  50),   # green   — near, left
    2: ( 50, 220, 220),   # yellow  — near, right
    3: ( 50,  80, 220),   # orange  — far,  left
    4: (200,  50, 220),   # magenta — far,  right
}
_DEFAULT_COLOR = (200, 200, 200)
_BG_COLOR      = ( 18,  18,  22)   # very dark navy
_LINE_WHITE    = (180, 180, 180)
_LINE_AMBER    = (  0, 180, 230)
_LINE_GLASS    = (190, 215, 240)
_LINE_FENCE    = (100, 105, 110)
_DOT_RADIUS    = 7


# ── Mini-map coordinate helpers ───────────────────────────────────────────────

def _build_transform(map_w: int, map_h: int, pad: int):
    """Return callables: world metres → map pixel (int)."""
    inner_w = map_w - 2 * pad
    inner_h = map_h - 2 * pad

    def to_px(x_m: float) -> int:
        return int(round(pad + x_m / _COURT_W * inner_w))

    def to_py(y_m: float) -> int:
        return int(round(pad + y_m / _COURT_H * inner_h))

    return to_px, to_py


def _dashed_line(canvas, x1, y1, x2, y2, color, thickness=1, dash_px=5):
    length = math.hypot(x2 - x1, y2 - y1)
    n = max(2, int(length / (dash_px * 2)))
    for i in range(0, n, 2):
        t1, t2 = i / n, min((i + 1) / n, 1.0)
        p1 = (int(x1 + t1 * (x2 - x1)), int(y1 + t1 * (y2 - y1)))
        p2 = (int(x1 + t2 * (x2 - x1)), int(y1 + t2 * (y2 - y1)))
        cv2.line(canvas, p1, p2, color, thickness, cv2.LINE_AA)


def build_court_lines(map_w: int, map_h: int, pad: int) -> np.ndarray:
    """Court lines on a black (fully transparent) canvas — no background fill."""
    canvas = np.zeros((map_h, map_w, 3), dtype=np.uint8)
    px, py = _build_transform(map_w, map_h, pad)

    def line(x1, y1, x2, y2, color, t=1):
        cv2.line(canvas, (px(x1), py(y1)), (px(x2), py(y2)), color, t, cv2.LINE_AA)

    # Outer boundary
    line(0,  0,  10,  0,  _LINE_WHITE, 2)
    line(0,  20, 10,  20, _LINE_WHITE, 2)
    line(0,  0,   0,  20, _LINE_WHITE, 2)
    line(10, 0,  10,  20, _LINE_WHITE, 2)

    # Net
    line(0, _NET_Y, 10, _NET_Y, _LINE_AMBER, 2)

    # Service lines + centre
    line(0, _SVC_Y_NEAR, 10, _SVC_Y_NEAR, _LINE_WHITE, 1)
    line(0, _SVC_Y_FAR,  10, _SVC_Y_FAR,  _LINE_WHITE, 1)
    line(5, _SVC_Y_NEAR,  5, _SVC_Y_FAR,  _LINE_WHITE, 1)

    # Glass side corners
    for x in (0.0, 10.0):
        line(x, 0,                   x, _GLASS_SIDE_Y,        _LINE_GLASS, 2)
        line(x, 20 - _GLASS_SIDE_Y,  x, 20,                   _LINE_GLASS, 2)
        _dashed_line(canvas,
                     px(x), py(_GLASS_SIDE_Y),
                     px(x), py(20 - _GLASS_SIDE_Y),
                     _LINE_FENCE, 1, dash_px=4)

    return canvas


# ── CSV loader ────────────────────────────────────────────────────────────────

def load_csv(path: str) -> dict[int, list[dict]]:
    by_frame: dict[int, list[dict]] = collections.defaultdict(list)
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            by_frame[int(row["frame_index"])].append(row)
    return by_frame


# ── Compositing helpers ───────────────────────────────────────────────────────

def _blend_rect(frame: np.ndarray, color_bgr: tuple,
                x: int, y: int, w: int, h: int, alpha: float) -> None:
    """Blend a solid colour rectangle into frame in-place."""
    roi = frame[y:y + h, x:x + w].astype(np.float32)
    bg  = np.full_like(roi, color_bgr, dtype=np.float32)
    frame[y:y + h, x:x + w] = np.clip(
        roi * (1.0 - alpha) + bg * alpha, 0, 255
    ).astype(np.uint8)


def _blend_canvas(frame: np.ndarray, canvas: np.ndarray,
                  x: int, y: int, alpha: float,
                  mask: np.ndarray | None = None) -> None:
    """Blend canvas pixels into frame; if mask given, only blend where mask is True."""
    h, w = canvas.shape[:2]
    roi  = frame[y:y + h, x:x + w].astype(np.float32)
    src  = canvas.astype(np.float32)
    blended = roi * (1.0 - alpha) + src * alpha
    if mask is not None:
        roi[mask] = blended[mask]
        frame[y:y + h, x:x + w] = np.clip(roi, 0, 255).astype(np.uint8)
    else:
        frame[y:y + h, x:x + w] = np.clip(blended, 0, 255).astype(np.uint8)


# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="Cenital court mini-map overlay for padel video."
    )
    p.add_argument("--video",      required=True,  help="Input video")
    p.add_argument("--csv",        required=True,  help="Players CSV")
    p.add_argument("--output",     required=True,  help="Output video")
    p.add_argument("--map-height", type=int,   default=300,
                   help="Mini-map height in pixels (default: 300)")
    p.add_argument("--bg-alpha",   type=float, default=0.45,
                   help="Background panel opacity 0–1 (default: 0.45)")
    p.add_argument("--alpha",      type=float, default=0.9,
                   help="Court lines + dots opacity 0–1 (default: 0.9)")
    p.add_argument("--margin",     type=int,   default=12,
                   help="Gap from video edge in pixels (default: 12)")
    p.add_argument("--trail",      type=int,   default=0,
                   help="Trail length in frames, 0 = off (default: 0)")
    p.add_argument("--lerp",       type=float, default=0.25,
                   help="EMA smoothing factor 0–1; lower = smoother (default: 0.25)")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    by_frame = load_csv(args.csv)
    if not by_frame:
        print("ERROR: CSV is empty", file=sys.stderr)
        return 1

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"ERROR: cannot open {args.video}", file=sys.stderr)
        return 1

    vid_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    vid_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps   = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    map_h = args.map_height
    map_w = map_h // 2
    pad   = max(6, map_h // 30)

    to_px, to_py = _build_transform(map_w, map_h, pad)
    court_lines   = build_court_lines(map_w, map_h, pad)
    court_mask    = court_lines.sum(axis=2) > 0   # True where lines are drawn

    x_off = vid_w - map_w - args.margin
    y_off = args.margin

    # EMA-smoothed world positions: {pid: [cx, cy] | None}
    smooth: dict[int, list[float] | None] = {pid: None for pid in (1, 2, 3, 4)}
    lerp_k = max(0.0, min(1.0, args.lerp))

    # Trail deques (smoothed positions): {pid: deque of (px, py)}
    trail_len = max(1, args.trail) if args.trail > 0 else 1
    trails: dict[int, collections.deque] = {
        pid: collections.deque(maxlen=trail_len) for pid in (1, 2, 3, 4)
    }

    use_ffmpeg = shutil.which("ffmpeg") is not None
    write_path = args.output
    if use_ffmpeg:
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".mp4")
        os.close(tmp_fd)
        write_path = tmp_path

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)

    out = cv2.VideoWriter(
        write_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (vid_w, vid_h)
    )
    if not out.isOpened():
        print(f"ERROR: cannot open output {write_path}", file=sys.stderr)
        cap.release()
        return 1

    print(f"Processing {total} frames  (lerp={lerp_k}, trail={args.trail})…")
    fi = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break

        rows = by_frame.get(fi, [])

        # ── EMA smoothing ────────────────────────────────────────────────────
        for row in rows:
            pid = int(row["player_id"])
            cx  = float(row["court_x_m"])
            cy  = float(row["court_y_m"])
            if smooth[pid] is None:
                smooth[pid] = [cx, cy]          # first detection: snap
            else:
                scx, scy = smooth[pid]
                smooth[pid] = [
                    lerp_k * cx + (1.0 - lerp_k) * scx,
                    lerp_k * cy + (1.0 - lerp_k) * scy,
                ]

        # Build per-player draw info (smoothed coords + status)
        draw_players: list[tuple[int, int, int, str]] = []   # (pid, px, py, status)
        for row in rows:
            pid    = int(row["player_id"])
            status = row.get("status", "detected")
            s = smooth[pid]
            if s is None:
                continue
            draw_players.append((pid, to_px(s[0]), to_py(s[1]), status))

        # ── Render mini-map ──────────────────────────────────────────────────

        # 1. Semi-transparent dark background panel
        _blend_rect(frame, _BG_COLOR, x_off, y_off, map_w, map_h, args.bg_alpha)

        # 2. Court lines (only non-black pixels from the pre-built canvas)
        _blend_canvas(frame, court_lines, x_off, y_off, args.alpha, mask=court_mask)

        # 3. Trails (drawn into a temp canvas, then blended)
        if args.trail > 0:
            trail_canvas = np.zeros((map_h, map_w, 3), dtype=np.uint8)
            for pid, px, py, _ in draw_players:
                trails[pid].appendleft((px, py))
            for pid, trail in trails.items():
                color = _PLAYER_COLORS.get(pid, _DEFAULT_COLOR)
                n = len(trail)
                for age, (tx, ty) in enumerate(trail):
                    fade = 1.0 - (age + 1) / (n + 1)
                    r    = max(2, int(_DOT_RADIUS * fade * 0.65))
                    dim  = tuple(int(c * fade * 0.55) for c in color)
                    cv2.circle(trail_canvas, (tx, ty), r, dim, -1, cv2.LINE_AA)
            trail_mask = trail_canvas.sum(axis=2) > 0
            _blend_canvas(frame, trail_canvas, x_off, y_off, args.alpha, mask=trail_mask)

        # 4. Player dots
        dot_canvas = np.zeros((map_h, map_w, 3), dtype=np.uint8)
        for pid, px, py, status in draw_players:
            color = _PLAYER_COLORS.get(pid, _DEFAULT_COLOR)
            if status == "detected":
                cv2.circle(dot_canvas, (px, py), _DOT_RADIUS, color, -1, cv2.LINE_AA)
                cv2.circle(dot_canvas, (px, py), _DOT_RADIUS, (255, 255, 255), 1, cv2.LINE_AA)
            else:
                cv2.circle(dot_canvas, (px, py), _DOT_RADIUS, color, 2, cv2.LINE_AA)
        dot_mask = dot_canvas.sum(axis=2) > 0
        _blend_canvas(frame, dot_canvas, x_off, y_off, args.alpha, mask=dot_mask)

        out.write(frame)
        fi += 1
        if fi % 500 == 0:
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
