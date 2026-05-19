import logging
import math
from dataclasses import dataclass

import numpy as np

log = logging.getLogger(__name__)

_NET_Y_M = 10.0


@dataclass
class PlayerDetection:
    player_id: int
    pixel_u: float    # foot x (px) — bottom-centre of bbox
    pixel_v: float    # foot y (px)
    court_x_m: float
    court_y_m: float
    side: str         # "near" | "far"
    confidence: float
    bbox_x1: float
    bbox_y1: float
    bbox_x2: float
    bbox_y2: float
    status: str = "detected"  # "detected" | "extrapolated" | "occluded"


class PlayerYoloDetector:
    """
    Person detector using a pre-trained YOLO model (Ultralytics).
    Returns up to 4 PlayerDetection objects per frame, filtered to court bounds
    and assigned stable IDs by court position (near-left=1, near-right=2,
    far-left=3, far-right=4).
    """

    def __init__(
        self,
        model_path: str,
        threshold: float = 0.4,
        H: np.ndarray | None = None,
        court_margin_m: float = 0.5,
    ):
        from ultralytics import YOLO  # deferred — slow to import
        self._model = YOLO(model_path)
        self._threshold = threshold
        self._H = H
        self._court_margin = court_margin_m

    def detect(self, frame_bgr: np.ndarray) -> list[PlayerDetection]:
        results = self._model.predict(
            frame_bgr, classes=[0], conf=self._threshold, verbose=False
        )[0]

        if results.boxes is None or len(results.boxes) == 0:
            return []

        m = self._court_margin
        raw: list[tuple] = []

        for box in results.boxes:
            conf = float(box.conf[0])
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
            foot_u = (x1 + x2) / 2.0
            foot_v = y2

            cx, cy = self._project(foot_u, foot_v)
            if not (-m <= cx <= 10.0 + m and -m <= cy <= 20.0 + m):
                log.debug("player out of court (%.1f, %.1f) — discarded", cx, cy)
                continue

            side = "near" if cy < _NET_Y_M else "far"
            raw.append((conf, x1, y1, x2, y2, foot_u, foot_v, cx, cy, side))

        return self._assign_ids(raw)

    def _project(self, u: float, v: float) -> tuple[float, float]:
        if self._H is None:
            return 5.0, 10.0
        p = self._H @ np.array([u, v, 1.0])
        return float(p[0] / p[2]), float(p[1] / p[2])

    @staticmethod
    def _assign_ids(raw: list[tuple]) -> list[PlayerDetection]:
        # Sort within each side by court_x so IDs are consistent frame-to-frame.
        # Player IDs: 1=near-left, 2=near-right, 3=far-left, 4=far-right.
        near = sorted([d for d in raw if d[9] == "near"], key=lambda d: d[7])
        far  = sorted([d for d in raw if d[9] == "far"],  key=lambda d: d[7])

        out: list[PlayerDetection] = []
        for pid, det in enumerate(near[:2] + far[:2], start=1):
            conf, x1, y1, x2, y2, fu, fv, cx, cy, side = det
            out.append(PlayerDetection(
                player_id=pid,
                pixel_u=fu, pixel_v=fv,
                court_x_m=cx, court_y_m=cy,
                side=side, confidence=conf,
                bbox_x1=x1, bbox_y1=y1,
                bbox_x2=x2, bbox_y2=y2,
            ))
        return out
