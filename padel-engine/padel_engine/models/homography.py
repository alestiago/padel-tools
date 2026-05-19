from __future__ import annotations

import numpy as np


class Homography:
    COURT_WIDTH_M = 10.0
    COURT_HEIGHT_M = 20.0

    def __init__(self, H: list[list[float]], frame_size: dict[str, int]) -> None:
        self._H = np.array(H, dtype=np.float64)
        self.frame_size = frame_size

    def pixel_to_court(self, u: float, v: float) -> tuple[float, float]:
        """Apply H: [xw, yw, w]^T = H · [u, v, 1]^T; return (xw/w, yw/w)."""
        p = self._H @ np.array([u, v, 1.0])
        return float(p[0] / p[2]), float(p[1] / p[2])

    def is_in_court(self, court_x: float, court_y: float, margin: float = 0.5) -> bool:
        return (
            -margin <= court_x <= self.COURT_WIDTH_M + margin
            and -margin <= court_y <= self.COURT_HEIGHT_M + margin
        )
