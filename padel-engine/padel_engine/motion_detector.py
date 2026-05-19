from __future__ import annotations

import math

import numpy as np

from padel_engine.models.ball import BallFrame
from padel_engine.models.homography import Homography
from padel_engine.models.motion import BallMotionFrame


def _gaussian_smooth_1d(arr: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian smooth with reflect-padding to avoid edge pull."""
    radius = max(1, int(3.0 * sigma))
    k = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-0.5 * k ** 2 / sigma ** 2)
    kernel /= kernel.sum()
    padded = np.pad(arr, radius, mode="reflect")
    return np.convolve(padded, kernel, mode="valid")


class BallMotionDetector:
    DEFAULT_SMOOTH_SIGMA = 1.5
    DEFAULT_MAX_FRAME_GAP = 4   # frames; don't compute velocity across larger gaps

    def __init__(
        self,
        homography: Homography,
        smooth_sigma: float = DEFAULT_SMOOTH_SIGMA,
        max_frame_gap: int = DEFAULT_MAX_FRAME_GAP,
    ) -> None:
        self.homography = homography
        self.smooth_sigma = smooth_sigma
        self.max_frame_gap = max_frame_gap

    def compute(self, ball_frames: dict[int, BallFrame]) -> dict[int, BallMotionFrame]:
        """Return a BallMotionFrame for every visible frame that has a valid centred velocity."""
        visible = sorted(
            (bf for bf in ball_frames.values() if bf.visibility == "visible" and bf.pixel_x),
            key=lambda bf: bf.frame,
        )
        if len(visible) < 3:
            return {}

        frames = [bf.frame for bf in visible]
        xs = np.array([bf.pixel_x for bf in visible], dtype=np.float64)
        ys = np.array([bf.pixel_y for bf in visible], dtype=np.float64)

        sx = _gaussian_smooth_1d(xs, self.smooth_sigma)
        sy = _gaussian_smooth_1d(ys, self.smooth_sigma)

        result: dict[int, BallMotionFrame] = {}

        for i, bf in enumerate(visible):
            if i == 0 or i == len(visible) - 1:
                continue  # centred difference needs neighbours

            prev_bf = visible[i - 1]
            next_bf = visible[i + 1]

            # skip if neighbours are too far away in time
            if (bf.frame - prev_bf.frame) > self.max_frame_gap:
                continue
            if (next_bf.frame - bf.frame) > self.max_frame_gap:
                continue

            dt = next_bf.time_s - prev_bf.time_s
            if dt <= 0:
                continue

            vx_px = (sx[i + 1] - sx[i - 1]) / dt
            vy_px = (sy[i + 1] - sy[i - 1]) / dt
            speed_px = math.hypot(vx_px, vy_px)
            direction = math.degrees(math.atan2(vy_px, vx_px))

            # court-space velocity (only when both endpoints project in-bounds)
            vx_m = vy_m = speed_m = None
            try:
                cx_prev, cy_prev = self.homography.pixel_to_court(sx[i - 1], sy[i - 1])
                cx_next, cy_next = self.homography.pixel_to_court(sx[i + 1], sy[i + 1])
                if (
                    self.homography.is_in_court(cx_prev, cy_prev, margin=0.5)
                    and self.homography.is_in_court(cx_next, cy_next, margin=0.5)
                ):
                    vx_m = (cx_next - cx_prev) / dt
                    vy_m = (cy_next - cy_prev) / dt
                    speed_m = math.hypot(vx_m, vy_m)
            except Exception:
                pass

            result[bf.frame] = BallMotionFrame(
                frame=bf.frame,
                time_s=bf.time_s,
                smooth_px=float(sx[i]),
                smooth_py=float(sy[i]),
                vx_px=vx_px,
                vy_px=vy_px,
                speed_px_s=speed_px,
                direction_deg=direction,
                vx_m_s=vx_m,
                vy_m_s=vy_m,
                speed_m_s=speed_m,
            )

        return result
