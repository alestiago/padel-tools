#!/usr/bin/env python3
"""Overlay last-touch player indicators on a padel video.

For each frame the script:
  • Draws a thin coloured bbox around every tracked player.
  • Highlights the last-touching player with a thick bbox + label that fades
    over --hold-frames frames.
  • Flashes an expanding ring at the ball position at the moment of each touch.
  • Shows a corner HUD with the current last-toucher and confidence.

Usage:
    python3 tools/overlay_touch.py \
        --video       .dev/jugada1/jugada1.mp4 \
        --touches     .dev/jugada1/last_touch.csv \
        --players     .dev/jugada1/players.csv \
        --ball-labels .dev/jugada1/jugada1_labels.csv \
        --output      .dev/jugada1/jugada1_touch.mp4
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

# BGR colours per player id
PLAYER_COLORS: dict[int, tuple[int, int, int]] = {
    1: (50,  220,  50),   # green
    2: (0,   230, 255),   # yellow
    3: (0,   100, 255),   # orange
    4: (220,  50, 220),   # magenta
}
DEFAULT_COLOR = (180, 180, 180)

HOLD_FRAMES_DEFAULT = 90       # frames a highlight stays visible
FLASH_FRAMES = 25              # frames the touch-ring animation plays


# ---------------------------------------------------------------------------
# Loaders (self-contained — no padel_engine import needed)
# ---------------------------------------------------------------------------

def load_touches(path: str) -> list[dict]:
    rows = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            rows.append({
                "frame": int(row["touch_frame"]),
                "time_s": float(row["touch_time_s"]),
                "player_id": int(row["player_id"]),
                "side": row["side"],
                "confidence": float(row["confidence"]),
            })
    return sorted(rows, key=lambda r: r["frame"])


def load_players(path: str) -> dict[int, list[dict]]:
    result: dict[int, list[dict]] = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            frame = int(row["frame_index"])
            result.setdefault(frame, []).append({
                "player_id": int(row["player_id"]),
                "side": row["side"],
                "confidence": float(row["confidence"]),
                "status": row["status"],
                "bbox": (
                    float(row["bbox_x1"]), float(row["bbox_y1"]),
                    float(row["bbox_x2"]), float(row["bbox_y2"]),
                ),
            })
    return result


def load_ball_labels(path: str) -> dict[int, tuple[float, float]]:
    result: dict[int, tuple[float, float]] = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            if row.get("visibility") == "visible" and row["x"]:
                result[int(row["frame"])] = (float(row["x"]), float(row["y"]))
    return result


# ---------------------------------------------------------------------------
# Drawing helpers
# ---------------------------------------------------------------------------

def color_with_alpha(
    frame: np.ndarray,
    draw_fn,          # callable(overlay) -> None
    alpha: float,
) -> None:
    """Draw on a zero overlay then alpha-blend into frame in-place."""
    overlay = np.zeros_like(frame, dtype=np.uint8)
    draw_fn(overlay)
    mask = cv2.cvtColor(overlay, cv2.COLOR_BGR2GRAY)
    a = (mask.astype(np.float32) / 255.0 * alpha)[..., np.newaxis]
    blended = frame.astype(np.float32) * (1.0 - a) + overlay.astype(np.float32) * a
    np.copyto(frame, np.clip(blended, 0, 255).astype(np.uint8))


def draw_player_bbox(
    frame: np.ndarray,
    bbox: tuple[float, float, float, float],
    color: tuple[int, int, int],
    thickness: int,
    label: str,
    alpha: float = 1.0,
) -> None:
    x1, y1, x2, y2 = (int(round(v)) for v in bbox)

    def _draw(overlay: np.ndarray) -> None:
        cv2.rectangle(overlay, (x1, y1), (x2, y2), color, thickness, cv2.LINE_AA)
        # label background
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 1)
        lx, ly = x1, y1 - 4
        cv2.rectangle(overlay, (lx, ly - th - 4), (lx + tw + 6, ly + 2), color, -1)
        cv2.putText(overlay, label, (lx + 3, ly - 1),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1, cv2.LINE_AA)

    color_with_alpha(frame, _draw, alpha)


def draw_touch_flash(
    frame: np.ndarray,
    px: float,
    py: float,
    color: tuple[int, int, int],
    age_frames: int,
) -> None:
    """Expanding ring that fades over FLASH_FRAMES frames."""
    t = age_frames / FLASH_FRAMES          # 0 → fresh, 1 → expired
    alpha = max(0.0, 1.0 - t)
    radius = int(12 + t * 55)             # grows from 12 to 67 px
    thickness = max(1, int(4 * (1 - t)))

    def _draw(overlay: np.ndarray) -> None:
        cx, cy = int(round(px)), int(round(py))
        cv2.circle(overlay, (cx, cy), radius, color, thickness, cv2.LINE_AA)
        # small bright dot at centre on first few frames
        if age_frames < 8:
            cv2.circle(overlay, (cx, cy), 5, color, -1, cv2.LINE_AA)

    color_with_alpha(frame, _draw, alpha * 0.9)


def draw_hud(
    frame: np.ndarray,
    player_id: int | None,
    time_since_touch_s: float | None,
    confidence: float | None,
) -> None:
    h, w = frame.shape[:2]
    pad = 14

    if player_id is None:
        lines = ["Last touch: --"]
        color = (160, 160, 160)
    else:
        color = PLAYER_COLORS.get(player_id, DEFAULT_COLOR)
        elapsed = f"{time_since_touch_s:.1f}s ago" if time_since_touch_s is not None else ""
        conf_str = f"  conf {confidence:.2f}" if confidence is not None else ""
        lines = [
            f"Last touch: P{player_id}",
            elapsed + conf_str,
        ]

    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = 0.6
    font_thickness = 1
    line_height = 22
    box_w = 210
    box_h = pad * 2 + line_height * len(lines)
    bx, by = 16, h - box_h - 16

    overlay = np.zeros_like(frame, dtype=np.uint8)
    cv2.rectangle(overlay, (bx, by), (bx + box_w, by + box_h), (30, 30, 30), -1)
    cv2.rectangle(overlay, (bx, by), (bx + box_w, by + box_h), color, 2, cv2.LINE_AA)
    for i, line in enumerate(lines):
        tx = bx + pad
        ty = by + pad + (i + 1) * line_height - 4
        cv2.putText(overlay, line, (tx, ty), font, font_scale, color, font_thickness, cv2.LINE_AA)

    # fixed 80 % blend for the HUD box
    roi = frame[by: by + box_h, bx: bx + box_w]
    ov_roi = overlay[by: by + box_h, bx: bx + box_w]
    blended = (roi.astype(np.float32) * 0.35 + ov_roi.astype(np.float32) * 0.65)
    frame[by: by + box_h, bx: bx + box_w] = np.clip(blended, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Overlay last-touch indicators on a padel video.")
    parser.add_argument("--video", required=True)
    parser.add_argument("--touches", required=True, help="last_touch.csv from detect_last_touch")
    parser.add_argument("--players", required=True, help="players.csv with per-frame bboxes")
    parser.add_argument("--ball-labels", required=True, help="ball labels CSV for touch-flash position")
    parser.add_argument("--output", default="output_touch.mp4")
    parser.add_argument("--hold-frames", type=int, default=HOLD_FRAMES_DEFAULT,
                        help=f"Frames the last-touch highlight stays visible (default {HOLD_FRAMES_DEFAULT})")
    args = parser.parse_args()

    touches = load_touches(args.touches)
    players = load_players(args.players)
    ball_pos = load_ball_labels(args.ball_labels)
    print(f"Loaded {len(touches)} touch events, {len(players)} player frames, {len(ball_pos)} visible ball positions")

    # Build index: frame → last active touch at-or-before that frame
    touch_by_frame: dict[int, dict] = {}
    for t in touches:
        touch_by_frame[t["frame"]] = t

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit(f"Error: could not open {args.video}")

    fps = cap.get(cv2.CAP_PROP_FPS)
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

    # Sort touch frames for binary search
    touch_frames_sorted = sorted(touch_by_frame.keys())

    current_touch: dict | None = None   # last known touch

    print("Rendering...")
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # Advance current_touch to the most recent event at/before this frame
        for tf in touch_frames_sorted:
            if tf <= frame_idx:
                current_touch = touch_by_frame[tf]
            else:
                break

        player_list = players.get(frame_idx, [])

        # --- 1. Thin bbox for every detected player ---
        for p in player_list:
            pid = p["player_id"]
            color = PLAYER_COLORS.get(pid, DEFAULT_COLOR)
            draw_player_bbox(frame, p["bbox"], color, thickness=1,
                             label=f"P{pid}", alpha=0.7)

        # --- 2. Highlight + fade for last-touching player ---
        if current_touch is not None:
            pid = current_touch["player_id"]
            touch_frame = current_touch["frame"]
            age = frame_idx - touch_frame
            color = PLAYER_COLORS.get(pid, DEFAULT_COLOR)

            if age <= args.hold_frames:
                fade = max(0.05, 1.0 - age / args.hold_frames)
                matching = [p for p in player_list if p["player_id"] == pid]
                for p in matching:
                    draw_player_bbox(
                        frame, p["bbox"], color,
                        thickness=max(1, int(4 * fade)),
                        label=f"P{pid} ✓ TOUCH",
                        alpha=min(1.0, fade + 0.15),
                    )

            # --- 3. Expanding ring flash at ball position ---
            if age < FLASH_FRAMES:
                ball_px = ball_pos.get(touch_frame)
                if ball_px:
                    draw_touch_flash(frame, ball_px[0], ball_px[1], color, age_frames=age)

        # --- 4. HUD ---
        if current_touch is not None:
            age_s = (frame_idx - current_touch["frame"]) / fps
            draw_hud(frame, current_touch["player_id"], age_s, current_touch["confidence"])
        else:
            draw_hud(frame, None, None, None)

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
