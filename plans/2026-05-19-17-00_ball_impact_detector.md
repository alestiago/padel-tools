# Ball Impact Detector — padel-engine

**Date:** 2026-05-19  
**Status:** Draft

---

## Goal

Detect every moment the ball impacts a surface (floor, racket, glass wall, back
fence, net) by analysing the ball's velocity history.  Output a CSV of impact
events with surface classification and confidence, and render a visual overlay
on the video.

---

## Empirical baseline (jugada1, 18 s, 30 fps)

Raw direction changes > 20°: **117** — far too many to be real impacts.  
Root causes discovered from the data:

| Cause | Signature |
|---|---|
| Label jitter (adjacent visible frames ~1 px apart) | Small angle (20–45°) at very low speed |
| Ball in the air — H matrix only maps the ground plane | Court projection lands far outside bounds, e.g. (32, −65) |
| Actual impact (bounce/hit) | Large angle (> 60°) at valid court position; often a single isolated spike |

After grouping + noise filtering, we expect **8–15** real impacts for this clip
(one every ~1–2 s, consistent with rally cadence).

---

## New models (`padel_engine/models/`)

### `motion.py` — `BallMotionFrame`

Computed velocity at each visible frame.  Stored **in pixel space** (reliable)
and optionally in court space (only valid when the ball is on or near the ground
plane).

```python
@dataclass
class BallMotionFrame:
    frame: int
    time_s: float
    # pixel-space velocity (always present when computable)
    vx_px: float
    vy_px: float
    speed_px_s: float
    direction_deg: float        # atan2(vy_px, vx_px), degrees, 0 = rightward
    # court-space velocity (None when projection is out of bounds)
    vx_m_s: float | None
    vy_m_s: float | None
    speed_m_s: float | None
```

### `impact_event.py` — `BallImpactEvent`

```python
@dataclass
class BallImpactEvent:
    frame: int
    time_s: float
    pixel_x: float
    pixel_y: float
    court_x: float | None       # None when ball is in the air / out of bounds
    court_y: float | None
    direction_change_deg: float # angle between smoothed velocity before and after
    speed_before_px_s: float
    speed_after_px_s: float
    speed_change_ratio: float   # speed_after / speed_before
    surface: str                # see classification table below
    nearest_player_id: int | None
    nearest_player_dist_px: float | None
    confidence: float           # ∈ [0, 1]
```

**Surface labels:**

| Value | Meaning |
|---|---|
| `floor` | Mid-court bounce, ball on ground plane |
| `racket` | Ball within racket reach of a player |
| `wall` | Side glass wall (x ≈ 0 or x ≈ 10 m) |
| `fence` | Back fence / wall (y ≈ 0 or y ≈ 20 m) |
| `net` | Net area (y ≈ 10 m) |
| `unknown` | Court projection out of bounds — ball likely in the air or near glass |

---

## New detector classes

### `BallMotionDetector` (`padel_engine/motion_detector.py`)

**Input:** `dict[int, BallFrame]`, `Homography`  
**Output:** `dict[int, BallMotionFrame]`

**Steps:**

1. **Smooth positions** — apply Gaussian smooth (σ = 1.5 frames, reflect-padded,
   same helper as `overlay_trail.py`) to the x/y sequence of all visible frames.
   This reduces label jitter while preserving the sharp position changes that
   correspond to real impacts.

2. **Compute velocity** — for each consecutive pair of smoothed visible frames
   with `dt ≤ MAX_FRAME_GAP / fps` (default MAX_FRAME_GAP = 4):
   ```
   vx = (x[i+1] − x[i]) / dt
   vy = (y[i+1] − y[i]) / dt
   ```
   Assign the velocity to frame `i` (backward difference) or
   average `(i−1, i)` and `(i, i+1)` for a centred estimate.  Centred is
   preferred because it aligns the velocity with the position it describes.

3. **Court velocity** — if the smoothed position projects within court bounds
   (+ 0.5 m margin), also compute vx_m_s / vy_m_s using the court-space
   position differences.

4. **Return** `BallMotionFrame` for every visible frame that has a valid centred
   velocity estimate.

---

### `BallImpactDetector` (`padel_engine/impact_detector.py`)

**Input:** `dict[int, BallMotionFrame]`, `dict[int, BallFrame]`,
`dict[int, list[PlayerFrame]]`, `Homography`  
**Output:** `list[BallImpactEvent]`

#### Algorithm

**Step 1 — candidate detection**

For each consecutive pair of motion frames (i, i+1) with a valid centred
velocity on both sides:

```
angle = degrees(acos(dot(v_i, v_{i+1}) / (|v_i| * |v_{i+1}|)))
```

A frame is a **candidate** when ALL of:
- `angle ≥ MIN_ANGLE_DEG` (default **25°**)
- `speed_i ≥ MIN_SPEED_PX_S` (default **40 px/s**) — ignore near-stationary ball
- time gap to previous visible frame ≤ `MAX_FRAME_GAP` frames — no stale velocity

**Step 2 — group and de-duplicate**

Consecutive candidate frames within `MERGE_GAP_FRAMES` (default **8**) frames
are merged into a single cluster.  Within each cluster the frame with the
**maximum direction change angle** is the impact moment.

This collapses the "clusters of 4–6 noisy frames" seen in the raw data into
single events.

**Step 3 — surface classification**

Classification runs in priority order on the impact frame's court position:

```
1. court valid AND nearest_player_dist < RACKET_DIST_M (1.3)  → "racket"
2. court valid AND (y < 1.5 OR y > 18.5)                     → "fence"
3. court valid AND (x < 0.7 OR x > 9.3)                      → "wall"
4. court valid AND |y − 10| < 0.8                             → "net"
5. court valid                                                 → "floor"
6. court invalid                                               → "unknown"
```

Nearest-player distance is computed in pixel space when the court projection is
invalid; in court space (metres) otherwise.

**Step 4 — confidence scoring**

```
angle_score  = min(direction_change_deg / 180, 1.0)
speed_score  = min(speed_before / 300, 1.0)           # 300 px/s = full score
change_score = 1.0 − |1.0 − speed_change_ratio| / 2  # penalise bizarre ratios

confidence = 0.5 × angle_score + 0.3 × speed_score + 0.2 × change_score
```

Discard events with `confidence < MIN_CONFIDENCE` (default **0.25**).

---

## Project additions

```
padel-engine/
└── padel_engine/
    ├── models/
    │   ├── motion.py          # BallMotionFrame  (new)
    │   └── impact_event.py    # BallImpactEvent  (new)
    ├── motion_detector.py     # BallMotionDetector  (new)
    └── impact_detector.py     # BallImpactDetector  (new)
```

`models/__init__.py` and `padel_engine/__init__.py` export the new types.

---

## CLI tool (`padel-engine/tools/detect_impacts.py`)

```
python3 padel-engine/tools/detect_impacts.py \
    --ball-labels  .dev/jugada1/jugada1_labels.csv \
    --players      .dev/jugada1/players.csv \
    --homography   .dev/homography_padel_recording_xs.json \
    --output       .dev/jugada1/impacts.csv \
    [--min-angle   25]          \
    [--min-speed   40]          \
    [--merge-gap   8]           \
    [--proximity   1.3]
```

**Output CSV** (`impacts.csv`) — one row per impact event:

| Column | Type | Notes |
|---|---|---|
| `frame` | int | |
| `time_s` | float | |
| `pixel_x` | float | Ball position (raw, not smoothed) |
| `pixel_y` | float | |
| `court_x_m` | float | Empty when projection invalid |
| `court_y_m` | float | |
| `direction_change_deg` | float | |
| `speed_before_px_s` | float | |
| `speed_after_px_s` | float | |
| `speed_change_ratio` | float | after / before |
| `surface` | str | floor / racket / wall / fence / net / unknown |
| `nearest_player_id` | int | Empty when no players in frame |
| `nearest_player_dist_m` | float | |
| `confidence` | float | |

Prints a human-readable summary: total impacts, breakdown by surface, mean
confidence.

---

## Overlay tool (`tools/impact_overlay.py`)

```
python3 tools/impact_overlay.py \
    --video       .dev/jugada1/jugada1.mp4 \
    --impacts     .dev/jugada1/impacts.csv \
    --output      .dev/jugada1/jugada1_impacts.mp4 \
    [--hold-frames 35]
```

### Visual design

Each surface type gets its own marker style and colour palette, drawn at the
ball's **pixel position** at the impact frame and held for `--hold-frames`
frames with a fade-out.

| Surface | Shape | Colour (BGR) |
|---|---|---|
| `floor` | Expanding filled splash + 2 ripple rings | `(0, 200, 255)` orange-yellow |
| `racket` | 6-pointed star burst | Player colour (same as overlay_touch) |
| `wall` | Square corner brackets | `(255, 220, 50)` cyan |
| `fence` | Diamond (rotated square) | `(50, 50, 255)` red |
| `net` | Horizontal bar + X | `(200, 200, 200)` grey |
| `unknown` | Small cross / dot | `(120, 120, 120)` dark grey |

A small floating label (e.g. `floor 0.82`) appears for 20 frames at the impact
site.  At age 0 the marker is full-intensity; it fades linearly to zero over
`hold_frames`.

**Corner HUD** (top-right): running impact count by surface — updated live as
impacts are revealed.

---

## Implementation order

1. `models/motion.py` — `BallMotionFrame` dataclass
2. `models/impact_event.py` — `BallImpactEvent` dataclass  
3. Update `models/__init__.py`
4. `motion_detector.py` — smoothing + centred velocity
5. `impact_detector.py` — grouping, classification, confidence
6. `tools/detect_impacts.py` — CLI + CSV writer
7. Validate on jugada1: expect 8–15 impacts, no court-OOB events surviving
8. `tools/impact_overlay.py` — surface-specific marker rendering

---

## Open questions / risks

- **Smoothing sigma trade-off**: σ = 1.5 reduces most jitter but a very fast
  impact (ball changes direction in 1 frame) may have its angle damped.  Expose
  `--smooth-sigma` as a CLI flag.

- **Ball-in-air projections**: direction changes while the ball is airborne are
  not impacts; they are label noise.  The out-of-bounds projection filter
  catches most of these, but won't catch cases where the ball is at low height
  near mid-court.  The `MIN_SPEED` threshold helps (airborne ball tends to be
  faster than ground-bounce ball).

- **Homography mismatch**: same caveat as in the last-touch plan — the H matrix
  is from a different recording.  Surface classification is unreliable for
  impacts that project out of bounds.  Short-term mitigation: label those events
  as `unknown`.

- **No floor vs racket disambiguation without player data**: if players CSV is
  absent, all mid-court in-bounds impacts default to `floor`.  Providing
  `--players` improves racket classification.
