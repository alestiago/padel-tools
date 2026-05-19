from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class BallFrame:
    frame: int
    time_s: float
    play_state: str       # "in_play" | "dead"
    visibility: str       # "visible" | "occluded" | "out_of_frame"
    pixel_x: float
    pixel_y: float
    court_x: float | None = field(default=None)
    court_y: float | None = field(default=None)
