#!/usr/bin/env python3
"""Overlay player bounding boxes on a padel video.

Usage:
    python3 tools/overlay_players.py \\
        --video .dev/padel_short_3min.mp4 \\
        --csv .dev/ball-veloity-tool-py/players.csv \\
        --output out_players.mp4
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

# Per-player-ID colours (BGR): near-left, near-right, far-left, far-right
_COLORS = {
    1: (50,  220,  50),   # green   — near, left
    2: (50,  220, 220),   # yellow  — near, right
    3: (50,   80, 220),   # orange  — far,  left
    4: (200,  50, 220),   # magenta — far,  right
}
_DEFAULT_COLOR = (200, 200, 200)
_FONT = cv2.FONT_HERSHEY_SIMPLEX


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Overlay player bounding boxes on video.")
    p.add_argument("--video", required=True, help="Input video file")
    p.add_argument("--csv",   required=True, help="Player CSV from player_main.py")
    p.add_argument("--output", required=True, help="Output video file")
    return p.parse_args()


def load_csv(path: str) -> dict[int, list[dict]]:
    """Return {frame_index: [row, ...]}."""
    by_frame: dict[int, list[dict]] = collections.defaultdict(list)
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            by_frame[int(row["frame_index"])].append(row)
    return by_frame


_STATUS_SUFFIX = {"extrapolated": "~", "occluded": "?"}
_OCCLUDED_COLOR = (160, 160, 160)


def _dashed_rect(frame, pt1, pt2, color, thickness=1, dash_len=12):
    """Draw a dashed rectangle."""
    x1, y1 = pt1
    x2, y2 = pt2
    for sx, sy, ex, ey in [(x1,y1,x2,y1),(x2,y1,x2,y2),(x2,y2,x1,y2),(x1,y2,x1,y1)]:
        length = math.hypot(ex - sx, ey - sy)
        if length < 1:
            continue
        n = max(1, int(length / dash_len))
        for i in range(0, n, 2):
            t1, t2 = i / n, min((i + 1) / n, 1.0)
            p1 = (int(sx + t1 * (ex - sx)), int(sy + t1 * (ey - sy)))
            p2 = (int(sx + t2 * (ex - sx)), int(sy + t2 * (ey - sy)))
            cv2.line(frame, p1, p2, color, thickness)


def draw_player(frame, row: dict) -> None:
    pid    = int(row["player_id"])
    status = row.get("status", "detected")

    if status == "detected":
        color = _COLORS.get(pid, _DEFAULT_COLOR)
        x1 = int(float(row["bbox_x1"]))
        y1 = int(float(row["bbox_y1"]))
        x2 = int(float(row["bbox_x2"]))
        y2 = int(float(row["bbox_y2"]))
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
    elif status in ("extrapolated", "occluded"):
        color = _COLORS.get(pid, _DEFAULT_COLOR) if status == "extrapolated" else _OCCLUDED_COLOR
        x1 = int(float(row["bbox_x1"]))
        y1 = int(float(row["bbox_y1"]))
        x2 = int(float(row["bbox_x2"]))
        y2 = int(float(row["bbox_y2"]))
        _dashed_rect(frame, (x1, y1), (x2, y2), color, thickness=2)
    else:
        return  # lost or unknown — nothing to draw

    cx_m   = float(row["court_x_m"])
    cy_m   = float(row["court_y_m"])
    side   = row["side"]
    suffix = _STATUS_SUFFIX.get(status, "")
    label  = f"P{pid}{suffix} {side[0].upper()} ({cx_m:.1f},{cy_m:.1f})"

    (tw, th), baseline = cv2.getTextSize(label, _FONT, 0.55, 1)
    ty = max(y1 - 6, th + 4)
    cv2.rectangle(frame, (x1, ty - th - 3), (x1 + tw + 4, ty + baseline), color, -1)
    cv2.putText(frame, label, (x1 + 2, ty), _FONT, 0.55, (0, 0, 0), 1, cv2.LINE_AA)


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

    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps    = cap.get(cv2.CAP_PROP_FPS)
    total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    use_ffmpeg = shutil.which("ffmpeg") is not None
    if use_ffmpeg:
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".mp4")
        os.close(tmp_fd)
        write_path = tmp_path
    else:
        write_path = args.output

    out = cv2.VideoWriter(
        write_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height)
    )
    if not out.isOpened():
        print(f"ERROR: cannot open output {write_path}", file=sys.stderr)
        cap.release()
        return 1

    print(f"Processing {total} frames…")
    fi = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break

        for row in by_frame.get(fi, []):
            # CSV bbox coords are in calibration resolution; scale if the video
            # frame has a different resolution.
            draw_player(frame, row)

        out.write(frame)
        fi += 1
        if fi % 500 == 0:
            print(f"  {fi}/{total} ({100 * fi // total}%)")

    cap.release()
    out.release()

    if use_ffmpeg:
        print("Re-encoding to H.264…")
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", tmp_path,
                "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                args.output,
            ],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        os.unlink(tmp_path)

    print(f"Done → {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
