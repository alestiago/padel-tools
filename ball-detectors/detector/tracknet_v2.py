import logging
import math
import collections
from dataclasses import dataclass

import cv2
import numpy as np
import onnxruntime as ort

log = logging.getLogger(__name__)

MODEL_W = 512
MODEL_H = 288

_STALE_S = 1.0


@dataclass
class _Confirmed:
    wx: float
    wy: float
    t: float


class TrackNetDetectorV2:
    """
    TrackNet v2 — same ONNX model as TrackNetDetector with four additions:

    Fix A  Multi-peak NMS decoding instead of bare argmax.
    Fix B  Wall-proximity penalty when ranking surviving peaks.
    Fix C  Glass-wall heatmap mask (attenuates the beyond-y=20 region).
    Fix D  Camera-movement gate: skip inference when the camera pans/shakes.
    """

    def __init__(
        self,
        model_path: str,
        threshold: float = 0.5,
        nms_radius: int = 15,
        max_peaks: int = 3,
        wall_penalty_weight: float = 0.3,
        pred_weight: float = 0.3,
        pred_sigma_px: float = 150.0,
        glass_attenuation: float = 0.3,
        glass_wall_y: float = 20.0,
        cam_motion_threshold: int = 8,
        max_velocity_kmh: float = 250.0,
        H_inv: np.ndarray | None = None,
        court_margin_m: float = 0.5,
    ):
        self._session = ort.InferenceSession(
            model_path,
            providers=["CoreMLExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        self._input_name = self._session.get_inputs()[0].name

        self._threshold         = threshold
        self._nms_radius        = nms_radius
        self._max_peaks         = max_peaks
        self._wall_penalty_w    = wall_penalty_weight
        self._pred_weight       = pred_weight
        self._pred_sigma_px     = pred_sigma_px
        self._glass_attenuation = glass_attenuation
        self._glass_wall_y      = glass_wall_y
        self._cam_threshold     = cam_motion_threshold
        self._max_vel_kmh       = max_velocity_kmh
        self._court_margin      = court_margin_m

        self._H_inv = H_inv
        # H maps image pixels → world coords; H_inv maps world → pixels
        self._H: np.ndarray | None = np.linalg.inv(H_inv) if H_inv is not None else None

        self._buf: collections.deque[np.ndarray] = collections.deque(maxlen=3)
        self._prev_gray: np.ndarray | None = None
        self._glass_mask: np.ndarray | None = None   # built lazily on first frame
        self._confirmed: list[_Confirmed] = []

        log.debug("TrackNetV2 loaded: %s", model_path)

    # ── Public interface ────────────────────────────────────────────────────

    def detect(self, frame_bgr: np.ndarray) -> tuple[float, float] | None:
        src_h, src_w = frame_bgr.shape[:2]
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)

        # Fix D — camera motion gate (runs before inference)
        if self._prev_gray is not None:
            diff = cv2.absdiff(gray, self._prev_gray)
            if float(np.median(diff)) > self._cam_threshold:
                self._buf.clear()          # discard misaligned frames
                self._prev_gray = gray
                log.debug("camera moving — inference skipped")
                return None
        self._prev_gray = gray

        # Fix C — build glass mask once (needs frame dimensions)
        if self._glass_mask is None and self._H is not None:
            self._glass_mask = self._build_glass_mask(src_h, src_w)

        # Buffer frame
        self._buf.append(_preprocess(frame_bgr))
        if len(self._buf) < 3:
            return None

        # ONNX inference
        tensor = np.concatenate(list(self._buf), axis=0)[np.newaxis]  # (1,9,H,W)
        heatmap: np.ndarray = self._session.run(
            None, {self._input_name: tensor}
        )[0][0, 0]  # (MODEL_H, MODEL_W)

        # Fix C — attenuate beyond-glass pixels
        if self._glass_mask is not None:
            heatmap = heatmap.copy()
            heatmap[self._glass_mask] *= self._glass_attenuation

        # Fix A — NMS peak extraction
        peaks = self._nms_peaks(heatmap)
        if not peaks:
            return None

        # Fix B — rank by composite score, apply world-space filters
        pred_u, pred_v = self._predict_next_pixel()
        return self._rank_peaks(peaks, src_w, src_h, pred_u, pred_v)

    def confirm(self, court_x: float, court_y: float, time_s: float) -> None:
        self._confirmed.append(_Confirmed(wx=court_x, wy=court_y, t=time_s))
        if len(self._confirmed) > 2:
            self._confirmed.pop(0)

    def velocity_gate(self, court_x: float, court_y: float, time_s: float) -> bool:
        if not self._confirmed:
            return True
        prev = self._confirmed[-1]
        dt = time_s - prev.t
        if dt <= 0:
            return True
        if dt > _STALE_S:
            log.debug("stale (%.2f s) — resetting history", dt)
            self._confirmed.clear()
            return True
        implied = math.hypot(court_x - prev.wx, court_y - prev.wy) / dt * 3.6
        if implied > self._max_vel_kmh:
            log.debug("velocity gate: %.1f km/h — discarded", implied)
            return False
        return True

    def reset(self) -> None:
        self._buf.clear()
        self._prev_gray = None
        self._confirmed.clear()

    # ── Internal ────────────────────────────────────────────────────────────

    def _build_glass_mask(self, src_h: int, src_w: int) -> np.ndarray:
        """
        Boolean mask (MODEL_H × MODEL_W).
        True where projecting that heatmap pixel through H yields world y > glass_wall_y.
        Computed once; applied every frame by multiplying heatmap values by glass_attenuation.
        """
        H = self._H
        # Centre of each model pixel in original image coordinates
        cols = (np.arange(MODEL_W) + 0.5) / MODEL_W * src_w
        rows = (np.arange(MODEL_H) + 0.5) / MODEL_H * src_h
        U, V = np.meshgrid(cols, rows)                  # (MODEL_H, MODEL_W)
        denom   = H[2, 0] * U + H[2, 1] * V + H[2, 2]
        world_y = (H[1, 0] * U + H[1, 1] * V + H[1, 2]) / denom
        return world_y > self._glass_wall_y             # bool array

    def _nms_peaks(
        self, heatmap: np.ndarray
    ) -> list[tuple[int, int, float]]:
        """
        Non-maximum suppression on the heatmap.
        Returns up to max_peaks (row, col, confidence) sorted descending by confidence.
        """
        h, w = heatmap.shape
        order = np.argsort(heatmap.ravel())[::-1]
        visited = np.zeros((h, w), dtype=bool)
        peaks: list[tuple[int, int, float]] = []
        r = self._nms_radius

        for idx in order:
            conf = float(heatmap.flat[idx])
            if conf < self._threshold:
                break
            row, col = divmod(int(idx), w)
            if visited[row, col]:
                continue
            peaks.append((row, col, conf))
            # Suppress neighbourhood
            r0, r1 = max(0, row - r), min(h, row + r + 1)
            c0, c1 = max(0, col - r), min(w, col + r + 1)
            visited[r0:r1, c0:c1] = True
            if len(peaks) >= self._max_peaks:
                break

        return peaks

    def _rank_peaks(
        self,
        peaks: list[tuple[int, int, float]],
        src_w: int,
        src_h: int,
        pred_u: float | None,
        pred_v: float | None,
    ) -> tuple[float, float] | None:
        """
        Project each peak to world space, filter by court bounds, score, return best.
        Fix B applies the wall-proximity penalty here.
        """
        m = self._court_margin
        wall_band = 0.5   # metres — penalty zone near any court edge

        scored: list[tuple[float, float, float]] = []   # (score, u, v)
        for row, col, conf in peaks:
            u = (col + 0.5) / MODEL_W * src_w
            v = (row + 0.5) / MODEL_H * src_h

            x, y = self._project_to_world(u, v)

            # Court bounds filter (same as hg.in_court with margin)
            if not (-m <= x <= 10 + m and -m <= y <= 20 + m):
                continue

            # Fix B — wall proximity penalty
            dist_to_wall = min(x + m, (10 + m) - x, y + m, (20 + m) - y)
            penalty = max(0.0, 1.0 - dist_to_wall / wall_band) * self._wall_penalty_w

            # Trajectory prediction score
            if pred_u is not None and pred_v is not None:
                pred_score = math.exp(
                    -math.hypot(u - pred_u, v - pred_v) / self._pred_sigma_px
                )
            else:
                pred_score = 0.5

            score = conf - penalty + self._pred_weight * pred_score
            scored.append((score, u, v))

        if not scored:
            return None

        scored.sort(key=lambda s: -s[0])
        return scored[0][1], scored[0][2]

    def _project_to_world(self, u: float, v: float) -> tuple[float, float]:
        if self._H is None:
            return 5.0, 10.0
        p = self._H @ np.array([u, v, 1.0])
        return float(p[0] / p[2]), float(p[1] / p[2])

    def _predict_next_pixel(self) -> tuple[float | None, float | None]:
        """Extrapolate one step ahead in world space, project back to pixels."""
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


def _preprocess(frame_bgr: np.ndarray) -> np.ndarray:
    """Resize to MODEL_W×MODEL_H, return channel-first float32 RGB (3, H, W)."""
    resized = cv2.resize(frame_bgr, (MODEL_W, MODEL_H), interpolation=cv2.INTER_LINEAR)
    rgb = resized[:, :, ::-1].astype(np.float32) / 255.0
    return rgb.transpose(2, 0, 1)
