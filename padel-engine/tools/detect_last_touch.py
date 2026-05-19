#!/usr/bin/env python3
"""Detect the last player to touch the ball in a padel rally.

Usage:
    python3 padel-engine/tools/detect_last_touch.py \
        --ball-labels .dev/jugada1/jugada1_labels.csv \
        --players     .dev/jugada1/players.csv \
        --homography  .dev/homography_padel_recording_xs.json \
        --output      .dev/jugada1/last_touch.csv
"""
from __future__ import annotations

import argparse
import csv
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from padel_engine.loaders import load_ball_labels, load_homography, load_players
from padel_engine.touch_detector import TouchDetector


def main() -> None:
    parser = argparse.ArgumentParser(description="Detect last-touch events from ball labels + player tracks.")
    parser.add_argument("--ball-labels", required=True, help="Ball labels CSV")
    parser.add_argument("--players", required=True, help="Player tracks CSV")
    parser.add_argument("--homography", required=True, help="Homography JSON")
    parser.add_argument("--output", default="last_touch.csv", help="Output CSV path")
    parser.add_argument("--proximity", type=float, default=1.0, help="Proximity threshold in metres (default 1.0)")
    parser.add_argument("--min-gap", type=int, default=6, help="Min frame gap between separate touch events (default 6)")
    args = parser.parse_args()

    print("Loading data...")
    ball_frames = load_ball_labels(args.ball_labels)
    player_frames = load_players(args.players)
    homography = load_homography(args.homography)
    print(f"  {len(ball_frames)} ball frames, {len(player_frames)} player-indexed frames")

    detector = TouchDetector(homography, proximity_m=args.proximity, min_gap_frames=args.min_gap)
    events = detector.detect(ball_frames, player_frames)

    print(f"\nDetected {len(events)} touch events:")
    counts: dict[int, int] = {}
    for ev in events:
        counts[ev.player_id] = counts.get(ev.player_id, 0) + 1
        dir_str = f"{ev.direction_change_deg:.0f}°" if ev.direction_change_deg is not None else " n/a"
        print(
            f"  t={ev.time_s:6.3f}s  frame={ev.frame:3d}  "
            f"P{ev.player_id} ({ev.side:4s})  "
            f"dist={ev.distance_m:.2f}m  Δdir={dir_str:>5}  "
            f"conf={ev.confidence:.2f}"
        )

    print(f"\nTouches per player: { {f'P{k}': v for k, v in sorted(counts.items())} }")

    fieldnames = [
        "touch_frame", "touch_time_s", "player_id", "side",
        "ball_court_x_m", "ball_court_y_m",
        "player_court_x_m", "player_court_y_m",
        "distance_m", "direction_change_deg", "confidence",
    ]
    with open(args.output, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for ev in events:
            writer.writerow({
                "touch_frame": ev.frame,
                "touch_time_s": f"{ev.time_s:.4f}",
                "player_id": ev.player_id,
                "side": ev.side,
                "ball_court_x_m": f"{ev.ball_court_x:.3f}",
                "ball_court_y_m": f"{ev.ball_court_y:.3f}",
                "player_court_x_m": f"{ev.player_court_x:.3f}",
                "player_court_y_m": f"{ev.player_court_y:.3f}",
                "distance_m": f"{ev.distance_m:.3f}",
                "direction_change_deg": f"{ev.direction_change_deg:.1f}" if ev.direction_change_deg is not None else "",
                "confidence": f"{ev.confidence:.3f}",
            })

    print(f"\nOutput → {args.output}")


if __name__ == "__main__":
    main()
