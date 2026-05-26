# MediaPipe Pose Detection Tools

**Goal:** Two new Python tools under `tools/`:

1. `detect_pose_mp.py` — runs MediaPipe Pose Landmarker on a video and exports a pose-labeller v2 JSON ready to load into pose-labeller-tool for correction.
2. `mediapipe_pose_landmark_overlay.py` — renders the skeleton + keypoints on a video, either by running detection live or by replaying a pre-computed poses JSON.

---

## Motivation

Manual labelling in pose-labeller-tool requires clicking up to 16 keypoints per frame. For a 30fps clip with 73 frames that is ~1 000 clicks. MediaPipe Pose Landmarker runs on CPU in real time and covers all 16 of the pose-labeller keypoints from a single model call. The proposed workflow:

```
video → detect_pose_mp.py → *_mp_poses.json
                                    ↓
                        load in pose-labeller-tool
                        (Pre-load poses)
                                    ↓
                        correct / refine mistakes
                                    ↓
                        export corrected *_poses.json
```

The labeller becomes a **correction tool** rather than a from-scratch annotation tool. The overlay tool allows a quick visual quality-check of the raw detections before loading them into the labeller.

---

## MediaPipe API Choice

Use the **Tasks API** (`mediapipe.tasks.python.vision.PoseLandmarker`) rather than the legacy `mp.solutions.pose`.

| | Tasks API | Legacy API |
|---|---|---|
| Multi-person | Yes (up to N) | No (single person) |
| Model variants | Lite / Full / Heavy | Fixed |
| Output format | `PoseLandmarkerResult` | `NormalizedLandmarkList` |
| Maintenance | Active | Frozen |

Model files (`.task`) are downloaded from the MediaPipe CDN on first run and cached locally.

---

## Keypoint Mapping

MediaPipe outputs 33 normalised landmarks per person. Mapping to the 16 pose-labeller keypoints:

| pose-labeller ID | MediaPipe landmark | Index |
|---|---|---|
| `head` | `NOSE` | 0 |
| `neck` | *computed* — midpoint of `LEFT_SHOULDER` + `RIGHT_SHOULDER` | 11, 12 |
| `left_shoulder` | `LEFT_SHOULDER` | 11 |
| `right_shoulder` | `RIGHT_SHOULDER` | 12 |
| `left_elbow` | `LEFT_ELBOW` | 13 |
| `right_elbow` | `RIGHT_ELBOW` | 14 |
| `left_wrist` | `LEFT_WRIST` | 15 |
| `right_wrist` | `RIGHT_WRIST` | 16 |
| `left_hip` | `LEFT_HIP` | 23 |
| `right_hip` | `RIGHT_HIP` | 24 |
| `left_knee` | `LEFT_KNEE` | 25 |
| `right_knee` | `RIGHT_KNEE` | 26 |
| `left_ankle` | `LEFT_ANKLE` | 27 |
| `right_ankle` | `RIGHT_ANKLE` | 28 |
| `left_toe` | `LEFT_FOOT_INDEX` | 31 |
| `right_toe` | `RIGHT_FOOT_INDEX` | 32 |

**Neck computation:** No MediaPipe landmark corresponds to the neck. Compute as:
```
neck = nose + 0.35 × (mid_shoulder − nose)
```
This places the neck point roughly at the base of the skull — closer to mid-shoulder than to the nose, matching where the pose-labeller neck keypoint is typically placed.

**Visibility mapping:** MediaPipe provides a `visibility` float (0–1) per landmark:

| Score | pose-labeller visibility |
|---|---|
| ≥ 0.65 | `visible` |
| 0.30 – 0.65 | `occluded` |
| < 0.30 | `not_in_frame` |

Thresholds are exposed as CLI flags for tuning.

---

## Tool 1 — `detect_pose_mp.py`

### CLI

```
python3 tools/detect_pose_mp.py \
    --video  path/to/video.mp4 \
    --output path/to/output_mp_poses.json \
    [--model  lite | full | heavy]   # default: full
    [--person 0]                     # which detected person to keep (0 = largest bbox)
    [--every-n N]                    # sample every N frames, default 1
    [--vis-visible  FLOAT]           # visibility threshold for 'visible'  (default 0.65)
    [--vis-occluded FLOAT]           # visibility threshold for 'occluded' (default 0.30)
```

### Person selection

When multiple people are detected per frame the tool must choose one. Strategy (applied per frame):

1. **Largest bounding box** (default, `--person 0`): the person whose landmark bounding box has the greatest area. Usually the most prominent / closest player.
2. **Index** (`--person N`): keep the Nth detection sorted by descending bbox area.

Tracking consistency across frames is not attempted — per-frame selection is sufficient because the labeller can correct mismatches.

### Output format

The output is a pose-labeller **v2 MultiPoseExport** JSON, directly loadable via "Pre-load poses" in `LoadStep`:

```json
{
  "version": 2,
  "videoFile": "source.mp4",
  "fps": 29.97,
  "poses": [
    {
      "frame": 0,
      "timestampMs": 0,
      "keypoints": {
        "head":          { "x": 412, "y": 88,  "visibility": "visible" },
        "neck":          { "x": 410, "y": 115, "visibility": "visible" },
        "left_shoulder": { "x": 388, "y": 138, "visibility": "visible" },
        "...": "..."
      },
      "angles": { "left_elbow": 92, "right_elbow": null, "..." : "..." }
    }
  ]
}
```

Angles are computed using the same `angles.ts` logic, ported to Python in `padel-engine` or inlined.

### Implementation sketch

```python
import mediapipe as mp
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision as mp_vision

options = mp_vision.PoseLandmarkerOptions(
    base_options=mp_tasks.BaseOptions(model_asset_path=model_path),
    running_mode=mp_vision.RunningMode.VIDEO,
    num_poses=4,
    min_pose_detection_confidence=0.3,
    min_pose_presence_confidence=0.3,
    min_tracking_confidence=0.3,
)
with mp_vision.PoseLandmarker.create_from_options(options) as landmarker:
    while True:
        ret, frame = cap.read()
        ...
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        result = landmarker.detect_for_video(mp_image, timestamp_ms)
        # select person, map landmarks, write to poses list
```

---

## Tool 2 — `mediapipe_pose_landmark_overlay.py`

### CLI

```
python3 tools/mediapipe_pose_landmark_overlay.py \
    --video   path/to/video.mp4 \
    --output  path/to/output_overlay.mp4 \
    [--poses  path/to/poses.json]   # pre-computed JSON; if omitted, runs MP live
    [--model  lite | full | heavy]
    [--person 0]
    [--show-angles]                 # draw joint angle labels at each vertex
    [--skeleton-color R,G,B]        # default: 0,255,0
    [--point-radius N]              # keypoint circle radius, default 5
```

### Rendering

For each frame, draw:

1. **Skeleton lines** — connecting pairs defined by `skeleton.ts` bone list (ported to a Python constant). Colour by body segment (arms / trunk / legs) or uniform.
2. **Keypoint circles** — colour-coded by visibility: green = visible, amber = occluded, grey = not\_in\_frame.
3. **Joint angle labels** *(optional, `--show-angles`)* — degree value beside each joint vertex where all three triplet keypoints are visible.

### Two modes

| Mode | When | How |
|---|---|---|
| **Live** | `--poses` not provided | Runs `PoseLandmarker` per frame, same as `detect_pose_mp.py` |
| **Replay** | `--poses path` provided | Reads the JSON, draws stored keypoints — no model needed |

Replay mode is useful for visually verifying the output of `detect_pose_mp.py` before loading it into the labeller, and for rendering corrected poses after the labeller step.

---

## Skeleton Bone List (Python constant)

```python
BONES = [
    ("head",           "neck"),
    ("neck",           "left_shoulder"),
    ("neck",           "right_shoulder"),
    ("left_shoulder",  "left_elbow"),
    ("left_elbow",     "left_wrist"),
    ("right_shoulder", "right_elbow"),
    ("right_elbow",    "right_wrist"),
    ("left_shoulder",  "left_hip"),
    ("right_shoulder", "right_hip"),
    ("left_hip",       "right_hip"),
    ("left_shoulder",  "right_shoulder"),
    ("left_hip",       "left_knee"),
    ("left_knee",      "left_ankle"),
    ("left_ankle",     "left_toe"),
    ("right_hip",      "right_knee"),
    ("right_knee",     "right_ankle"),
    ("right_ankle",    "right_toe"),
]
```

---

## Dependencies

Both tools share a new `requirements.txt` in `tools/` (or inline install note in the docstring):

```
mediapipe>=0.10
opencv-python
numpy
```

MediaPipe 0.10+ includes the Tasks API. The `.task` model file (~4–25 MB depending on variant) is downloaded automatically from the MediaPipe CDN on first use via `urllib` and cached at `~/.cache/mediapipe/`.

---

## File Layout

```
tools/
  detect_pose_mp.py                  # Tool 1
  mediapipe_pose_landmark_overlay.py # Tool 2
  requirements-mediapipe.txt         # shared deps
```

---

## Open Questions

1. **Shared angle computation** — angles are currently computed in TypeScript (`pose-labeller-tool/src/lib/angles.ts`). Both tools need the same logic in Python. Options: inline it, or add it to `padel-engine` as `padel_engine/lib/angles.py` and import from there.
2. **`every-n` and the labeller** — when `--every-n N > 1`, only sampled frames are in the JSON. The labeller's `[`/`]` navigation already handles sparse frames correctly.
3. **Model caching location** — `~/.cache/mediapipe/` is reasonable but could collide across projects. A project-local `.dev/models/` may be cleaner.
4. **Multi-player videos** — when both players are in frame (e.g. wide-angle shot), the `--person` index may flip between frames if the detector re-orders detections. A future tracking pass (IoU-based or court-side assignment) would stabilise this.
