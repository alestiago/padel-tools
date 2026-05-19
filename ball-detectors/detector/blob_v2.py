import logging
import math
import cv2
import numpy as np

log = logging.getLogger(__name__)

_DEFAULT_LOWER = np.array([25, 80, 80], dtype=np.uint8)
_DEFAULT_UPPER = np.array([45, 255, 255], dtype=np.uint8)

# Court boundary in world coordinates (metres)
_COURT_CORNERS = np.array([
    [0.0,  0.0],
    [10.0, 0.0],
    [10.0, 20.0],
    [0.0,  20.0],
], dtype=np.float64)


class BlobDetectorV2:
    def __init__(
        self,
        hsv_lower: np.ndarray = _DEFAULT_LOWER,
        hsv_upper: np.ndarray = _DEFAULT_UPPER,
        motion_threshold: int = 20,
        motion_kernel: int = 7,
        min_area: float = 30.0,
        max_area: float = 1200.0,
        target_area: float = 700.0,
        H_inv: np.ndarray | None = None,
        court_margin_m: float = 0.5,
        max_velocity_kmh: float = 250.0,
    ):
        self._lower = hsv_lower
        self._upper = hsv_upper
        self._motion_threshold = motion_threshold
        self._motion_kern = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (motion_kernel, motion_kernel)
        )
        self._target_area = target_area
        self._max_velocity_kmh = max_velocity_kmh

        params = cv2.SimpleBlobDetector_Params()
        params.filterByArea = True
        params.minArea = min_area
        params.maxArea = max_area
        params.filterByCircularity = True
        params.minCircularity = 0.4
        params.filterByConvexity = False
        params.filterByInertia = False
        self._blob = cv2.SimpleBlobDetector_create(params)

        # Fix 3 — build court polygon in pixel space from H_inv
        self._court_poly: np.ndarray | None = None
        if H_inv is not None:
            m = court_margin_m
            corners = np.array([
                [-m,      -m],
                [10.0+m,  -m],
                [10.0+m,  20.0+m],
                [-m,      20.0+m],
            ], dtype=np.float64)
            pts = []
            for x, y in corners:
                p = H_inv @ np.array([x, y, 1.0])
                pts.append([p[0] / p[2], p[1] / p[2]])
            self._court_poly = np.array(pts, dtype=np.float32)

        # State for Fix 1 (motion) and Fix 4 (trajectory gate)
        self._prev_gray: np.ndarray | None = None
        # last confirmed world pos + timestamp (seconds)
        self._prev_world: tuple[float, float, float] | None = None  # (x, y, t)

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def detect(self, frame_bgr: np.ndarray) -> tuple[float, float] | None:
        """Return (u, v) pixel centroid of the best ball candidate, or None."""
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)

        # Fix 1 — motion mask: skip first frame, use diff thereafter
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

        # Combine colour + motion
        combined = cv2.bitwise_and(color_mask, motion_mask)

        # Fix 3 — court polygon mask
        if self._court_poly is not None:
            poly_mask = np.zeros(frame_bgr.shape[:2], dtype=np.uint8)
            cv2.fillPoly(poly_mask, [self._court_poly.astype(np.int32)], 255)
            combined = cv2.bitwise_and(combined, poly_mask)

        # Morphological cleanup
        kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN, kern)
        combined = cv2.dilate(combined, kern, iterations=1)

        # SimpleBlobDetector expects dark blobs on light background
        keypoints = self._blob.detect(cv2.bitwise_not(combined))
        if not keypoints:
            return None

        # Fix 2 — prefer blob whose area is closest to target
        def blob_area(kp: cv2.KeyPoint) -> float:
            return math.pi * (kp.size / 2) ** 2

        best = min(keypoints, key=lambda kp: abs(blob_area(kp) - self._target_area))
        return float(best.pt[0]), float(best.pt[1])

    def confirm(self, court_x: float, court_y: float, time_s: float) -> None:
        """Record a confirmed world-space detection for the trajectory gate."""
        self._prev_world = (court_x, court_y, time_s)

    def velocity_gate(self, court_x: float, court_y: float, time_s: float) -> bool:
        """
        Fix 4 — return True if this candidate is reachable from the previous
        confirmed detection without exceeding max_velocity_kmh.
        Always returns True when there is no prior detection.
        """
        if self._prev_world is None:
            return True
        px, py, pt = self._prev_world
        dt = time_s - pt
        if dt <= 0:
            return True
        dx, dy = court_x - px, court_y - py
        implied = math.hypot(dx, dy) / dt * 3.6
        if implied > self._max_velocity_kmh:
            log.debug(
                "trajectory gate: %.1f km/h implied — candidate discarded", implied
            )
            return False
        return True

    def reset(self) -> None:
        self._prev_gray = None
        self._prev_world = None
