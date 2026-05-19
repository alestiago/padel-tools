import logging
import cv2
import numpy as np

log = logging.getLogger(__name__)

# Default HSV range for a padel/tennis ball (yellow-green)
_DEFAULT_LOWER = np.array([25, 80, 80], dtype=np.uint8)
_DEFAULT_UPPER = np.array([45, 255, 255], dtype=np.uint8)


class BlobDetector:
    def __init__(
        self,
        hsv_lower: np.ndarray = _DEFAULT_LOWER,
        hsv_upper: np.ndarray = _DEFAULT_UPPER,
        min_area: float = 20.0,
        max_area: float = 2000.0,
    ):
        self._lower = hsv_lower
        self._upper = hsv_upper

        params = cv2.SimpleBlobDetector_Params()
        params.filterByArea = True
        params.minArea = min_area
        params.maxArea = max_area
        params.filterByCircularity = True
        params.minCircularity = 0.5
        params.filterByConvexity = False
        params.filterByInertia = False
        self._detector = cv2.SimpleBlobDetector_create(params)

    def detect(self, frame_bgr: np.ndarray) -> tuple[float, float] | None:
        """Return (u, v) pixel centroid of the largest ball blob, or None."""
        hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, self._lower, self._upper)

        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.dilate(mask, kernel, iterations=2)

        # Invert: SimpleBlobDetector finds dark blobs on light background
        inv = cv2.bitwise_not(mask)
        keypoints = self._detector.detect(inv)

        if not keypoints:
            return None

        best = max(keypoints, key=lambda kp: kp.size)
        return float(best.pt[0]), float(best.pt[1])

    def reset(self) -> None:
        pass
