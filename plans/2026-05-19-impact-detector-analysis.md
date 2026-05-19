# Impact Detector — Failure Analysis & Improvement Plan

**Date:** 2026-05-19  
**Ground truth:** `.dev/jugada1/jugada1_labels_v2.csv` (27 human-labelled impacts)  
**Baseline:** `padel-engine` impact detector on `jugada1.mp4` (14 detections)  
**Tolerance for frame matching:** ±5 frames (human labels have ~1-2 frame error margin)

---

## Baseline Metrics

| Metric | Value |
|---|---|
| Human-labelled impacts | 27 |
| Engine detections | 14 |
| Frame matches (±5 frames) | 12 / 27 = **44%** recall |
| Correct surface of matches | 5 / 12 = **42%** surface accuracy |
| False positives | 2 |

Effective end-to-end accuracy (frame + surface both correct): **5 / 27 = 19%**.

---

## Match Detail

| Human | Engine | Δ frames | Human surface | Engine surface | Surface OK |
|---|---|---|---|---|---|
| 6 | 7 | +1 | floor | floor | ✓ |
| 44 | 44 | 0 | floor | floor | ✓ |
| 74 | 74 | 0 | racket | **floor** | ✗ |
| 107 | 108 | +1 | floor | **racket** | ✗ |
| 147 | 148 | +1 | floor | floor | ✓ |
| 222 | 224 | +2 | wall | **fence** | ✗ |
| 288 | 290 | +2 | floor | floor | ✓ |
| 302 | 300 | +2 | racket | **floor** | ✗ |
| 366 | 370 | +4 | floor | floor | ✓ |
| 406 | 411 | +5 | floor | **wall** | ✗ |
| 427 | 429 | +2 | wall | **floor** | ✗ |
| 472 | 473 | +1 | wall | **unknown** | ✗ |

---

## Failure Points

### F1 — Racket impacts are almost entirely missed (12 / 15 false negatives)

Of the 15 missed impacts, 12 are racket hits. The engine detected only 1 racket impact correctly (racket at frame 302 was matched but classified as floor).

**Root causes:**
- Racket hits are softer touches with smaller direction changes. The `MIN_ANGLE = 25°` and `MIN_SPEED = 40 px/s` thresholds were tuned for hard bounces and filter out a large fraction of racket events.
- Gaussian smoothing (σ=1.5) with a 4-frame velocity kernel attenuates sharp direction changes caused by racket contact; by the time the smoothed trajectory is analysed the angular shift has been smeared across several frames.
- Racket classification depends on player proximity (`RACKET_DIST_M = 1.3 m`), but the player detector is noisy and the player may not be well-localised at the exact contact frame.

**Improvement ideas:**
- Lower thresholds (e.g. `MIN_ANGLE = 15°`, `MIN_SPEED = 20 px/s`) and use a second, more liberal pass specifically near player positions.
- Use per-candidate speed profile: racket hits typically produce a speed *increase* after contact (ball accelerated by player) while floor bounces produce a speed *decrease*. Add this as a dedicated racket signal.
- Reduce smoothing sigma (σ=1.0) or use an adaptive sigma that decreases in high-speed segments to preserve signal fidelity.

---

### F2 — Surface classification is wrong in 7 of 12 matched events (58%)

The most common confusions:
- **racket ↔ floor** (4 cases): engine classifies ball-over-court as floor even when a player is nearby.
- **wall ↔ fence** (1 case, frame 222): wall and fence share similar geometry near the court boundary.
- **floor ↔ wall** (2 cases, frames 406, 427): near-boundary floor impacts are classified as wall.

**Root causes:**
- Surface priority order (`racket → fence → wall → net → floor`) is applied once at the cluster level with a hard proximity threshold. Player proximity at the peak direction-change frame is noisy.
- Wall / fence disambiguation uses the homography projection to compare court_x/court_y against the boundary lines. When the ball is airborne the projection is unreliable, so OOB or boundary projections get mis-assigned.
- The homography maps the *floor plane*, so an airborne ball projects to a wrong court coordinate, shifting its apparent position away from the true surface.

**Improvement ideas:**
- Compute player proximity at all frames *within the cluster* (not just the peak frame) and use the minimum distance.
- Separate wall from fence using pixel x-coordinate: fence pixels tend to be at the far left/right edges of the frame (glass walls), whereas the back wall is at the top or bottom of the image. A simple `pixel_x < W*0.1 or pixel_x > W*0.9` heuristic can disambiguate many cases.
- For near-boundary events where the H projection is OOB, fall back to the *last valid* court projection rather than classifying as "unknown".

---

### F3 — Consecutive close impacts are collapsed into one

Frames 366 (floor) and 367 (racket) are 1 frame apart — a floor bounce immediately followed by a racket hit. The merge gap of 8 frames fuses these into a single detection at frame 370 and only the floor surface is reported.

**Root causes:**
- `DEFAULT_MERGE_GAP = 8` is too large for rapid exchanges where a ball bounces and is immediately struck.

**Improvement ideas:**
- Reduce `DEFAULT_MERGE_GAP` to 3–4 frames as the default.
- After clustering, split any cluster that contains two clear local direction-change maxima with different surface candidates (one near a player, one not).

---

### F4 — Airborne ball produces "unknown" classifications

Impacts near the glass walls (frames 472→473, 473→unknown) and several boundary events get classified as "unknown" because the homography projection goes out-of-court bounds when the ball is above the floor plane.

**Root causes:**
- The H matrix maps the floor plane. An airborne ball at `pixel (1728, 608)` projects to `court (OOB)`, so `is_in_court()` returns False and the surface is marked unknown.

**Improvement ideas:**
- For events classified as unknown, check the pixel position directly against the image boundary. A ball at `pixel_x > frame_width * 0.85` and mid-height likely hit the side glass; `pixel_y < frame_height * 0.1` likely hit the back glass.
- Alternatively, project the ball to the floor plane and clamp to the court boundary, then classify based on which edge it was clamped to.

---

### F5 — False positives from marginal direction changes

Two false positives: frame 390 (unknown, conf=0.267, Δθ=27.4°) and frame 526 (unknown, conf=0.387, Δθ=98.4°). Frame 390 has no human label; frame 526 is after the end of the labelled sequence and may be genuine (or a labelling gap).

**Root causes:**
- The confidence score does not yet gate detections — all events that pass thresholds are emitted regardless of confidence.

**Improvement ideas:**
- Add a `--min-confidence` flag (default 0.35) to filter the output. Frame 390 (0.267) would be suppressed.
- Surface "unknown" events should require a higher confidence threshold (e.g. 0.5) since they cannot be verified geometrically.

---

### F6 — Player detector coverage gaps

Several racket misses cluster at moments where player positions may be unreliable (occluded, tracking lost). Without a valid nearby player the racket classification fails and the event may also fail the player-proximity gate entirely.

**Root causes:**
- The current player detector does not handle occlusion or re-identification robustly.

**Improvement ideas:**
- Interpolate player positions across short tracking gaps (≤10 frames) so the proximity signal is continuous.
- Decouple detection from classification: first detect *any* strong direction change, then attempt surface classification as a separate step that can degrade gracefully.

---

## Priority Order for Next Iteration

1. **[High impact] Lower detection thresholds + speed-change heuristic for rackets** (F1)  
   Single biggest win: 12 missed racket hits become findable with `MIN_ANGLE ≈ 15°` + speed-increase signal.

2. **[High impact] Pixel-based surface fallback for OOB projections** (F4 + F2 partial)  
   Fixes "unknown" classification and several wall/fence confusions with minimal code.

3. **[Medium impact] Reduce merge gap to 3–4 frames** (F3)  
   Low-effort change; recovers consecutive bounce+hit events.

4. **[Medium impact] Per-cluster player proximity (min over window, not peak frame)** (F2)  
   Reduces racket↔floor confusion for slow/soft racket hits.

5. **[Low impact] Confidence threshold gating + unknown surface stricter threshold** (F5)  
   Suppresses the 2 false positives; minimal risk of new FN.

6. **[Long term] Player position interpolation for tracking gaps** (F6)  
   Requires changes to the player detector or a dedicated gap-fill post-processor.
