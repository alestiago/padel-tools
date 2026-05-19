# Analysis — Ball Detector Evaluation vs Ground Truth (jugada1)

## Setup

- **Ground truth**: `jugada1_labels.json` / `jugada1_labels.csv` (528 labelled frames, 530-frame clip at 30 fps ≈ 17.7 s)
- **Best detector evaluated**: `tracknet_v2` with TrackNetV2 ONNX model
- **Homography**: `homography_video.json` (calibrated at 3840×2160 on video.MOV)
- **Match criterion**: detection within 3% of normalised frame width (~58px at 1920×1080) of the GT position

---

## Ground Truth Profile

| Metric | Value |
|--------|-------|
| Total labelled frames | 528 |
| Visible (with position) | 494 (93.6%) |
| Occluded | 31 (5.9%) |
| Out of frame | 3 (0.6%) |
| In play | 515 |
| Dead | 13 |

Ball vertical distribution (% of frame height):
- **Top third (y < 33%)**: 103 frames (21%)
- **Middle third (33–66%)**: 333 frames (67%)
- **Bottom third (> 66%)**: 58 frames (12%)

---

## tracknet_v2 Results

| Outcome | Frames | Rate |
|---------|--------|------|
| **Hit** (within 3% of frame) | 42 | **8.5%** |
| **Miss** (no detection) | 409 | **82.8%** |
| **Wrong position** (detected, but elsewhere) | 43 | **8.7%** |
| Spurious detections (detector fires on GT-occluded frames) | 2 | — |

Overall recall on GT-visible frames: **8.5%**.

### Hit clusters

All 42 hits fall into tight temporal bursts where the ball is in the lower/middle frame:

| Frames | Duration | Mean ball y (norm) |
|--------|----------|--------------------|
| 2–5 | 4 frames | 0.77 |
| 140–148 | 9 frames | 0.56 |
| 208–212 | 5 frames | 0.73 |
| 283–300 | 18 frames | 0.57 |
| 407–416 | 10 frames | 0.69 |

**The model only detects the ball when it is in the lower half of the frame** (y_norm > 0.47). It is completely blind to the top third (y_norm < 0.33), which contains 21% of all visible frames.

### Largest miss streaks

| Frames | Duration | Notes |
|--------|----------|-------|
| 21–139 | **119 frames / 4.0 s** | Ball transitions from bottom to mid-top region |
| 159–189 | 31 frames / 1.0 s | |
| 431–460 | 30 frames / 1.0 s | |
| 371–399 | 29 frames / 0.9 s | |

The 4-second blackout (frames 21–139) is the most critical failure: once the model loses the ball, it cannot re-acquire it for an extended period.

### Wrong-position detection pattern

When the model fires incorrectly, its detections systematically cluster **lower in the frame** than the GT position:

| | Mean y_norm | Range |
|-|-------------|-------|
| GT position | 0.56 | 0.17–0.81 |
| Detector position | 0.66 | 0.52–0.93 |

This points to glass wall reflections or court boundary artifacts in the lower frame triggering false activations.

---

## Root Causes

### Issue 1 — Resolution pipeline mismatch (CRITICAL)

`jugada1.mp4` is **1920×1080**. The homography was calibrated on `video.MOV` at **3840×2160**. The pipeline blindly upscales every video frame from 1920→3840 before passing it to TrackNetV2.

TrackNetV2's input is always resized to **512×288** internally. The effective ball size in the model input is:

| Pipeline | Downscale ratio (video→model) | Ball size at model input (~20px native) |
|----------|-----------------------------|----------------------------------------|
| 1920 → 512 (correct) | 0.267× | **~5.3 px** |
| 1920 → 3840 → 512 (actual) | 0.133× | **~2.7 px** |

The useless 2× upscale halves the ball size at inference time. A 2.7 px ball is near the lower bound of what TrackNetV2 can reliably detect, which explains the 82.8% miss rate. The added upscale wastes compute and degrades detection without any benefit — it doesn't add information that wasn't in the native 1920×1080 frame.

**Fix**: skip the upscale step when the video is smaller than the homography calibration resolution. Run inference at native resolution; only scale the output pixel coordinates when projecting through the homography matrix.

---

### Issue 2 — Domain shift: trained on broadcast tennis, used on padel

TrackNetV2 was trained on **broadcast tennis footage** (ITF/Grand Slam TV feed): fixed camera, painted green court, high contrast between white ball and green surface, standardised broadcast angles.

Padel in `jugada1`:
- **Glass walls**: transparent background that reflects the court, players, and the ball itself
- **Different ball colour**: padel uses yellow/green but against glass the contrast is much lower
- **Camera angle**: elevated side view, not the traditional tennis broadcast angle
- **Court markings**: different line positions and spacings
- **Ball size**: padel ball is slightly larger than a tennis ball but the camera is typically further away

The model's heatmap activations in wrong-detection frames cluster near the lower court boundary (court wall reflections, glass panels), which look superficially similar to training examples.

**Fix**: fine-tune TrackNetV2 on padel footage. The `ball-labeller-tool` now produces exactly the format needed for this. ~500–1000 labelled visible frames (across varied conditions: different rallies, ball heights, occlusion events) would constitute a minimal training set.

---

### Issue 3 — Zero recovery mechanism after tracking loss

Once the model loses the ball (miss streak), the following compound:
1. The 3-frame temporal buffer holds stale/wrong frames — inference on a buffer containing 2 frames without the ball produces noise.
2. The velocity gate (`confirm/velocity_gate`) requires at least 1 prior confirmed detection. After a long miss streak, the history is stale (> 1.0 s) and gets cleared, so the first re-detection has no continuity anchor.
3. No "search mode" exists: the detector runs at the same threshold regardless of how long it has been since the last detection.

This produces the 4-second blackout: the model gets confused by the stale buffer, misses repeatedly, never builds enough confirmed history to use the trajectory predictor, and stays stuck in a failed state.

**Fix**: add a `reset_on_loss` mechanism — if no detection for N consecutive frames (e.g., N=5), clear the buffer, clear confirmed history, and temporarily lower the threshold (e.g., from 0.5 to 0.3) for the next M frames to re-acquire the ball. Once re-acquired, restore the normal threshold.

---

### Issue 4 — Glass wall mask incorrectly computed or over-aggressive

Fix C in `TrackNetDetectorV2` attenuates heatmap values in the region `world_y > 20 m` (beyond the far glass wall). The mask is built once using the homography matrix H and the source video resolution.

Two potential bugs:
- The mask is built using `src_h, src_w` (the video frame dimensions **after** upscaling to 3840×2160), but the heatmap is 512×288. The mapping from heatmap pixels → video pixels → world coords is computed correctly in the code, but the 2× upscale of Issue 1 propagates here: the glass mask's geometry is computed on a 3840×2160 frame even though the source frame the model actually sees comes from a 1920×1080 source (just artificially upscaled). The glass mask should be the same in both cases (both ultimately represent the same camera view), but the intermediate computation is doing unnecessary work.
- The `glass_wall_y = 20.0 m` threshold may be correct for a full-court view but the reprojection error of `0.086 m` means a few pixels near the glass wall can tip either side of the threshold, masking valid detections near the far end of the court.

**Fix**: visualise the glass mask projected back onto the video frame to confirm it matches the actual glass wall position. Consider raising `glass_wall_y` to `21 m` or `22 m` as a margin, and verify the mask geometry is identical whether the video is native 1920×1080 or upscaled.

---

### Issue 5 — Camera motion gate kills too many frames

Fix D skips inference when `median pixel diff > cam_motion_threshold (8)`. A padel ball travelling at 150 km/h crosses ~50px between 30fps frames, which can inflate the median diff when the ball is large or near the camera. The threshold of 8 counts median pixel intensity change, which is a crude proxy for camera motion.

While this gate prevents inference on pan/shake frames, it may also skip frames where the ball is moving fast in a static-camera shot — precisely the frames where detection is most needed.

**Fix**: replace median global diff with a **background region diff** — mask out the expected ball region (using the trajectory predictor's bounding box) and compute the diff only on the remaining pixels. This way fast-ball frames don't trigger the gate even when the ball is dominant.

---

### Issue 6 — No multi-scale or tiled inference for distant/small ball

When the ball is in the upper portion of the frame (y_norm < 0.33, which is 21% of visible frames), it is typically:
- At the top of the court arc (highest point of a lob)
- Near the net
- Farther from the camera (smaller apparent size)

At these positions the ball is ~10–15px wide at 1920×1080, which becomes **1.3–2px** in the 512×288 model input after the 3840 upscale. This is essentially invisible. Even without the upscale issue, it would be ~2.7–4px — still very small.

**Fix**: run an additional inference pass with a **2× zoomed crop of the upper frame half** (crop the top 540px of the 1080px frame, scale to 512×288). Combine the heatmaps from both passes before NMS. This concentrates model capacity on the region where the ball is smallest.

---

## Mitigation Plan

### P1 — Fix the resolution pipeline (Quick win, 1 day)

In `main.py`, when the video frame size is smaller than the homography calibration size, pass the frame at native resolution to the detector and scale the output pixel coordinates before projecting through H.

```python
# Instead of:
frame = cv2.resize(frame, (cal_w, cal_h))  # always upscale

# Do:
scale_u = cal_w / orig_w  # e.g. 2.0 for 1920→3840
scale_v = cal_h / orig_h
# Pass native-resolution frame to detector
detection = detector.detect(frame_native)
# Scale output coords before homography projection
if detection:
    u, v = detection[0] * scale_u, detection[1] * scale_v
```

Expected impact: ball size in model input doubles (2.7→5.3px), likely improving recall substantially.

---

### P2 — Fine-tune TrackNetV2 on padel data (High impact, 1–2 weeks)

Use the `ball-labeller-tool` to label 1,000–2,000 frames across diverse rallies (different ball heights, glass wall proximity, lighting, camera angles). Export the ground-truth JSON and fine-tune the TrackNetV2 model weights on this padel-specific data.

Training requirements:
- Input: 3 consecutive frames at 512×288 → 9-channel tensor
- Output: 2D Gaussian heatmap centred on ball position
- Loss: weighted BCE (positive cell weight ~10× to handle class imbalance)
- Data augmentation: horizontal flip (padel courts are symmetric), brightness ±20%, random crop+resize

Priority labelling targets:
- Ball near glass walls (false-positive source)
- Ball in top third of frame (blind spot)
- Ball during fast rallies (motion blur frames)
- Multi-ball frames (practice drills)

---

### P3 — Add reset-on-loss re-acquisition (Medium, 1 day)

In `TrackNetDetectorV2.detect`, track consecutive misses. After N misses, switch to low-threshold search mode:

```python
self._miss_streak = 0

# In detect():
if result is None:
    self._miss_streak += 1
    if self._miss_streak >= RESET_STREAK:
        self._buf.clear()
        self._confirmed.clear()
        self._miss_streak = 0
        # Re-run at lower threshold for next few frames
        self._search_mode_frames = SEARCH_FRAMES
else:
    self._miss_streak = 0
```

Tune: `RESET_STREAK = 8`, `SEARCH_FRAMES = 10`, search threshold = 0.25.

---

### P4 — Multi-scale inference for upper-frame detections (Medium, 2 days)

In `TrackNetDetectorV2.detect`, after the primary heatmap pass, crop the top half of the frame, run a second inference pass, and merge the heatmaps:

```python
# Second pass: zoom upper half
crop = frame_bgr[:src_h//2, :, :]
crop_resized = cv2.resize(crop, (src_w, src_h))  # upscale to fill model input
# ... run inference → heatmap_upper
# Map heatmap_upper coords back to full-frame space (v /= 2)
# Merge heatmaps (take max or weighted average) before NMS
```

---

### P5 — Background-region camera motion gate (Low, 0.5 day)

Replace the global median diff with a background-only diff in `TrackNetDetectorV2`:

```python
# Build a crude foreground mask using frame differencing or the trajectory predictor
# Only compute median diff on background pixels (not the predicted ball region)
bg_mask = build_background_mask(gray, pred_bbox)
diff_bg = cv2.absdiff(gray, self._prev_gray)
if float(np.median(diff_bg[bg_mask])) > self._cam_threshold:
    # camera is moving
```

---

### P6 — Visualise and validate the glass mask (Diagnostic, 0.5 day)

Add a debug mode to `TrackNetDetectorV2` that projects the glass mask back onto the video frame as a coloured overlay and dumps it as a JPEG. Confirm visually that it exactly aligns with the glass wall in the actual video, and that it doesn't erroneously mask regions where the ball legitimately travels.

---

## Priority Order

| # | Fix | Impact | Effort | Do first |
|---|-----|--------|--------|----------|
| P1 | Fix upscale pipeline | High | 0.5 day | ✓ |
| P2 | Fine-tune on padel data | Very High | 1–2 weeks | After P1 |
| P3 | Reset-on-loss re-acquisition | High | 1 day | After P1 |
| P4 | Multi-scale upper-frame pass | Medium | 2 days | After P1 |
| P5 | Background-region cam gate | Low | 0.5 day | Optional |
| P6 | Glass mask diagnostic | Diagnostic | 0.5 day | Before P4 |

P1 is a no-code-complexity, high-impact fix that should be attempted first. P2 (fine-tuning) is the only path to closing the domain-shift gap and is the long-term solution. P3 and P4 are engineering improvements that amplify the gains from P2.
