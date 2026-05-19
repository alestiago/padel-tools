#!/usr/bin/env python3
"""Overlay ball impact markers on a padel video.

Each detected impact surface gets a distinct animated marker at the ball's pixel
position.  Markers fade over --hold-frames frames.  A corner HUD shows a running
tally of impacts by surface type.

Usage:
    python3 tools/impact_overlay.py \
        --video    .dev/jugada1/jugada1.mp4 \
        --impacts  .dev/jugada1/impacts.csv \
        --output   .dev/jugada1/jugada1_impacts.mp4
"""
from __future__ import annotations

import argparse
import csv
import math
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np

HOLD_FRAMES_DEFAULT = 40

# BGRcolours per surface
SURFACE_COLORS: dict[str, tuple[int, int, int]] = {
    "floor":   (0,   200, 255),   # orange-yellow
    "racket":  (50,  230,  50),   # green  (overridden per player below)
    "wall":    (255, 220,  50),   # cyan
    "fence":   (50,   50, 255),   # red
    "net":     (200, 200, 200),   # grey
    "unknown": (100, 100, 100),   # dark grey
}

PLAYER_COLORS: dict[int, tuple[int, int, int]] = {
    1: (50,  220,  50),
    2: (0,   230, 255),
    3: (0,   100, 255),
    4: (220,  50, 220),
}

SURFACE_ORDER = ["floor", "racket", "wall", "fence", "net", "unknown"]


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------

def load_impacts(path: str) -> list[dict]:
    rows = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            rows.append({
                "frame": int(row["frame"]),
                "time_s": float(row["time_s"]),
                "pixel_x": float(row["pixel_x"]),
                "pixel_y": float(row["pixel_y"]),
                "surface": row["surface"],
                "direction_change_deg": float(row["direction_change_deg"]),
                "confidence": float(row["confidence"]),
                "nearest_player_id": int(row["nearest_player_id"]) if row["nearest_player_id"] else None,
            })
    return sorted(rows, key=lambda r: r["frame"])


# ---------------------------------------------------------------------------
# Drawing helpers
# ---------------------------------------------------------------------------

def _blend(frame: np.ndarray, draw_fn, alpha: float) -> None:
    """Draw on a blank overlay then alpha-blend it over frame in-place."""
    overlay = np.zeros_like(frame, dtype=np.uint8)
    draw_fn(overlay)
    gray = cv2.cvtColor(overlay, cv2.COLOR_BGR2GRAY)
    a = (gray.astype(np.float32) / 255.0 * alpha)[..., np.newaxis]
    blended = frame.astype(np.float32) * (1.0 - a) + overlay.astype(np.float32) * a
    np.copyto(frame, np.clip(blended, 0, 255).astype(np.uint8))


def _draw_floor(overlay: np.ndarray, cx: int, cy: int, t: float, color) -> None:
    """Expanding ripple rings — t in [0,1] is age (0=fresh, 1=expired)."""
    base_r = 14
    for ring_i, (r_grow, thick) in enumerate([(0, 3), (20, 2), (38, 1)]):
        r = base_r + int(r_grow * (1 - t)) + int(22 * t)
        if r < 1:
            continue
        alpha_ring = max(0.0, 1.0 - t - ring_i * 0.15)
        if alpha_ring <= 0:
            continue
        c = tuple(int(v * alpha_ring) for v in color)
        cv2.circle(overlay, (cx, cy), r, c, thick, cv2.LINE_AA)
    # centre dot fades quickly
    if t < 0.4:
        cv2.circle(overlay, (cx, cy), 4, color, -1, cv2.LINE_AA)


def _draw_racket(overlay: np.ndarray, cx: int, cy: int, t: float, color) -> None:
    """Six-pointed star burst, rotates slightly with age."""
    length = int(28 * (1.0 - t * 0.4))
    if length < 4:
        return
    angle_offset = t * 30.0   # degrees of rotation as it ages
    for i in range(6):
        deg = angle_offset + i * 60.0
        rad = math.radians(deg)
        ex = cx + int(length * math.cos(rad))
        ey = cy + int(length * math.sin(rad))
        thick = max(1, int(3 * (1.0 - t)))
        cv2.line(overlay, (cx, cy), (ex, ey), color, thick, cv2.LINE_AA)
    cv2.circle(overlay, (cx, cy), 5, color, -1, cv2.LINE_AA)


def _draw_wall(overlay: np.ndarray, cx: int, cy: int, t: float, color) -> None:
    """Corner brackets (L-shapes) expanding outward."""
    size = int(18 + 10 * t)
    arm = max(3, size // 2)
    thick = max(1, int(3 * (1.0 - t)))
    for sx, sy in [(-1, -1), (1, -1), (1, 1), (-1, 1)]:
        ox, oy = cx + sx * size // 2, cy + sy * size // 2
        cv2.line(overlay, (ox, oy), (ox + sx * arm, oy), color, thick, cv2.LINE_AA)
        cv2.line(overlay, (ox, oy), (ox, oy + sy * arm), color, thick, cv2.LINE_AA)


def _draw_fence(overlay: np.ndarray, cx: int, cy: int, t: float, color) -> None:
    """Diamond outline, contracts then fades."""
    r = int(22 * (1.0 - t * 0.3))
    if r < 3:
        return
    pts = np.array([[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]], np.int32)
    thick = max(1, int(3 * (1.0 - t)))
    cv2.polylines(overlay, [pts], True, color, thick, cv2.LINE_AA)
    if t < 0.25:
        cv2.circle(overlay, (cx, cy), 4, color, -1, cv2.LINE_AA)


def _draw_net(overlay: np.ndarray, cx: int, cy: int, t: float, color) -> None:
    """Horizontal bar with an X through the centre."""
    hw = int(22 * (1.0 - t * 0.3))
    hh = int(10 * (1.0 - t * 0.3))
    thick = max(1, int(2 * (1.0 - t)))
    cv2.line(overlay, (cx - hw, cy), (cx + hw, cy), color, thick + 1, cv2.LINE_AA)
    cv2.line(overlay, (cx - hh, cy - hh), (cx + hh, cy + hh), color, thick, cv2.LINE_AA)
    cv2.line(overlay, (cx + hh, cy - hh), (cx - hh, cy + hh), color, thick, cv2.LINE_AA)


def _draw_unknown(overlay: np.ndarray, cx: int, cy: int, t: float, color) -> None:
    r = int(8 * (1.0 - t * 0.5))
    cv2.circle(overlay, (cx, cy), max(2, r), color, 1, cv2.LINE_AA)
    cv2.line(overlay, (cx - r, cy), (cx + r, cy), color, 1, cv2.LINE_AA)
    cv2.line(overlay, (cx, cy - r), (cx, cy + r), color, 1, cv2.LINE_AA)


_DRAW_FN = {
    "floor":   _draw_floor,
    "racket":  _draw_racket,
    "wall":    _draw_wall,
    "fence":   _draw_fence,
    "net":     _draw_net,
    "unknown": _draw_unknown,
}


def draw_impact_marker(
    frame: np.ndarray,
    impact: dict,
    age_frames: int,
    hold_frames: int,
) -> None:
    t = age_frames / max(hold_frames, 1)
    if t >= 1.0:
        return
    alpha = (1.0 - t) ** 0.7       # eased fade

    surface = impact["surface"]
    color = (
        PLAYER_COLORS.get(impact["nearest_player_id"], SURFACE_COLORS["racket"])
        if surface == "racket" and impact["nearest_player_id"]
        else SURFACE_COLORS.get(surface, SURFACE_COLORS["unknown"])
    )

    cx = int(round(impact["pixel_x"]))
    cy = int(round(impact["pixel_y"]))
    draw_fn = _DRAW_FN.get(surface, _draw_unknown)

    def _draw(overlay: np.ndarray) -> None:
        draw_fn(overlay, cx, cy, t, color)

    _blend(frame, _draw, alpha)

    # small floating label (surface name + confidence)
    if age_frames < 20:
        label_alpha = 1.0 - age_frames / 20.0
        label = f"{surface} {impact['confidence']:.2f}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.42, 1)
        lx = max(0, cx - tw // 2)
        ly = max(th + 4, cy - 26)

        def _label(overlay: np.ndarray) -> None:
            cv2.rectangle(overlay, (lx - 2, ly - th - 2), (lx + tw + 2, ly + 2),
                          (30, 30, 30), -1)
            cv2.putText(overlay, label, (lx, ly),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.42, color, 1, cv2.LINE_AA)

        _blend(frame, _label, label_alpha * 0.9)


def draw_hud(frame: np.ndarray, counts: dict[str, int]) -> None:
    """Top-right corner: running impact tally by surface."""
    h, w = frame.shape[:2]
    font = cv2.FONT_HERSHEY_SIMPLEX
    fscale, fthick = 0.50, 1
    line_h = 20
    pad = 10
    box_w = 150
    lines = [("IMPACTS", (220, 220, 220))]
    for surf in SURFACE_ORDER:
        n = counts.get(surf, 0)
        if n > 0:
            lines.append((f"  {surf}: {n}", SURFACE_COLORS[surf]))

    box_h = pad * 2 + line_h * len(lines)
    bx = w - box_w - 14
    by = 14

    overlay = np.zeros_like(frame, dtype=np.uint8)
    cv2.rectangle(overlay, (bx, by), (bx + box_w, by + box_h), (30, 30, 30), -1)

    for i, (text, color) in enumerate(lines):
        tx = bx + pad
        ty = by + pad + (i + 1) * line_h - 3
        cv2.putText(overlay, text, (tx, ty), font, fscale, color, fthick, cv2.LINE_AA)

    roi = frame[by: by + box_h, bx: bx + box_w]
    ov_roi = overlay[by: by + box_h, bx: bx + box_w]
    blended = roi.astype(np.float32) * 0.3 + ov_roi.astype(np.float32) * 0.7
    frame[by: by + box_h, bx: bx + box_w] = np.clip(blended, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Overlay ball impact markers on a padel video.")
    parser.add_argument("--video", required=True)
    parser.add_argument("--impacts", required=True, help="impacts.csv from detect_impacts")
    parser.add_argument("--output", default="output_impacts.mp4")
    parser.add_argument("--hold-frames", type=int, default=HOLD_FRAMES_DEFAULT,
                        help=f"Frames each marker stays visible (default {HOLD_FRAMES_DEFAULT})")
    args = parser.parse_args()

    impacts = load_impacts(args.impacts)
    print(f"Loaded {len(impacts)} impact events")

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit(f"Error: could not open {args.video}")

    fps    = cap.get(cv2.CAP_PROP_FPS)
    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f"Video: {width}×{height} @ {fps:.2f} fps — {total} frames")

    use_ffmpeg = shutil.which("ffmpeg") is not None
    if use_ffmpeg:
        fd, tmp_path = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)
        write_path = tmp_path
    else:
        write_path = args.output

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(write_path, fourcc, fps, (width, height))

    # index impacts by frame for O(1) lookup
    impact_by_frame: dict[int, dict] = {imp["frame"]: imp for imp in impacts}
    active: list[dict] = []   # (impact, start_frame) tuples kept as active markers
    seen_counts: dict[str, int] = {}

    print("Rendering...")
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # Activate new impact at this frame
        if frame_idx in impact_by_frame:
            imp = impact_by_frame[frame_idx]
            active.append({"impact": imp, "start": frame_idx})
            seen_counts[imp["surface"]] = seen_counts.get(imp["surface"], 0) + 1

        # Draw all active markers
        still_active = []
        for entry in active:
            age = frame_idx - entry["start"]
            if age < args.hold_frames:
                draw_impact_marker(frame, entry["impact"], age, args.hold_frames)
                still_active.append(entry)
        active = still_active

        # HUD
        draw_hud(frame, seen_counts)

        out.write(frame)
        frame_idx += 1
        if frame_idx % 300 == 0:
            print(f"  {frame_idx}/{total} ({100 * frame_idx // total}%)")

    cap.release()
    out.release()

    if use_ffmpeg:
        print("Re-encoding to H.264...")
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_path,
             "-c:v", "libx264", "-preset", "fast", "-crf", "18",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart",
             args.output],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        os.unlink(tmp_path)

    print(f"\nDone → {args.output}")


if __name__ == "__main__":
    main()
