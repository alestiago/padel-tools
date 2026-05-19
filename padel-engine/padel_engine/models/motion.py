from __future__ import annotations

import math
from dataclasses import dataclass, field


@dataclass
class BallMotionFrame:
    frame: int
    time_s: float
    smooth_px: float        # Gaussian-smoothed pixel position used for velocity
    smooth_py: float
    vx_px: float            # centred velocity — pixel space
    vy_px: float
    speed_px_s: float
    direction_deg: float    # atan2(vy_px, vx_px), degrees
    vx_m_s: float | None = field(default=None)   # court-space velocity
    vy_m_s: float | None = field(default=None)   # (None when projection OOB)
    speed_m_s: float | None = field(default=None)
