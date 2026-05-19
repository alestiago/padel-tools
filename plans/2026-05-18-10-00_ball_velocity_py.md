# Plan — ball-velocity-tool-py

A CLI Python tool that detects the padel ball's position per frame and computes its real-world velocity, using the homography JSON produced by `homography-tool`.

Motivation: the browser-based `ball-velocity-tool` is slow because the TrackNetV2 ONNX model runs single-threaded on CPU inside a Web Worker, and seeks between frames add overhead. Python gives us faster frame extraction via OpenCV and access to mature CV libraries without the browser sandbox constraints.

---

## Directory layout

```
padel_tools/
└── ball-velocity-tool-py/
    ├── requirements.txt
    ├── main.py              ← entry point / CLI
    ├── detector/
    │   ├── __init__.py
    │   ├── blob.py          ← classical HSV + blob detector (no model)
    │   ├── yolo.py          ← YOLOv8 ONNX detector
    │   └── tracknet.py      ← TrackNetV2 ONNX detector (3-frame sliding window)
    ├── homography.py        ← load JSON, apply H, validate court bounds
    ├── velocity.py          ← raw + smoothed velocity computation
    └── output.py            ← CSV / JSON writer
```

---

## CLI interface

```
python main.py <video> --homography <path> [options]
```

### Positional

| Arg | Description |
|-----|-------------|
| `video` | Path to the input video file |

### Required

| Flag | Description |
|------|-------------|
| `--homography PATH` | Path to `homography_video.json` (exported by `homography-tool`) |

### Optional

| Flag | Default | Description |
|------|---------|-------------|
| `--detector {blob,yolo,tracknet}` | `blob` | Ball detection backend |
| `--model PATH` | — | Path to ONNX model weights (required for `yolo` and `tracknet`) |
| `--fps FLOAT` | auto (from video) | Override video frame rate |
| `--frame-step INT` | `2` | Analyse every N frames |
| `--threshold FLOAT` | `0.5` | Detection confidence threshold (ignored for `blob`) |
| `--output PATH` | `<video_stem>_velocity.csv` | Output file path |
| `--format {csv,json}` | `csv` | Output format |
| `--debug-dir PATH` | — | If set, writes annotated JPEG frames to this directory |
| `-v / --verbose` | — | Enable DEBUG-level logging |

### Example invocations

```bash
# Quick baseline with blob detector
python main.py match.mp4 --homography homography_video.json

# YOLOv8 with model weights, JSON output
python main.py match.mp4 --homography homography_video.json \
    --detector yolo --model yolov8n_padel.onnx --format json

# TrackNet, every frame, debug frames written out
python main.py match.mp4 --homography homography_video.json \
    --detector tracknet --model tracknet.onnx --frame-step 1 \
    --debug-dir ./debug_frames -v
```

---

## Internal pipeline

```
video
  │
  ▼
OpenCV VideoCapture
  │  sample every frame-step frames
  ▼
Detector  (blob | yolo | tracknet)
  │  → (u, v) pixel coords, or None
  ▼
homography.apply_H(H, u, v)
  │  → (x, y) real-world court metres
  │  → validate: -1 ≤ x ≤ 11, -1 ≤ y ≤ 21
  ▼
velocity.compute(results, dt)
  │  pass 1: raw velocity between consecutive detections
  │  pass 2: 5-frame sliding-window mean, discard > 250 km/h
  ▼
output.write(results)          CSV / JSON
  +
output.summary(results)        logged to stdout
```

---

## Detectors

### `blob` (default, no model needed)

Classical approach using OpenCV:

1. Convert frame BGR → HSV.
2. Threshold for the ball's colour range (yellow-green: H 25–45, S > 80, V > 80). The range is configurable via `--hsv-lower` / `--hsv-upper`.
3. Morphological open (remove noise) then dilate.
4. `cv2.SimpleBlobDetector` with min/max area constraints.
5. Pick the largest blob; return its centroid as `(u, v)`.

No confidence threshold — detection is either present or absent.

### `yolo`

1. Load `--model` with `onnxruntime.InferenceSession`.
2. Preprocess frame to 640×640 RGB float32, normalise to [0, 1].
3. Run inference; decode bounding boxes (class `ball`).
4. Apply NMS; return centroid of the highest-confidence box with score ≥ `--threshold`.

### `tracknet`

Mirrors the TypeScript implementation:

1. Maintain a 3-frame FIFO buffer.
2. Resize each frame to 512×288, convert to float32 RGB [0, 1].
3. Stack into a 9-channel input tensor `(1, 9, 288, 512)` (oldest→newest).
4. Run inference; output is a single-channel heatmap `(1, 1, 288, 512)`.
5. Find argmax; scale back to original resolution.
6. Return `(u, v)` only if peak confidence ≥ `--threshold`.

---

## Homography

```python
# homography.py
import json, numpy as np

def load(path: str) -> dict:
    with open(path) as f:
        data = json.load(f)
    return {
        "H": np.array(data["H"], dtype=np.float64),
        "frame_size": data["frame_size"],
    }

def apply_H(H: np.ndarray, u: float, v: float) -> tuple[float, float]:
    p = H @ np.array([u, v, 1.0])
    return p[0] / p[2], p[1] / p[2]

COURT_X = (-1.0, 11.0)
COURT_Y = (-1.0, 21.0)

def in_court(x: float, y: float) -> bool:
    return COURT_X[0] <= x <= COURT_X[1] and COURT_Y[0] <= y <= COURT_Y[1]
```

---

## Velocity computation

Same algorithm as `velocityCalc.ts`:

```python
MAX_REALISTIC_KMH = 250.0

def compute(results: list[dict], dt: float, window: int = 5) -> list[dict]:
    # Pass 1 — raw
    for i, r in enumerate(results):
        if i == 0 or r["ball"] is None or results[i-1]["ball"] is None:
            r["raw_velocity_kmh"] = None
            continue
        dx = r["ball"]["x"] - results[i-1]["ball"]["x"]
        dy = r["ball"]["y"] - results[i-1]["ball"]["y"]
        kmh = (math.hypot(dx, dy) / dt) * 3.6
        r["raw_velocity_kmh"] = kmh if kmh <= MAX_REALISTIC_KMH else None

    # Pass 2 — sliding window mean
    half = window // 2
    for i, r in enumerate(results):
        window_vals = [
            results[j]["raw_velocity_kmh"]
            for j in range(max(0, i-half), min(len(results), i+half+1))
            if results[j]["raw_velocity_kmh"] is not None
        ]
        r["velocity_kmh"] = sum(window_vals) / len(window_vals) if window_vals else None
    return results
```

---

## Logging

Using Python's `logging` module. Default level is `INFO`; `-v` sets `DEBUG`.

```
[INFO]  Loaded homography: match.mp4 | frame_size=1920×1080 | reproj_err=0.023 m
[INFO]  Video: 1847 frames @ 60.0 fps → 924 frames to analyse (step=2)
[INFO]  Detector: blob
[INFO]  Processing... (tqdm progress bar)
[INFO]  Detection rate: 71.3% (659/924 frames)
[INFO]  Peak smoothed velocity: 142.7 km/h  (t=12.34 s)
[INFO]  Output written: match_velocity.csv (924 rows)
```

Debug log (per frame when `-v`):
```
[DEBUG] frame=42 t=1.400s blob=(u=312.4, v=198.1) → court=(3.21, 7.44) raw=118.3 km/h
[DEBUG] frame=44 t=1.467s no detection
```

---

## Output format

### CSV (default)

```csv
frame_index,time_s,pixel_u,pixel_v,court_x_m,court_y_m,raw_velocity_kmh,velocity_kmh
0,0.000,,,,,, 
2,0.033,312.4,198.1,3.21,7.44,,
4,0.067,318.7,201.3,3.27,7.51,112.4,
...
```

Empty cells for frames with no detection.

### JSON

```json
[
  {
    "frame_index": 0,
    "time_s": 0.000,
    "ball": null,
    "raw_velocity_kmh": null,
    "velocity_kmh": null
  },
  {
    "frame_index": 2,
    "time_s": 0.033,
    "ball": { "pixel_u": 312.4, "pixel_v": 198.1, "court_x_m": 3.21, "court_y_m": 7.44 },
    "raw_velocity_kmh": null,
    "velocity_kmh": null
  },
  ...
]
```

---

## Debug frames

When `--debug-dir` is set, for each frame the tool writes an annotated JPEG:
- Green circle at detected ball position (or text "no detection").
- Top-left overlay: frame index, timestamp, velocity.

Useful for inspecting detector accuracy without a GUI.

---

## requirements.txt

```
opencv-python-headless>=4.9
numpy>=1.26
tqdm>=4.66
onnxruntime>=1.18          # CPU inference (blob detector doesn't need this)
```

Optional (not in requirements, install manually if needed):
- `onnxruntime-gpu` — replace `onnxruntime` for GPU acceleration
- `ultralytics` — alternative to the raw ONNX path for YOLO

---

## Iteration path

1. **Start with `blob` detector** — validate the velocity formula against the homography. No model needed, runs in real time on CPU.
2. **Add `yolo` detector** — replace blob with YOLOv8n ONNX (~6 MB) once the pipeline is validated. Higher recall on fast-moving balls.
3. **Add `tracknet` detector** — port the same TrackNetV2 ONNX model used in `ball-velocity-tool`. Best accuracy but requires 3-frame buffer.

Each detector is a drop-in replacement behind the same `detect(frame) -> (u, v) | None` interface.

---

## What is NOT in scope

- No interactive UI, no visualisation beyond the optional `--debug-dir` frames.
- No training or fine-tuning of models.
- No audio processing.
- No multi-video batch mode (out of scope for now; can be added with a shell loop).
