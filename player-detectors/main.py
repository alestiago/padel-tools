#!/usr/bin/env python3
"""Detect player positions in a padel video and write a CSV.

Usage:
    python player_main.py video.mp4 \\
        --homography homography_video.json \\
        --model yolo11n.pt \\
        --output players.csv
"""
import argparse
import csv
import logging
import os
import sys

import cv2
from tqdm import tqdm

import homography as hg
from detector.player_yolo import PlayerYoloDetector
from detector.player_yolo_v2 import PlayerYoloDetectorV2

log = logging.getLogger(__name__)

_CSV_FIELDS = [
    "frame_index", "time_s",
    "player_id", "pixel_u", "pixel_v",
    "court_x_m", "court_y_m", "side", "confidence",
    "bbox_x1", "bbox_y1", "bbox_x2", "bbox_y2",
    "status",
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Detect padel player positions from video.")
    p.add_argument("video", help="Path to input video file")
    p.add_argument("--homography", required=True, metavar="PATH",
                   help="Path to homography_video.json")
    p.add_argument("--detector", choices=["v1", "v2"], default="v2",
                   help="Detector version (default: v2)")
    p.add_argument("--model", default="yolo11n.pt", metavar="PATH",
                   help="YOLO model file (.pt or .onnx); downloaded automatically if not found (default: yolo11n.pt)")
    p.add_argument("--threshold", type=float, default=0.4,
                   help="Confidence threshold (default: 0.4)")
    p.add_argument("--fps", type=float, default=None,
                   help="Override frame rate (default: read from video)")
    p.add_argument("--frame-step", type=int, default=1, metavar="N",
                   help="Analyse every N frames (default: 1)")
    p.add_argument("--output", metavar="PATH", default=None,
                   help="Output CSV path (default: <video_stem>_players.csv)")
    p.add_argument("-v", "--verbose", action="store_true",
                   help="Enable DEBUG-level logging")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)-8s %(message)s",
    )

    try:
        hom = hg.load(args.homography)
    except (FileNotFoundError, KeyError, ValueError) as e:
        log.error("Failed to load homography: %s", e)
        return 1

    H = hom["H"]
    fs = hom["frame_size"]
    log.info("Loaded homography: frame_size=%d×%d", fs["width"], fs["height"])

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        log.error("Cannot open video: %s", args.video)
        return 1

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    native_fps = cap.get(cv2.CAP_PROP_FPS)
    fps = args.fps or native_fps
    frame_step = args.frame_step
    analyse_count = max(1, total_frames // frame_step)

    log.info("Video: %d frames @ %.1f fps → %d to analyse (step=%d)",
             total_frames, fps, analyse_count, frame_step)
    log.info("Detector: %s  model: %s  threshold=%.2f", args.detector, args.model, args.threshold)

    if args.detector == "v2":
        detector = PlayerYoloDetectorV2(model_path=args.model, threshold=args.threshold, H=H)
    else:
        detector = PlayerYoloDetector(model_path=args.model, threshold=args.threshold, H=H)

    out_path = args.output or (
        os.path.splitext(os.path.basename(args.video))[0] + "_players.csv"
    )

    rows: list[dict] = []
    frame_idx = 0
    total_detections = 0

    with tqdm(total=analyse_count, unit="frame", disable=args.verbose) as bar:
        while True:
            ok, frame = cap.read()
            if not ok:
                break

            if frame_idx % frame_step != 0:
                frame_idx += 1
                continue

            time_s = frame_idx / fps

            # Scale frame to homography calibration resolution if needed
            orig_h, orig_w = frame.shape[:2]
            cal_w, cal_h = fs["width"], fs["height"]
            if orig_w != cal_w or orig_h != cal_h:
                frame = cv2.resize(frame, (cal_w, cal_h), interpolation=cv2.INTER_LINEAR)

            players = detector.detect(frame)
            for p in players:
                rows.append({
                    "frame_index": frame_idx,
                    "time_s": f"{time_s:.4f}",
                    "player_id": p.player_id,
                    "pixel_u": f"{p.pixel_u:.1f}",
                    "pixel_v": f"{p.pixel_v:.1f}",
                    "court_x_m": f"{p.court_x_m:.3f}",
                    "court_y_m": f"{p.court_y_m:.3f}",
                    "side": p.side,
                    "confidence": f"{p.confidence:.3f}",
                    "bbox_x1": f"{p.bbox_x1:.1f}",
                    "bbox_y1": f"{p.bbox_y1:.1f}",
                    "bbox_x2": f"{p.bbox_x2:.1f}",
                    "bbox_y2": f"{p.bbox_y2:.1f}",
                    "status": p.status,
                })
            total_detections += len(players)

            bar.update(1)
            frame_idx += 1

    cap.release()

    if not rows:
        log.warning("No player detections in any frame.")
    else:
        log.info("Total player detections: %d across %d analysed frames",
                 total_detections, analyse_count)

    with open(out_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=_CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)

    log.info("Output written: %s (%d rows)", out_path, len(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
