# Plan — handling player occlusion in player_yolo_v2

## Problem statement

In `padel_recording_xs.mp4`, v2 detects only 3 players in **20.5 % of frames**
(254 / 1237). There are always exactly 4 players on a padel court — the missing
detection is a player temporarily hidden behind another player (from the camera's
perspective). The current detector returns nothing for that player in those frames,
leaving a gap in the CSV that breaks downstream analysis (position heatmaps,
coverage stats, etc.).

The goal is to:
1. Fill those gaps with a plausible position estimate.
2. Tag each row with a `status` field so consumers know whether the position was
   directly observed (`detected`) or inferred (`occluded`).

---

## Domain constraints (simplify the problem significantly)

- **Exactly 4 players** at all times — 2 near side, 2 far side.
- Players almost never cross to the other side of the net during a rally.
- Player speed is bounded (~10 m/s max sprint → ~0.33 m per frame at 30 fps).
- The camera is fixed; homography does not change mid-clip.

These constraints make the tracking problem much more tractable than general
multi-person tracking in unconstrained scenes.

---

## Approaches

### Approach A — Last-known-position hold (simplest)

Maintain 4 persistent slots (near-left, near-right, far-left, far-right).
Each frame:
1. Run detection (as now).
2. Assign detections to slots by nearest world-space distance.
3. For any slot with no match: carry forward its last known `(cx, cy)` and write
   a row with `status = occluded`.
4. After `stale_frames` (e.g. 30 = 1 s) without a match, mark the slot `lost`.

**Pros:** Trivial to implement; zero extra inference cost.  
**Cons:** Position becomes stale during long occlusions (player keeps moving while
we hold the old position). Acceptable for typical padel occlusions which last
< 0.5 s (< 15 frames).

---

### Approach B — Velocity extrapolation (dead reckoning)

Same as A, but instead of holding the last position, extrapolate it forward using
the player's recent velocity:

```
velocity = EMA(Δworld_pos / Δframe, alpha=0.3)
predicted_pos = last_pos + velocity * frames_since_last_detection
```

Mark extrapolated rows `status = extrapolated` to distinguish them from strict
position-holds.

**Pros:** More accurate position estimate during movement; works well for short
gaps (< 15 frames) where velocity is stable.  
**Cons:** Errors compound over longer gaps; no correction signal during occlusion.
Also requires two additional fields in the CSV (`velocity_x`, `velocity_y`) if
consumers want them — or can be internal only.

---

### Approach C — Kalman filter tracker

Classic multi-object tracking: each of the 4 slots is a Kalman filter with state
`[cx, cy, vx, vy]`. Predict step runs every frame (with or without a detection);
update step runs when a detection is assigned.

**Pros:** Theoretically optimal under Gaussian noise; handles acceleration by
updating the velocity estimate; well-understood.  
**Cons:** Adds code complexity (either a library like `filterpy` or a manual 4×4
Kalman implementation). For the gap sizes we see (< 15 frames), the improvement
over Approach B is marginal in practice.

---

### Approach D — Bbox size heuristic for merged detections

When 3 bboxes are detected but one is unusually wide or tall (two players merged
into one YOLO detection), split the oversized bbox and assign two slots to it.

**Pros:** Recovers the actual pixel position of the occluded player when they are
only partially hidden.  
**Cons:** YOLO v8/11 typically separates overlapping people already; a merged
bbox is uncommon. Splitting a bbox is heuristic and error-prone (where exactly
do you split?). High implementation effort for limited benefit.

---

### Approach E — Re-ID appearance matching

Extract a lightweight appearance embedding (e.g. from the YOLO feature map or a
small re-ID model) for each player each frame. Use cosine similarity to re-identify
players after an occlusion without relying on position alone.

**Pros:** Handles long occlusions robustly; can re-identify a player who reappears
on a different part of the court.  
**Cons:** Requires an additional model (or custom feature extraction); significant
added complexity; overkill for a fixed-camera padel scene where position alone is
already a strong identifier (players stay on their side).

---

## Conclusion

**Implement Approach B (velocity extrapolation) with a fallback to Approach A
(position hold) after N extrapolation frames.**

Reasons:
- Padel occlusions are short (typical rally contact < 0.5 s = 15 frames at 30
  fps). Approach B is accurate enough for this window.
- Re-ID (Approach E) and Kalman (Approach C) add disproportionate complexity for
  the benefit gained.
- Bbox splitting (Approach D) addresses a different failure mode (merge, not
  occlusion) and is rarely triggered in practice.
- Combining A + B is the minimum-viable solution that makes position heatmaps and
  coverage stats continuous.

**Stale policy:**
- `detected`: position from YOLO in this frame.
- `extrapolated`: velocity-extrapolated position (< `extrap_frames`, default 15).
- `occluded`: position-hold, velocity too stale to trust (15 – `stale_frames`,
  default 60 = 2 s).
- `lost`: no detection for > `stale_frames`; slot reset.

---

## Implementation plan

### Changes to `detector/player_yolo_v2.py`

Add a **4-slot stateful tracker** inside `PlayerYoloDetectorV2`:

```python
@dataclass
class _Slot:
    player_id: int       # 1–4, fixed
    cx: float            # last world x
    cy: float            # last world y
    side: str            # "near" | "far"  (fixed per slot)
    vx: float = 0.0      # EMA velocity x (m/frame)
    vy: float = 0.0      # EMA velocity y (m/frame)
    missed: int = 0      # consecutive frames without detection
```

`detect()` updated flow:
```
1. Run YOLO (full frame + near-court crop) → raw detections
2. World NMS + court-bounds filter (as now)
3. Greedy nearest-neighbour assignment of detections → slots
   (only assign across sides: near detections → near slots, far → far slots)
4. For matched slots:
   - Update EMA velocity, reset missed = 0
   - status = "detected"
5. For unmatched slots:
   - missed += 1
   - if missed <= EXTRAP_FRAMES:
       cx += vx; cy += vy
       status = "extrapolated"
   - elif missed <= STALE_FRAMES:
       status = "occluded"   (position held, no extrapolation)
   - else:
       status = "lost"
6. Return PlayerDetection for all 4 slots (including non-detected ones)
```

### CSV changes

Add one column: **`status`**  
Values: `detected` | `extrapolated` | `occluded` | `lost`

The `confidence` column is set to `0.0` for non-detected rows.

### `player_main.py`

No changes needed beyond accepting the new `status` field in the CSV writer
(already dynamic via `_CSV_FIELDS`).

### `tools/overlay_players.py`

Render non-detected players with a **dashed/translucent bounding box** and an
italic label so the viewer can distinguish observed from inferred positions.
OpenCV does not support dashed lines natively, but a stippled rectangle (drawing
segments manually) is straightforward.

---

## Parameters

| Param | Default | Meaning |
|---|---|---|
| `extrap_frames` | 15 | Frames to trust velocity extrapolation |
| `stale_frames` | 60 | Frames before a slot is marked `lost` |
| `velocity_alpha` | 0.3 | EMA smoothing factor for velocity |
| `assign_dist_m` | 3.0 | Max world distance to match a detection to a slot |
