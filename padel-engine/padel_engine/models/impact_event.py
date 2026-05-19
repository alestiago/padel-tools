from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class BallImpactEvent:
    frame: int
    time_s: float
    pixel_x: float                          # raw (un-smoothed) ball pixel position
    pixel_y: float
    court_x: float | None = field(default=None)   # None when projection OOB
    court_y: float | None = field(default=None)
    direction_change_deg: float = 0.0
    speed_before_px_s: float = 0.0
    speed_after_px_s: float = 0.0
    speed_change_ratio: float = 1.0         # speed_after / speed_before
    surface: str = "unknown"                # floor | racket | wall | fence | net | unknown
    nearest_player_id: int | None = field(default=None)
    nearest_player_dist_m: float | None = field(default=None)
    confidence: float = 0.0
