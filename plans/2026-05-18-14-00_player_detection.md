# Plan — Player position detection (Python)

## Is this simpler than ball detection?

Yes, substantially. The ball is 6–7 cm in diameter and travels at up to 200+ km/h,
making it 10–30 px wide and often motion-blurred to near invisibility. Players are
~1.8 m tall, appear as 150–400 px bounding boxes, move at walking/running pace,
and are always visible in the frame. Every approach that struggled with the ball
is either irrelevant or trivially easy for players.

---

## What "player position" means

The useful output is the **foot position in world coordinates** — the bottom-centre
of the detected bounding box projected through the homography H. This is more
meaningful than the bounding-box centre because players stand on the court surface
and the feet are what H was calibrated for (ground plane).

Output per frame: up to 4 players, each with:
- pixel foot position `(u, v)`
- world position `(court_x_m, court_y_m)`
- court side: `near` (y < 10 m) or `far` (y ≥ 10 m)

---

## Approaches

### A — YOLOv8 / YOLO11 person detection ✅ recommended

Use a pre-trained Ultralytics YOLO model (e.g. `yolo11n.pt`, ~6 MB) filtering
`class == 0` (person).

**How it works:**
1. Run YOLO inference on the frame → list of bounding boxes with class and confidence.
2. Keep only `class == 0` (person) detections above a threshold (e.g. 0.4).
3. Apply court-bounds filter: project bbox foot point through H, discard if outside
   court + margin.
4. Assign court side by comparing `court_y_m` to 10 m (net line).
5. Output up to 4 players per frame (padel has exactly 4).

**Pros:**
- State-of-the-art accuracy on person detection, trained on COCO.
- Handles multiple players, partial occlusion, varying scale.
- YOLOv8n/11n run at ~30–80 fps on CPU; with CoreML on Apple Silicon, faster.
- Ultralytics API is three lines: `model = YOLO(...)`, `results = model(frame)`.
- No temporal buffering needed — each frame is independent.

**Cons:**
- Adds `ultralytics` dependency (~heavy; alternatively export to ONNX and use
  `onnxruntime` directly, keeping the existing infrastructure).
- Pre-trained weights need to be downloaded once.

**ONNX export alternative:** `yolo11n.pt` can be exported to ONNX with
`model.export(format="onnx")`, then loaded via `onnxruntime` with the CoreML
provider — no Ultralytics at runtime.

---

### B — OpenCV HOG + SVM pedestrian detector

`cv2.HOGDescriptor_getDefaultPeopleDetector()` + `detectMultiScale()`.

**Pros:** Zero extra dependencies, ships with OpenCV.

**Cons:** Designed for upright pedestrians at medium range; misses players viewed
from above or far side of court. Slow (~2–5 fps at 4K). False-positive rate is high.
In practice, YOLO outperforms HOG on every axis that matters.

**Verdict:** Not worth using when YOLO is available.

---

### C — Background subtraction + large-blob filtering

MOG2 or KNN background model (`cv2.createBackgroundSubtractorMOG2`), then
`findContours` filtered by area (e.g. > 5000 px²) and aspect ratio.

**Pros:** No model, no weights, extremely fast.

**Cons:**
- Requires the background model to stabilise (first ~30 frames are noisy).
- Camera movement or zoom invalidates the model completely.
- Players leaning against the glass wall or standing still are missed.
- Cannot distinguish players from referees, ball boys, or large advertising boards.
- No class label, so court-bounds filter is the only gate.

**Verdict:** Useful as a lightweight fallback or for supplementing YOLO, but not
reliable enough as a primary detector.

---

### D — MediaPipe Pose / MoveNet

Skeleton keypoint models that output 17–33 body landmarks including feet.

**Pros:** Foot keypoints are more precise than bbox bottom-centre. Can detect
whether a player is diving, jumping, etc.

**Cons:**
- Most production versions are single-person; multi-person requires running
  detection first then pose on each crop — two-stage pipeline.
- TensorFlow Lite or MediaPipe dependencies (heavier than Ultralytics).
- Slower than YOLO on CPU for 4-player scenes.
- Overkill for position tracking; foot coordinates from YOLO bbox are sufficient.

**Verdict:** Interesting for future biomechanics analysis but unnecessary here.

---

## Conclusion

**Use YOLO11n (or YOLOv8n) exported to ONNX, run via `onnxruntime` with the
CoreML provider.**

Reasons:
1. Person detection is the strongest class in COCO — minimal tuning needed.
2. ONNX + CoreML reuses the existing inference stack from `tracknet_v2`.
3. No Ultralytics dependency at runtime; just a 6 MB weight file.
4. Each frame is independent — no 3-frame buffer, no stale-state issues.
5. Court-bounds filter + side assignment are straightforward with the existing
   homography infrastructure.

Expected throughput: ~10–20 fps on CPU, ~30–60 fps with CoreML — fast enough
to process the 3-minute clip in under 2 minutes.

---

## Implementation sketch

```
detector/player_yolo.py
    PlayerYoloDetector
        __init__(model_path, threshold=0.4, H_inv, court_margin_m=0.5)
        detect(frame_bgr) → list[PlayerDetection]

@dataclass PlayerDetection
    pixel_u: float   # foot x (px)
    pixel_v: float   # foot y (px)
    court_x_m: float
    court_y_m: float
    side: str        # "near" | "far"
    confidence: float

main.py  (new --mode player | ball, or separate script player_main.py)
output   CSV: frame_index, time_s, player_id, pixel_u, pixel_v, court_x_m, court_y_m, side
```

`player_id` is assigned by proximity to the last known position of each of the
4 slots (nearest-neighbour across frames) — a simple tracker sufficient for
position heatmaps and average positioning analysis.

---

## Model weights

`yolo11n.pt` → export once to `yolo11n.onnx`:
```python
from ultralytics import YOLO
YOLO("yolo11n.pt").export(format="onnx", imgsz=640, simplify=True)
```

At runtime only `onnxruntime` is needed. The ONNX model accepts `(1, 3, 640, 640)`
float32 BGR/RGB and outputs `(1, 84, 8400)` — 80 COCO classes + 4 box coords,
8400 anchors. Filter `argmax(scores) == 0` (person) and apply NMS.
