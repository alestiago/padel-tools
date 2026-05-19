from __future__ import annotations

from dataclasses import dataclass


@dataclass
class PlayerFrame:
    frame: int
    time_s: float
    player_id: int
    court_x: float
    court_y: float
    side: str                                    # "near" | "far"
    confidence: float
    bbox: tuple[float, float, float, float]      # x1, y1, x2, y2 (pixels)
    status: str                                  # "detected" | "extrapolated" | "occluded"
