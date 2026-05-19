import logging
import math
from dataclasses import dataclass, field

import cv2
import numpy as np

log = logging.getLogger(__name__)

_DEFAULT_LOWER = np.array([25, 80, 80], dtype=np.uint8)
_DEFAULT_UPPER = np.array([45, 255, 255], dtype=np.uint8)


@dataclass
class _Confirmed:
    wx: float  # world x (court metres)
    wy: float  # world y (court metres)
    t: float   # timestamp (seconds)


class BlobDetectorV3:
    def __init__(
        self,
        hsv_lower: np.ndarray = _DEFAULT_LOWER,
        hsv_upper: np.ndarray = _DEFAULT_UPPER,
        motion_threshold: int = 20,
        motion_kernel: int = 7,
        min_area: float = 30.0,
        base_max_area: float = 1200.0,
        target_area: float = 700.0,
        max_aspect_ratio: float = 5.0,
        pred_sigma_px: float = 150.0,
        min_velocity_kmh: float = 5.0,
        max_velocity_kmh: float = 250.0,
        H_inv: np.ndarray | None = None,
        court_margin_m: float = 0.5,
    ):
        self._lower = hsv_lower
        self._upper = hsv_upper
        self._motion_threshold = motion_threshold
        self._motion_kern = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (motion_kernel, motion_kernel)
        )
        self._min_area = min_area
        self._base_max_area = base_max_area
        self._target_area = target_area
        self._max_aspect_ratio = max_aspect_ratio
        self._pred_sigma_px = pred_sigma_px
        self._min_velocity_kmh = min_velocity_kmh
        self._max_velocity_kmh = max_velocity_kmh
        self._H_inv = H_inv

        # Court polygon in pixel space — same approach as blob_v2
        self._court_poly: np.ndarray | None = None
        if H_inv is not None:
            m = court_margin_m
            corners = np.array([
                [-m,       -m],
                [10.0 + m, -m],
                [10.0 + m, 20.0 + m],
                [-m,       20.0 + m],
            ], dtype=np.float64)
            pts = []
            for x, y in corners:
                p = H_inv @ np.array([x, y, 1.0])
                pts.append([p[0] / p[2], p[1] / p[2]])
            self._court_poly = np.array(pts, dtype=np.float32)

        # Mutable state
        self._prev_gray: np.ndarray | None = None
        self._confirmed: list[_Confirmed] = []  # ring of last 2 confirmed detections

    # ------------------------------------------------------------------
    # Public interface (same as blob_v2)
    # ------------------------------------------------------------------

    def detect(self, frame_bgr: np.ndarray) -> tuple[float, float] | None:
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)

        # Motion mask — skip on first frame
        if self._prev_gray is None:
            self._prev_gray = gray
            return None

        diff = cv2.absdiff(gray, self._prev_gray)
        self._prev_gray = gray

        _, motion_mask = cv2.threshold(diff, self._motion_threshold, 255, cv2.THRESH_BINARY)
        motion_mask = cv2.dilate(motion_mask, self._motion_kern, iterations=2)

        # HSV colour mask
        hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
        color_mask = cv2.inRange(hsv, self._lower, self._upper)

        # Combine: must be ball-coloured AND moving
        combined = cv2.bitwise_and(color_mask, motion_mask)

        # Court polygon spatial filter
        if self._court_poly is not None:
            poly_mask = np.zeros(frame_bgr.shape[:2], dtype=np.uint8)
            cv2.fillPoly(poly_mask, [self._court_poly.astype(np.int32)], 255)
            combined = cv2.bitwise_and(combined, poly_mask)

        # Morphological cleanup
        kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN, kern)
        combined = cv2.dilate(combined, kern, iterations=1)

        # Fix 4 — adaptive max_area: high overall motion → bigger blurs expected
        mean_motion = float(diff.mean())
        blur_factor = min(1.0 + (mean_motion / 30.0) * 3.0, 4.0)
        max_area_eff = self._base_max_area * blur_factor

        # Fix 1 — contour + ellipse detection (replaces SimpleBlobDetector)
        contours, _ = cv2.findContours(combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        candidates: list[tuple[float, float, float, float]] = []  # (cx, cy, area, aspect)
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < self._min_area or area > max_area_eff:
                continue

            if len(cnt) >= 5:
                ellipse = cv2.fitEllipse(cnt)
                cx, cy = ellipse[0]
                minor, major = sorted(ellipse[1])
                aspect = major / max(minor, 1.0)
            else:
                M = cv2.moments(cnt)
                if M["m00"] == 0:
                    continue
                cx = M["m10"] / M["m00"]
                cy = M["m01"] / M["m00"]
                aspect = 1.0

            if aspect > self._max_aspect_ratio:
                continue

            candidates.append((cx, cy, area, aspect))

        if not candidates:
            return None

        # Fix 2 + 5 — composite scoring with motion magnitude and trajectory prediction
        pred_u, pred_v = self._predict_next_pixel()
        best = max(candidates, key=lambda c: self._score(c, diff, pred_u, pred_v))
        return float(best[0]), float(best[1])

    def confirm(self, court_x: float, court_y: float, time_s: float) -> None:
        """Record a confirmed world-space detection. Called by main.py after all gates pass."""
        self._confirmed.append(_Confirmed(wx=court_x, wy=court_y, t=time_s))
        if len(self._confirmed) > 2:
            self._confirmed.pop(0)

    # Stale threshold: if the last confirmed detection is older than this, the
    # ball has had enough time to be anywhere on court — reset and allow.
    _STALE_S = 1.0

    def velocity_gate(self, court_x: float, court_y: float, time_s: float) -> bool:
        """
        Returns True if the candidate is kinematically plausible:
          - not faster than max_velocity_kmh  (same as blob_v2)
          - not slower than min_velocity_kmh  (Fix 3 — kills drifting false positives)
        The minimum gate only activates once two consecutive detections are confirmed.
        Stale confirmed history (> _STALE_S seconds old) is automatically cleared so
        the detector can re-anchor after a gap without a cascade of rejections.
        """
        if not self._confirmed:
            return True

        prev = self._confirmed[-1]
        dt = time_s - prev.t
        if dt <= 0:
            return True

        # Gap longer than stale threshold → reset and allow as a fresh detection
        if dt > self._STALE_S:
            log.debug("stale confirmation (%.2f s gap) — resetting history", dt)
            self._confirmed.clear()
            return True

        dist = math.hypot(court_x - prev.wx, court_y - prev.wy)
        implied = dist / dt * 3.6

        if implied > self._max_velocity_kmh:
            log.debug("velocity gate (too fast): %.1f km/h — discarded", implied)
            return False

        # Fix 3 — minimum velocity: only enforce after 2+ confirmed to let first detection anchor
        if len(self._confirmed) >= 2 and implied < self._min_velocity_kmh:
            log.debug("velocity gate (too slow): %.1f km/h — discarded", implied)
            return False

        return True

    def reset(self) -> None:
        self._prev_gray = None
        self._confirmed.clear()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _predict_next_pixel(self) -> tuple[float, float] | None:
        """
        Fix 5 — extrapolate from the last two confirmed world-space detections
        by one more displacement step, then project to pixel space via H_inv.
        Returns (pred_u, pred_v) or (None, None) when insufficient history.
        """
        if len(self._confirmed) < 2 or self._H_inv is None:
            return None, None

        p1, p2 = self._confirmed[-2], self._confirmed[-1]
        dwx = p2.wx - p1.wx
        dwy = p2.wy - p1.wy

        pred_wx = p2.wx + dwx
        pred_wy = p2.wy + dwy

        p = self._H_inv @ np.array([pred_wx, pred_wy, 1.0])
        w = p[2]
        if abs(w) < 1e-9:
            return None, None
        return float(p[0] / w), float(p[1] / w)

    def _score(
        self,
        candidate: tuple[float, float, float, float],
        diff: np.ndarray,
        pred_u: float | None,
        pred_v: float | None,
    ) -> float:
        cx, cy, area, aspect = candidate
        h, w = diff.shape

        # 1. Area proximity to expected ball size
        area_score = 1.0 / (1.0 + abs(area - self._target_area) / self._target_area)

        # 2. Shape: rounder is better but streaks are acceptable
        aspect_score = 1.0 / aspect

        # 3. Motion magnitude at the candidate location
        r = max(int(math.sqrt(area / math.pi)) + 5, 6)
        x1, x2 = max(0, int(cx) - r), min(w, int(cx) + r)
        y1, y2 = max(0, int(cy) - r), min(h, int(cy) + r)
        roi = diff[y1:y2, x1:x2]
        motion_score = float(roi.mean()) / 255.0 if roi.size > 0 else 0.0

        # 4. Proximity to trajectory prediction
        if pred_u is not None and pred_v is not None:
            dist_px = math.hypot(cx - pred_u, cy - pred_v)
            pred_score = math.exp(-dist_px / self._pred_sigma_px)
        else:
            pred_score = 0.5  # neutral when no history

        return (
            area_score   * 0.30
            + aspect_score * 0.10
            + motion_score * 0.30
            + pred_score   * 0.30
        )
