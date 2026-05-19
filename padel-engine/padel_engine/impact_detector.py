from __future__ import annotations

import math

from padel_engine.models.ball import BallFrame
from padel_engine.models.homography import Homography
from padel_engine.models.impact_event import BallImpactEvent
from padel_engine.models.motion import BallMotionFrame
from padel_engine.models.player import PlayerFrame

# Court boundary constants (metres)
_FENCE_MARGIN = 1.5     # y < this or y > (HEIGHT - this) → fence
_WALL_MARGIN = 0.7      # x < this or x > (WIDTH - this) → wall
_NET_MARGIN = 0.8       # |y - 10| < this → net


class BallImpactDetector:
    DEFAULT_MIN_ANGLE = 25.0
    DEFAULT_MIN_SPEED = 40.0
    DEFAULT_MERGE_GAP = 8
    DEFAULT_RACKET_DIST_M = 1.3
    DEFAULT_MIN_CONFIDENCE = 0.25

    def __init__(
        self,
        homography: Homography,
        min_angle: float = DEFAULT_MIN_ANGLE,
        min_speed: float = DEFAULT_MIN_SPEED,
        merge_gap: int = DEFAULT_MERGE_GAP,
        racket_dist_m: float = DEFAULT_RACKET_DIST_M,
        min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    ) -> None:
        self.homography = homography
        self.min_angle = min_angle
        self.min_speed = min_speed
        self.merge_gap = merge_gap
        self.racket_dist_m = racket_dist_m
        self.min_confidence = min_confidence

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def detect(
        self,
        motion: dict[int, BallMotionFrame],
        ball_frames: dict[int, BallFrame],
        player_frames: dict[int, list[PlayerFrame]],
    ) -> list[BallImpactEvent]:
        candidates = self._find_candidates(motion)
        clusters = self._merge_clusters(candidates)
        events = [
            self._build_event(cluster, motion, ball_frames, player_frames)
            for cluster in clusters
        ]
        return [e for e in events if e is not None and e.confidence >= self.min_confidence]

    # ------------------------------------------------------------------
    # Internal steps
    # ------------------------------------------------------------------

    def _find_candidates(self, motion: dict[int, BallMotionFrame]) -> list[dict]:
        """Frames where the velocity direction changes significantly."""
        sorted_frames = sorted(motion.keys())
        candidates = []
        for i in range(1, len(sorted_frames)):
            prev_f = sorted_frames[i - 1]
            curr_f = sorted_frames[i]
            prev_m = motion[prev_f]
            curr_m = motion[curr_f]

            if curr_m.speed_px_s < self.min_speed:
                continue

            dot = prev_m.vx_px * curr_m.vx_px + prev_m.vy_px * curr_m.vy_px
            lp = prev_m.speed_px_s
            lc = curr_m.speed_px_s
            if lp < 1.0 or lc < 1.0:
                continue

            cos_a = max(-1.0, min(1.0, dot / (lp * lc)))
            angle = math.degrees(math.acos(cos_a))

            if angle >= self.min_angle:
                candidates.append({
                    "frame": curr_f,
                    "angle": angle,
                    "speed_before": prev_m.speed_px_s,
                    "speed_after": curr_m.speed_px_s,
                })
        return candidates

    def _merge_clusters(self, candidates: list[dict]) -> list[list[dict]]:
        """Group candidates within merge_gap frames; keep max-angle per cluster."""
        if not candidates:
            return []
        clusters: list[list[dict]] = []
        cluster: list[dict] = [candidates[0]]
        for prev, curr in zip(candidates, candidates[1:]):
            if curr["frame"] - prev["frame"] <= self.merge_gap:
                cluster.append(curr)
            else:
                clusters.append(cluster)
                cluster = [curr]
        clusters.append(cluster)
        # Return each cluster with max-angle candidate first
        return [[max(c, key=lambda x: x["angle"])] for c in clusters]

    def _build_event(
        self,
        cluster: list[dict],
        motion: dict[int, BallMotionFrame],
        ball_frames: dict[int, BallFrame],
        player_frames: dict[int, list[PlayerFrame]],
    ) -> BallImpactEvent | None:
        best = cluster[0]
        frame = best["frame"]
        bf = ball_frames.get(frame)
        mf = motion.get(frame)
        if bf is None or mf is None:
            return None

        # Court projection (use smoothed position for more stable classification)
        court_x = court_y = None
        try:
            cx, cy = self.homography.pixel_to_court(mf.smooth_px, mf.smooth_py)
            if self.homography.is_in_court(cx, cy, margin=1.0):
                court_x, court_y = cx, cy
        except Exception:
            pass

        # Nearest player
        nearest_id = nearest_dist = None
        players = player_frames.get(frame, [])
        if players and court_x is not None:
            for pf in players:
                d = math.hypot(court_x - pf.court_x, court_y - pf.court_y)
                if nearest_dist is None or d < nearest_dist:
                    nearest_dist = d
                    nearest_id = pf.player_id

        # Surface classification
        surface = self._classify_surface(court_x, court_y, nearest_dist)

        # Speed change ratio
        ratio = best["speed_after"] / max(best["speed_before"], 1.0)

        # Confidence
        angle_score = min(best["angle"] / 180.0, 1.0)
        speed_score = min(best["speed_after"] / 300.0, 1.0)
        change_score = max(0.0, 1.0 - abs(1.0 - ratio) / 2.0)
        confidence = 0.5 * angle_score + 0.3 * speed_score + 0.2 * change_score

        return BallImpactEvent(
            frame=frame,
            time_s=bf.time_s,
            pixel_x=bf.pixel_x,
            pixel_y=bf.pixel_y,
            court_x=court_x,
            court_y=court_y,
            direction_change_deg=best["angle"],
            speed_before_px_s=best["speed_before"],
            speed_after_px_s=best["speed_after"],
            speed_change_ratio=ratio,
            surface=surface,
            nearest_player_id=nearest_id,
            nearest_player_dist_m=nearest_dist,
            confidence=confidence,
        )

    @staticmethod
    def _classify_surface(
        court_x: float | None,
        court_y: float | None,
        nearest_player_dist: float | None,
    ) -> str:
        if court_x is None or court_y is None:
            return "unknown"
        W = Homography.COURT_WIDTH_M
        H = Homography.COURT_HEIGHT_M
        if nearest_player_dist is not None and nearest_player_dist < BallImpactDetector.DEFAULT_RACKET_DIST_M:
            return "racket"
        if court_y < _FENCE_MARGIN or court_y > H - _FENCE_MARGIN:
            return "fence"
        if court_x < _WALL_MARGIN or court_x > W - _WALL_MARGIN:
            return "wall"
        if abs(court_y - H / 2) < _NET_MARGIN:
            return "net"
        return "floor"
