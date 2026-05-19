from __future__ import annotations

import math

from padel_engine.models.ball import BallFrame
from padel_engine.models.homography import Homography
from padel_engine.models.player import PlayerFrame
from padel_engine.models.touch_event import TouchEvent


class TouchDetector:
    # Default tunables — all overridable via constructor
    DEFAULT_PROXIMITY_M: float = 1.0
    DEFAULT_MIN_GAP_FRAMES: int = 6
    DEFAULT_MIN_CONFIDENCE: float = 0.2
    DEFAULT_DIRECTION_WINDOW: int = 3

    def __init__(
        self,
        homography: Homography,
        proximity_m: float = DEFAULT_PROXIMITY_M,
        min_gap_frames: int = DEFAULT_MIN_GAP_FRAMES,
        min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    ) -> None:
        self.homography = homography
        self.proximity_m = proximity_m
        self.min_gap_frames = min_gap_frames
        self.min_confidence = min_confidence

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def detect(
        self,
        ball_frames: dict[int, BallFrame],
        player_frames: dict[int, list[PlayerFrame]],
    ) -> list[TouchEvent]:
        """Return touch events sorted by time."""
        court_positions = self._project_ball(ball_frames)
        candidates = self._build_candidates(ball_frames, player_frames, court_positions)
        runs = self._group_runs(candidates)
        events = self._events_from_runs(runs, court_positions)
        return sorted(events, key=lambda e: e.time_s)

    # ------------------------------------------------------------------
    # Internal steps
    # ------------------------------------------------------------------

    def _project_ball(
        self, ball_frames: dict[int, BallFrame]
    ) -> dict[int, tuple[float, float]]:
        """Project visible ball pixels to court coords; skip out-of-bounds points."""
        court: dict[int, tuple[float, float]] = {}
        for frame, bf in ball_frames.items():
            if bf.visibility != "visible":
                continue
            cx, cy = self.homography.pixel_to_court(bf.pixel_x, bf.pixel_y)
            if not self.homography.is_in_court(cx, cy, margin=1.0):
                continue
            bf.court_x = cx
            bf.court_y = cy
            court[frame] = (cx, cy)
        return court

    def _build_candidates(
        self,
        ball_frames: dict[int, BallFrame],
        player_frames: dict[int, list[PlayerFrame]],
        court_positions: dict[int, tuple[float, float]],
    ) -> list[dict]:
        candidates = []
        for frame, (ball_cx, ball_cy) in sorted(court_positions.items()):
            bf = ball_frames[frame]
            if bf.play_state != "in_play":
                continue
            players = player_frames.get(frame, [])
            if not players:
                continue

            best_pf: PlayerFrame | None = None
            best_dist = math.inf
            for pf in players:
                d = math.hypot(ball_cx - pf.court_x, ball_cy - pf.court_y)
                if d < best_dist:
                    best_dist = d
                    best_pf = pf

            if best_dist <= self.proximity_m and best_pf is not None:
                candidates.append({
                    "frame": frame,
                    "time_s": bf.time_s,
                    "player_id": best_pf.player_id,
                    "distance": best_dist,
                    "player_conf": best_pf.confidence,
                    "side": best_pf.side,
                    "ball_cx": ball_cx,
                    "ball_cy": ball_cy,
                    "player_cx": best_pf.court_x,
                    "player_cy": best_pf.court_y,
                })
        return candidates

    def _group_runs(self, candidates: list[dict]) -> list[list[dict]]:
        """Group consecutive same-player candidates into runs."""
        if not candidates:
            return []
        runs: list[list[dict]] = []
        current: list[dict] = [candidates[0]]
        for prev, curr in zip(candidates, candidates[1:]):
            same = curr["player_id"] == prev["player_id"]
            close = curr["frame"] - prev["frame"] <= self.min_gap_frames
            if same and close:
                current.append(curr)
            else:
                runs.append(current)
                current = [curr]
        runs.append(current)
        return runs

    def _events_from_runs(
        self,
        runs: list[list[dict]],
        court_positions: dict[int, tuple[float, float]],
    ) -> list[TouchEvent]:
        events = []
        for run in runs:
            touch = min(run, key=lambda c: c["distance"])
            frame = touch["frame"]
            dir_change = self._direction_change(frame, court_positions)

            proximity_score = 1.0 - (touch["distance"] / self.proximity_m)
            dir_score = min(dir_change / 180.0, 1.0) if dir_change is not None else 0.0
            confidence = (
                0.5 * proximity_score
                + 0.3 * touch["player_conf"]
                + 0.2 * dir_score
            )
            if confidence < self.min_confidence:
                continue

            events.append(TouchEvent(
                frame=frame,
                time_s=touch["time_s"],
                player_id=touch["player_id"],
                side=touch["side"],
                ball_court_x=touch["ball_cx"],
                ball_court_y=touch["ball_cy"],
                player_court_x=touch["player_cx"],
                player_court_y=touch["player_cy"],
                distance_m=touch["distance"],
                direction_change_deg=dir_change,
                confidence=confidence,
            ))
        return events

    def _direction_change(
        self,
        frame: int,
        court_positions: dict[int, tuple[float, float]],
        window: int = DEFAULT_DIRECTION_WINDOW,
    ) -> float | None:
        sorted_frames = sorted(court_positions)
        idx_map = {f: i for i, f in enumerate(sorted_frames)}
        if frame not in idx_map:
            return None

        idx = idx_map[frame]
        before = sorted_frames[max(0, idx - window): idx]
        after = sorted_frames[idx + 1: idx + 1 + window]
        if not before or not after:
            return None

        cx, cy = court_positions[frame]
        bx, by = court_positions[before[0]]
        ax, ay = court_positions[after[-1]]

        vb = (cx - bx, cy - by)
        va = (ax - cx, ay - cy)
        lb, la = math.hypot(*vb), math.hypot(*va)
        if lb < 1e-6 or la < 1e-6:
            return None

        dot = max(-1.0, min(1.0, (vb[0] * va[0] + vb[1] * va[1]) / (lb * la)))
        return math.degrees(math.acos(dot))
