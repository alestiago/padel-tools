import logging
import math
from dataclasses import dataclass

import cv2
import numpy as np

log = logging.getLogger(__name__)

# Strict colour range — used in low-motion pixels
_LOWER_STRICT  = np.array([25,  80, 80], dtype=np.uint8)
# Relaxed saturation — used in high-motion pixels (ball blurs against court background)
_LOWER_RELAXED = np.array([25,  30, 80], dtype=np.uint8)
_UPPER         = np.array([45, 255, 255], dtype=np.uint8)


@dataclass
class _Confirmed:
    wx: float  # world x (metres)
    wy: float  # world y (metres)
    t: float   # timestamp (seconds)


class BlobDetectorV4:
    """
    blob_v4 — inherits all of blob_v3's improvements and adds:

    Fix A — Two-stage adaptive colour mask
        Pixels with high frame diff (ball blurring) use a relaxed saturation
        threshold (S ≥ 30) so motion-blurred balls aren't lost.  Pixels with
        low diff keep the strict threshold (S ≥ 80) to suppress false positives.

    Fix B — Lock-on guard
        If the last N confirmed detections all cluster within spread_m of each
        other in court space, the tracker has latched onto a stationary object.
        History is cleared so the next detection starts fresh.
    """

    # ── Stale-confirmation threshold (same as blob_v3) ──────────────────────
    _STALE_S = 1.0

    def __init__(
        self,
        # Colour
        lower_strict:  np.ndarray = _LOWER_STRICT,
        lower_relaxed: np.ndarray = _LOWER_RELAXED,
        upper:         np.ndarray = _UPPER,
        # Motion mask
        motion_threshold: int   = 20,
        motion_kernel:    int   = 7,
        # Adaptive colour — pixels above this diff level use relaxed saturation
        blur_diff_threshold: int = 40,
        # Blob / contour
        min_area:        float = 30.0,
        base_max_area:   float = 1200.0,
        target_area:     float = 700.0,
        max_aspect_ratio: float = 5.0,
        # Scoring
        pred_sigma_px:   float = 150.0,
        # Kinematic gates
        min_velocity_kmh: float = 5.0,
        max_velocity_kmh: float = 250.0,
        # Lock-on guard
        lock_on_count:    int   = 10,
        lock_on_spread_m: float = 1.0,
        # Spatial filter
        H_inv:          np.ndarray | None = None,
        court_margin_m: float = 0.5,
    ):
        self._lower_strict  = lower_strict
        self._lower_relaxed = lower_relaxed
        self._upper         = upper
        self._motion_threshold  = motion_threshold
        self._motion_kern = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (motion_kernel, motion_kernel)
        )
        self._blur_diff_threshold = blur_diff_threshold
        self._min_area        = min_area
        self._base_max_area   = base_max_area
        self._target_area     = target_area
        self._max_aspect_ratio = max_aspect_ratio
        self._pred_sigma_px   = pred_sigma_px
        self._min_velocity_kmh = min_velocity_kmh
        self._max_velocity_kmh = max_velocity_kmh
        self._lock_on_count   = lock_on_count
        self._lock_on_spread_m = lock_on_spread_m
        self._H_inv = H_inv

        # Court pixel polygon (same construction as blob_v2/v3)
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

        self._prev_gray: np.ndarray | None = None
        self._confirmed: list[_Confirmed] = []

    # ── Public interface ────────────────────────────────────────────────────

    def detect(self, frame_bgr: np.ndarray) -> tuple[float, float] | None:
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)

        if self._prev_gray is None:
            self._prev_gray = gray
            return None

        diff = cv2.absdiff(gray, self._prev_gray)
        self._prev_gray = gray

        # ── Motion mask (same as blob_v3) ───────────────────────────────────
        _, motion_mask = cv2.threshold(diff, self._motion_threshold, 255, cv2.THRESH_BINARY)
        motion_mask = cv2.dilate(motion_mask, self._motion_kern, iterations=2)

        # ── Fix A: two-stage adaptive colour mask ───────────────────────────
        # Pixels that moved a lot are likely ball-blur regions → use relaxed S.
        # Pixels with little or no change → keep strict S to suppress FP.
        hsv          = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
        strict_color  = cv2.inRange(hsv, self._lower_strict,  self._upper)
        relaxed_color = cv2.inRange(hsv, self._lower_relaxed, self._upper)
        high_motion   = diff > self._blur_diff_threshold
        color_mask    = np.where(high_motion, relaxed_color, strict_color).astype(np.uint8)

        # ── Combine colour + motion ─────────────────────────────────────────
        combined = cv2.bitwise_and(color_mask, motion_mask)

        # ── Court polygon spatial filter ────────────────────────────────────
        if self._court_poly is not None:
            poly_mask = np.zeros(frame_bgr.shape[:2], dtype=np.uint8)
            cv2.fillPoly(poly_mask, [self._court_poly.astype(np.int32)], 255)
            combined = cv2.bitwise_and(combined, poly_mask)

        # ── Morphological cleanup ───────────────────────────────────────────
        kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN, kern)
        combined = cv2.dilate(combined, kern, iterations=1)

        # ── Adaptive max_area (same as blob_v3) ─────────────────────────────
        blur_factor   = min(1.0 + float(diff.mean()) / 30.0 * 3.0, 4.0)
        max_area_eff  = self._base_max_area * blur_factor

        # ── Contour + ellipse detection (same as blob_v3) ───────────────────
        contours, _ = cv2.findContours(combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        candidates: list[tuple[float, float, float, float]] = []
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < self._min_area or area > max_area_eff:
                continue
            if len(cnt) >= 5:
                ellipse = cv2.fitEllipse(cnt)
                cx, cy  = ellipse[0]
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

        pred_u, pred_v = self._predict_next_pixel()
        best = max(candidates, key=lambda c: self._score(c, diff, pred_u, pred_v))
        return float(best[0]), float(best[1])

    def confirm(self, court_x: float, court_y: float, time_s: float) -> None:
        self._confirmed.append(_Confirmed(wx=court_x, wy=court_y, t=time_s))
        # Keep enough history for both prediction (2) and lock-on check (lock_on_count)
        max_keep = max(2, self._lock_on_count)
        if len(self._confirmed) > max_keep:
            self._confirmed.pop(0)

        # ── Fix B: lock-on guard ─────────────────────────────────────────
        if self._is_locked_on():
            log.debug("lock-on detected over %.1f m — resetting history", self._lock_on_spread_m)
            self._confirmed.clear()

    def velocity_gate(self, court_x: float, court_y: float, time_s: float) -> bool:
        if not self._confirmed:
            return True

        prev = self._confirmed[-1]
        dt   = time_s - prev.t
        if dt <= 0:
            return True

        # Stale gap → allow as fresh start
        if dt > self._STALE_S:
            log.debug("stale confirmation (%.2f s) — resetting", dt)
            self._confirmed.clear()
            return True

        dist    = math.hypot(court_x - prev.wx, court_y - prev.wy)
        implied = dist / dt * 3.6

        if implied > self._max_velocity_kmh:
            log.debug("gate (too fast): %.1f km/h", implied)
            return False
        if len(self._confirmed) >= 2 and implied < self._min_velocity_kmh:
            log.debug("gate (too slow): %.1f km/h", implied)
            return False
        return True

    def reset(self) -> None:
        self._prev_gray = None
        self._confirmed.clear()

    # ── Internal helpers ────────────────────────────────────────────────────

    def _is_locked_on(self) -> bool:
        """Fix B: True when recent confirmations cluster inside lock_on_spread_m."""
        n = self._lock_on_count
        if len(self._confirmed) < n:
            return False
        recent = self._confirmed[-n:]
        xs = [c.wx for c in recent]
        ys = [c.wy for c in recent]
        spread = math.hypot(max(xs) - min(xs), max(ys) - min(ys))
        return spread < self._lock_on_spread_m

    def _predict_next_pixel(self) -> tuple[float | None, float | None]:
        """Extrapolate one step ahead from the last two world-space detections."""
        if len(self._confirmed) < 2 or self._H_inv is None:
            return None, None
        p1, p2 = self._confirmed[-2], self._confirmed[-1]
        pred_wx = p2.wx + (p2.wx - p1.wx)
        pred_wy = p2.wy + (p2.wy - p1.wy)
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

        area_score   = 1.0 / (1.0 + abs(area - self._target_area) / self._target_area)
        aspect_score = 1.0 / aspect

        r  = max(int(math.sqrt(area / math.pi)) + 5, 6)
        x1, x2 = max(0, int(cx) - r), min(w, int(cx) + r)
        y1, y2 = max(0, int(cy) - r), min(h, int(cy) + r)
        roi = diff[y1:y2, x1:x2]
        motion_score = float(roi.mean()) / 255.0 if roi.size > 0 else 0.0

        if pred_u is not None and pred_v is not None:
            pred_score = math.exp(-math.hypot(cx - pred_u, cy - pred_v) / self._pred_sigma_px)
        else:
            pred_score = 0.5

        return (
            area_score    * 0.30
            + aspect_score  * 0.10
            + motion_score  * 0.30
            + pred_score    * 0.30
        )
