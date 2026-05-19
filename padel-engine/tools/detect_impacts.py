#!/usr/bin/env python3
"""Detect ball impact events (direction changes) in a padel video.

Usage:
    python3 padel-engine/tools/detect_impacts.py \
        --ball-labels  .dev/jugada1/jugada1_labels.csv \
        --players      .dev/jugada1/players.csv \
        --homography   .dev/jugada1/homography_jugada1.json \
        --output       .dev/jugada1/impacts.csv
"""
from __future__ import annotations

import argparse
import csv
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from padel_engine.impact_detector import BallImpactDetector
from padel_engine.loaders import load_ball_labels, load_homography, load_players
from padel_engine.motion_detector import BallMotionDetector


def main() -> None:
    parser = argparse.ArgumentParser(description="Detect ball impact events.")
    parser.add_argument("--ball-labels", required=True)
    parser.add_argument("--players", required=True)
    parser.add_argument("--homography", required=True)
    parser.add_argument("--output", default="impacts.csv")
    parser.add_argument("--min-angle", type=float, default=25.0, help="Min direction-change angle (°)")
    parser.add_argument("--min-speed", type=float, default=40.0, help="Min ball speed px/s")
    parser.add_argument("--merge-gap", type=int, default=8, help="Max frames to merge into one impact")
    parser.add_argument("--proximity", type=float, default=1.3, help="Racket proximity threshold (m)")
    parser.add_argument("--smooth-sigma", type=float, default=1.5, help="Gaussian smooth sigma (frames)")
    args = parser.parse_args()

    print("Loading data...")
    ball_frames = load_ball_labels(args.ball_labels)
    player_frames = load_players(args.players)
    homography = load_homography(args.homography)
    print(f"  {len(ball_frames)} ball frames, {len(player_frames)} player frames")

    print("Computing ball motion...")
    motion_det = BallMotionDetector(homography, smooth_sigma=args.smooth_sigma)
    motion = motion_det.compute(ball_frames)
    print(f"  {len(motion)} frames with valid centred velocity")

    print("Detecting impacts...")
    impact_det = BallImpactDetector(
        homography,
        min_angle=args.min_angle,
        min_speed=args.min_speed,
        merge_gap=args.merge_gap,
        racket_dist_m=args.proximity,
    )
    events = impact_det.detect(motion, ball_frames, player_frames)

    surface_counts: dict[str, int] = {}
    print(f"\nDetected {len(events)} impact events:")
    for ev in events:
        surface_counts[ev.surface] = surface_counts.get(ev.surface, 0) + 1
        court_str = f"({ev.court_x:.1f},{ev.court_y:.1f})" if ev.court_x is not None else "  OOB  "
        player_str = f"P{ev.nearest_player_id} {ev.nearest_player_dist_m:.2f}m" if ev.nearest_player_id else "    --    "
        print(
            f"  t={ev.time_s:6.2f}s  frame={ev.frame:3d}  "
            f"Δdir={ev.direction_change_deg:5.1f}°  spd={ev.speed_after_px_s:5.0f}  "
            f"court={court_str}  {ev.surface:7s}  {player_str}  conf={ev.confidence:.2f}"
        )
    print(f"\nBy surface: {dict(sorted(surface_counts.items()))}")

    fieldnames = [
        "frame", "time_s", "pixel_x", "pixel_y",
        "court_x_m", "court_y_m",
        "direction_change_deg", "speed_before_px_s", "speed_after_px_s", "speed_change_ratio",
        "surface", "nearest_player_id", "nearest_player_dist_m", "confidence",
    ]
    with open(args.output, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for ev in events:
            writer.writerow({
                "frame": ev.frame,
                "time_s": f"{ev.time_s:.4f}",
                "pixel_x": f"{ev.pixel_x:.1f}",
                "pixel_y": f"{ev.pixel_y:.1f}",
                "court_x_m": f"{ev.court_x:.3f}" if ev.court_x is not None else "",
                "court_y_m": f"{ev.court_y:.3f}" if ev.court_y is not None else "",
                "direction_change_deg": f"{ev.direction_change_deg:.1f}",
                "speed_before_px_s": f"{ev.speed_before_px_s:.1f}",
                "speed_after_px_s": f"{ev.speed_after_px_s:.1f}",
                "speed_change_ratio": f"{ev.speed_change_ratio:.3f}",
                "surface": ev.surface,
                "nearest_player_id": ev.nearest_player_id if ev.nearest_player_id else "",
                "nearest_player_dist_m": f"{ev.nearest_player_dist_m:.3f}" if ev.nearest_player_dist_m is not None else "",
                "confidence": f"{ev.confidence:.3f}",
            })

    print(f"\nOutput → {args.output}")


if __name__ == "__main__":
    main()
