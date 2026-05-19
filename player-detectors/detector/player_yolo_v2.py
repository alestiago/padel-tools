import logging
import math
from dataclasses import dataclass

import cv2
import numpy as np

from .player_yolo import PlayerDetection

log = logging.getLogger(__name__)

_NET_Y_M = 10.0
_CROP_PAD = 30


@dataclass
class _Raw:
    conf: float
    x1: float; y1: float; x2: float; y2: float
    foot_u: float; foot_v: float
    cx: float; cy: float
    side: str


@dataclass
class _Slot:
    player_id: int
    side: str            # fixed for the lifetime of this slot
    cx: float = 0.0
    cy: float = 0.0
    vx: float = 0.0      # EMA velocity (m / frame)
    vy: float = 0.0
    missed: int = 0
    initialized: bool = False
    last_x1: float = 0.0  # last detected bbox (original-frame pixels)
    last_y1: float = 0.0
    last_x2: float = 100.0
    last_y2: float = 200.0
    last_foot_u: float = 0.0
    last_foot_v: float = 0.0


class PlayerYoloDetectorV2:
    """
    v2 improvements over v1:
      Fix A  Near-court tiled crop — zooms the far-corner region ~3× before
             running a second YOLO pass (turns 13 px players into ~40 px).
      Fix B  Adaptive confidence threshold — lower threshold (0.25) for the crop.
      Fix C  Higher global resolution — imgsz=1280 for the full-frame pass.
      Fix D  World-space NMS — deduplicates results from both passes.
      Fix E  Stateful 4-slot tracker with velocity extrapolation and occlusion
             labelling — fills gaps when a player is temporarily hidden.
    """

    def __init__(
        self,
        model_path: str,
        threshold: float = 0.4,
        H: np.ndarray | None = None,
        court_margin_m: float = 0.5,
        imgsz: int = 1280,
        crop_imgsz: int = 640,
        crop_threshold: float = 0.25,
        near_court_y_max: float = 10.0,
        world_nms_dist_m: float = 1.0,
        extrap_frames: int = 15,
        stale_frames: int = 60,
        velocity_alpha: float = 0.3,
        assign_dist_m: float = 3.0,
    ):
        from ultralytics import YOLO
        self._model = YOLO(model_path)
        self._threshold = threshold
        self._H = H
        self._H_inv = np.linalg.inv(H) if H is not None else None
        self._court_margin = court_margin_m
        self._imgsz = imgsz
        self._crop_imgsz = crop_imgsz
        self._crop_threshold = crop_threshold
        self._near_y_max = near_court_y_max
        self._nms_dist = world_nms_dist_m
        self._extrap_frames = extrap_frames
        self._stale_frames = stale_frames
        self._alpha = velocity_alpha
        self._assign_dist = assign_dist_m

        self._crop_bounds: tuple[int, int, int, int] | None = None
        self._last_shape: tuple[int, int] | None = None

        # Slots: 1,2 = near side; 3,4 = far side (IDs are fixed)
        self._near_slots = [_Slot(player_id=1, side="near"),
                            _Slot(player_id=2, side="near")]
        self._far_slots  = [_Slot(player_id=3, side="far"),
                            _Slot(player_id=4, side="far")]

    # ── Public interface ─────────────────────────────────────────────────────

    def detect(self, frame_bgr: np.ndarray) -> list[PlayerDetection]:
        src_h, src_w = frame_bgr.shape[:2]

        raw = self._pass_full(frame_bgr)
        raw += self._pass_near_crop(frame_bgr, src_h, src_w)
        raw = self._world_nms(raw)

        m = self._court_margin
        raw = [r for r in raw if -m <= r.cx <= 10 + m and -m <= r.cy <= 20 + m]

        near_dets = sorted([r for r in raw if r.side == "near"], key=lambda r: r.cx)
        far_dets  = sorted([r for r in raw if r.side == "far"],  key=lambda r: r.cx)

        results  = self._match_and_update(self._near_slots, near_dets)
        results += self._match_and_update(self._far_slots,  far_dets)
        return results

    # ── Tracker ──────────────────────────────────────────────────────────────

    def _match_and_update(
        self, slots: list[_Slot], dets: list[_Raw]
    ) -> list[PlayerDetection]:
        used: set[int] = set()
        assignments: dict[int, int] = {}   # slot_idx → det_idx

        # Greedy nearest-neighbour for already-initialized slots
        for si, slot in enumerate(slots):
            if not slot.initialized:
                continue
            best_di, best_d = None, self._assign_dist
            for di, det in enumerate(dets):
                if di in used:
                    continue
                d = math.hypot(det.cx - slot.cx, det.cy - slot.cy)
                if d < best_d:
                    best_d, best_di = d, di
            if best_di is not None:
                assignments[si] = best_di
                used.add(best_di)

        # Assign remaining detections to uninitialized slots (sorted by cx)
        unmatched = sorted([i for i in range(len(dets)) if i not in used],
                           key=lambda i: dets[i].cx)
        uninit = [si for si, s in enumerate(slots) if not s.initialized]
        for si, di in zip(uninit, unmatched):
            assignments[si] = di

        results: list[PlayerDetection] = []
        for si, slot in enumerate(slots):
            if si in assignments:
                det = dets[assignments[si]]
                if slot.initialized:
                    slot.vx = self._alpha * (det.cx - slot.cx) + (1 - self._alpha) * slot.vx
                    slot.vy = self._alpha * (det.cy - slot.cy) + (1 - self._alpha) * slot.vy
                else:
                    slot.vx = slot.vy = 0.0
                slot.cx, slot.cy = det.cx, det.cy
                slot.missed = 0
                slot.initialized = True
                slot.last_x1, slot.last_y1 = det.x1, det.y1
                slot.last_x2, slot.last_y2 = det.x2, det.y2
                slot.last_foot_u, slot.last_foot_v = det.foot_u, det.foot_v
                status = "detected"
                conf = det.conf
                x1, y1, x2, y2 = det.x1, det.y1, det.x2, det.y2
                fu, fv = det.foot_u, det.foot_v

            elif slot.initialized:
                slot.missed += 1
                if slot.missed <= self._extrap_frames:
                    slot.cx += slot.vx
                    slot.cy += slot.vy
                    status = "extrapolated"
                elif slot.missed <= self._stale_frames:
                    status = "occluded"
                else:
                    slot.initialized = False
                    continue  # lost — emit no row
                conf = 0.0
                x1, y1, x2, y2, fu, fv = self._estimated_bbox(slot)

            else:
                continue  # not yet initialized and no detection this frame

            results.append(PlayerDetection(
                player_id=slot.player_id,
                pixel_u=fu, pixel_v=fv,
                court_x_m=slot.cx, court_y_m=slot.cy,
                side=slot.side, confidence=conf,
                bbox_x1=x1, bbox_y1=y1, bbox_x2=x2, bbox_y2=y2,
                status=status,
            ))

        return results

    def _estimated_bbox(
        self, slot: _Slot
    ) -> tuple[float, float, float, float, float, float]:
        """Project current world position back to pixel space; use last bbox dims."""
        if self._H_inv is not None:
            p = self._H_inv @ np.array([slot.cx, slot.cy, 1.0])
            w = float(p[2])
            if abs(w) > 1e-9:
                fu = float(p[0] / w)
                fv = float(p[1] / w)
                bw = slot.last_x2 - slot.last_x1
                bh = slot.last_y2 - slot.last_y1
                return fu - bw / 2, fv - bh, fu + bw / 2, fv, fu, fv
        return (slot.last_x1, slot.last_y1, slot.last_x2, slot.last_y2,
                slot.last_foot_u, slot.last_foot_v)

    # ── YOLO passes ──────────────────────────────────────────────────────────

    def _pass_full(self, frame_bgr: np.ndarray) -> list[_Raw]:
        results = self._model.predict(
            frame_bgr, classes=[0], conf=self._threshold,
            imgsz=self._imgsz, verbose=False,
        )[0]
        return self._extract(results)

    def _pass_near_crop(
        self, frame_bgr: np.ndarray, src_h: int, src_w: int
    ) -> list[_Raw]:
        bounds = self._near_crop_bounds(src_h, src_w)
        if bounds is None:
            return []
        cx1, cy1, cx2, cy2 = bounds
        cw, ch = cx2 - cx1, cy2 - cy1

        crop = frame_bgr[cy1:cy2, cx1:cx2]
        resized = cv2.resize(crop, (self._crop_imgsz, self._crop_imgsz),
                             interpolation=cv2.INTER_LINEAR)
        results = self._model.predict(
            resized, classes=[0], conf=self._crop_threshold,
            imgsz=self._crop_imgsz, verbose=False,
        )[0]

        if results.boxes is None or len(results.boxes) == 0:
            return []

        sx, sy = cw / self._crop_imgsz, ch / self._crop_imgsz
        raw: list[_Raw] = []
        for box in results.boxes:
            conf = float(box.conf[0])
            bx1, by1, bx2, by2 = (float(v) for v in box.xyxy[0])
            x1, x2 = cx1 + bx1 * sx, cx1 + bx2 * sx
            y1, y2 = cy1 + by1 * sy, cy1 + by2 * sy
            foot_u, foot_v = (x1 + x2) / 2, y2
            cx, cy = self._project(foot_u, foot_v)
            side = "near" if cy < _NET_Y_M else "far"
            raw.append(_Raw(conf, x1, y1, x2, y2, foot_u, foot_v, cx, cy, side))
        return raw

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _near_crop_bounds(self, src_h: int, src_w: int) -> tuple[int, int, int, int] | None:
        if self._H_inv is None:
            return None
        if self._last_shape == (src_h, src_w) and self._crop_bounds is not None:
            return self._crop_bounds

        m = self._court_margin
        corners = [(-m, -m), (10 + m, -m),
                   (10 + m, self._near_y_max + m), (-m, self._near_y_max + m)]
        us, vs = [], []
        for wx, wy in corners:
            p = self._H_inv @ np.array([wx, wy, 1.0])
            if abs(p[2]) < 1e-9:
                continue
            us.append(p[0] / p[2])
            vs.append(p[1] / p[2])

        if not us:
            return None

        x1 = max(0, int(min(us)) - _CROP_PAD)
        y1 = max(0, int(min(vs)) - _CROP_PAD)
        x2 = min(src_w, int(max(us)) + _CROP_PAD)
        y2 = min(src_h, int(max(vs)) + _CROP_PAD)

        if x2 <= x1 or y2 <= y1:
            return None

        self._crop_bounds = (x1, y1, x2, y2)
        self._last_shape = (src_h, src_w)
        log.debug("near-court crop: (%d,%d)→(%d,%d) %dx%d", x1, y1, x2, y2, x2-x1, y2-y1)
        return self._crop_bounds

    def _extract(self, results) -> list[_Raw]:
        raw: list[_Raw] = []
        if results.boxes is None or len(results.boxes) == 0:
            return raw
        for box in results.boxes:
            conf = float(box.conf[0])
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
            foot_u, foot_v = (x1 + x2) / 2, y2
            cx, cy = self._project(foot_u, foot_v)
            side = "near" if cy < _NET_Y_M else "far"
            raw.append(_Raw(conf, x1, y1, x2, y2, foot_u, foot_v, cx, cy, side))
        return raw

    def _project(self, u: float, v: float) -> tuple[float, float]:
        if self._H is None:
            return 5.0, 10.0
        p = self._H @ np.array([u, v, 1.0])
        return float(p[0] / p[2]), float(p[1] / p[2])

    def _world_nms(self, raw: list[_Raw]) -> list[_Raw]:
        kept: list[_Raw] = []
        for r in sorted(raw, key=lambda x: -x.conf):
            if not any(math.hypot(r.cx - k.cx, r.cy - k.cy) < self._nms_dist
                       for k in kept):
                kept.append(r)
        return kept
