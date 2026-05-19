from __future__ import annotations

import csv
import json

from padel_engine.models.ball import BallFrame
from padel_engine.models.homography import Homography
from padel_engine.models.player import PlayerFrame


def load_ball_labels(path: str) -> dict[int, BallFrame]:
    result: dict[int, BallFrame] = {}
    with open(path, newline="") as f:
        reader = csv.DictReader(line for line in f if not line.startswith("#"))
        for row in reader:
            frame = int(row["frame"])
            px = float(row["x"]) if row["x"] else 0.0
            py = float(row["y"]) if row["y"] else 0.0
            result[frame] = BallFrame(
                frame=frame,
                time_s=float(row["time_s"]),
                play_state=row["play_state"],
                visibility=row["visibility"],
                pixel_x=px,
                pixel_y=py,
            )
    return result


def load_players(path: str) -> dict[int, list[PlayerFrame]]:
    result: dict[int, list[PlayerFrame]] = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            frame = int(row["frame_index"])
            pf = PlayerFrame(
                frame=frame,
                time_s=float(row["time_s"]),
                player_id=int(row["player_id"]),
                court_x=float(row["court_x_m"]),
                court_y=float(row["court_y_m"]),
                side=row["side"],
                confidence=float(row["confidence"]),
                bbox=(
                    float(row["bbox_x1"]),
                    float(row["bbox_y1"]),
                    float(row["bbox_x2"]),
                    float(row["bbox_y2"]),
                ),
                status=row["status"],
            )
            result.setdefault(frame, []).append(pf)
    return result


def load_homography(path: str) -> Homography:
    with open(path) as f:
        data = json.load(f)
    return Homography(H=data["H"], frame_size=data["frame_size"])
