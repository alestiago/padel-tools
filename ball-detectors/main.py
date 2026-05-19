#!/usr/bin/env python3
import argparse
import logging
import os
import sys

import cv2
import numpy as np
from tqdm import tqdm

import homography as hg
import output
import velocity
import detector as det_module

log = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Detect padel ball position and compute velocity from video."
    )
    p.add_argument("video", help="Path to input video file")
    p.add_argument(
        "--homography", required=True, metavar="PATH",
        help="Path to homography_video.json (from homography-tool)",
    )
    p.add_argument(
        "--detector", choices=["blob", "blob_v2", "blob_v3", "blob_v4", "yolo", "tracknet", "tracknet_v2"], default="blob",
        help="Ball detection backend (default: blob)",
    )
    p.add_argument(
        "--model", metavar="PATH",
        help="Path to ONNX model weights (required for yolo and tracknet)",
    )
    p.add_argument(
        "--fps", type=float, default=None,
        help="Override video frame rate (default: read from video metadata)",
    )
    p.add_argument(
        "--frame-step", type=int, default=2, metavar="N",
        help="Analyse every N frames (default: 2)",
    )
    p.add_argument(
        "--threshold", type=float, default=0.5,
        help="Detection confidence threshold for yolo/tracknet (default: 0.5)",
    )
    p.add_argument(
        "--output", metavar="PATH", default=None,
        help="Output file path (default: <video_stem>_velocity.csv)",
    )
    p.add_argument(
        "--format", choices=["csv", "json"], default="csv", dest="fmt",
        help="Output format (default: csv)",
    )
    p.add_argument(
        "--debug-dir", metavar="PATH", default=None,
        help="Write annotated JPEG frames to this directory for inspection",
    )
    p.add_argument(
        "-v", "--verbose", action="store_true",
        help="Enable DEBUG-level logging",
    )
    return p.parse_args()


def default_output_path(video_path: str, fmt: str) -> str:
    stem = os.path.splitext(os.path.basename(video_path))[0]
    return f"{stem}_velocity.{fmt}"


def write_debug_frame(
    frame_bgr: np.ndarray,
    result: dict,
    debug_dir: str,
) -> None:
    annotated = frame_bgr.copy()
    ball = result.get("ball")
    if ball:
        u, v = int(ball["pixel_u"]), int(ball["pixel_v"])
        cv2.circle(annotated, (u, v), 8, (0, 255, 0), 2)
        vel = result.get("velocity_kmh")
        label = f"t={result['time_s']:.2f}s"
        if vel is not None:
            label += f"  {vel:.1f} km/h"
    else:
        label = f"t={result['time_s']:.2f}s  no detection"

    cv2.putText(
        annotated, label, (10, 28),
        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA,
    )
    path = os.path.join(debug_dir, f"frame_{result['frame_index']:06d}.jpg")
    cv2.imwrite(path, annotated, [cv2.IMWRITE_JPEG_QUALITY, 85])


def main() -> int:
    args = parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)-8s %(message)s",
    )

    # Load homography
    try:
        hom = hg.load(args.homography)
    except (FileNotFoundError, KeyError, ValueError) as e:
        log.error("Failed to load homography: %s", e)
        return 1

    H = hom["H"]
    fs = hom["frame_size"]
    reproj = hom.get("reprojection_error_m")
    reproj_str = f"{reproj:.3f} m" if reproj is not None else "n/a"
    log.info(
        "Loaded homography: %s | frame_size=%d×%d | reproj_err=%s",
        hom.get("video_file", args.homography),
        fs["width"], fs["height"],
        reproj_str,
    )

    # Open video
    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        log.error("Cannot open video: %s", args.video)
        return 1

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    native_fps = cap.get(cv2.CAP_PROP_FPS)
    fps = args.fps if args.fps else native_fps
    frame_step = args.frame_step
    analyse_count = max(1, total_frames // frame_step)
    dt = frame_step / fps

    log.info(
        "Video: %d frames @ %.1f fps → %d frames to analyse (step=%d)",
        total_frames, fps, analyse_count, frame_step,
    )
    log.info("Detector: %s", args.detector)

    # Build detector — blob_v2/v3/v4 need the inverse homography for the court polygon
    H_inv = np.linalg.inv(H) if args.detector in det_module._NEEDS_H_INV else None
    try:
        detector = det_module.build(args.detector, args.model, args.threshold, H_inv=H_inv)
    except ValueError as e:
        log.error("%s", e)
        return 1

    has_velocity_gate = hasattr(detector, "velocity_gate")

    # Create debug dir if requested
    if args.debug_dir:
        os.makedirs(args.debug_dir, exist_ok=True)

    # Main processing loop
    results: list[dict] = []
    frame_idx = 0
    analysed = 0

    with tqdm(total=analyse_count, unit="frame", disable=args.verbose) as bar:
        while True:
            ok, frame = cap.read()
            if not ok:
                break

            if frame_idx % frame_step != 0:
                frame_idx += 1
                continue

            time_s = frame_idx / fps

            # Scale frame to match the resolution the homography was calibrated on
            orig_h, orig_w = frame.shape[:2]
            cal_w, cal_h = fs["width"], fs["height"]
            if orig_w != cal_w or orig_h != cal_h:
                frame = cv2.resize(frame, (cal_w, cal_h), interpolation=cv2.INTER_LINEAR)

            detection = detector.detect(frame)

            ball = None
            if detection is not None:
                u, v = detection
                x, y = hg.apply_H(H, u, v)
                if not hg.in_court(x, y):
                    log.debug(
                        "frame=%d t=%.3fs detection out of court (x=%.2f, y=%.2f) — discarded",
                        frame_idx, time_s, x, y,
                    )
                elif has_velocity_gate and not detector.velocity_gate(x, y, time_s):
                    pass  # logged inside velocity_gate
                else:
                    ball = {"pixel_u": u, "pixel_v": v, "court_x_m": x, "court_y_m": y}
                    if has_velocity_gate:
                        detector.confirm(x, y, time_s)

            result: dict = {
                "frame_index": frame_idx,
                "time_s": time_s,
                "ball": ball,
                "raw_velocity_kmh": None,
                "velocity_kmh": None,
            }
            results.append(result)

            if ball:
                log.debug(
                    "frame=%d t=%.3fs %s=(u=%.1f, v=%.1f) → court=(%.2f, %.2f)",
                    frame_idx, time_s, args.detector,
                    ball["pixel_u"], ball["pixel_v"],
                    ball["court_x_m"], ball["court_y_m"],
                )
            else:
                log.debug("frame=%d t=%.3fs no detection", frame_idx, time_s)

            analysed += 1
            bar.update(1)
            frame_idx += 1

    cap.release()

    if not results:
        log.error("No frames were processed.")
        return 1

    # Compute velocities
    results = velocity.compute(results, dt)

    # Write debug frames (velocity now filled in)
    if args.debug_dir:
        cap2 = cv2.VideoCapture(args.video)
        result_by_idx = {r["frame_index"]: r for r in results}
        fi = 0
        while True:
            ok, frame = cap2.read()
            if not ok:
                break
            if fi in result_by_idx:
                orig_h, orig_w = frame.shape[:2]
                cal_w, cal_h = fs["width"], fs["height"]
                if orig_w != cal_w or orig_h != cal_h:
                    frame = cv2.resize(frame, (cal_w, cal_h), interpolation=cv2.INTER_LINEAR)
                write_debug_frame(frame, result_by_idx[fi], args.debug_dir)
            fi += 1
        cap2.release()
        log.info("Debug frames written to: %s", args.debug_dir)

    # Summary + output
    output.summary(results)

    out_path = args.output or default_output_path(args.video, args.fmt)
    output.write(results, out_path, args.fmt)

    return 0


if __name__ == "__main__":
    sys.exit(main())
