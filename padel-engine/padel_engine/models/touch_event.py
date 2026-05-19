from __future__ import annotations

from dataclasses import dataclass


@dataclass
class TouchEvent:
    frame: int
    time_s: float
    player_id: int
    side: str
    ball_court_x: float
    ball_court_y: float
    player_court_x: float
    player_court_y: float
    distance_m: float
    direction_change_deg: float | None
    confidence: float
