Overlay pose keypoints and joint angles from pose-labeller-tool output onto a video frame or full video using `tools/overlay_pose.py`. Always run commands from the repo root (`padel_tools/`).

## Inputs

The user will point you at one of:
- A **single-frame JSON** (`*_pose_N.json`, version 1) → outputs a PNG
- A **multi-frame JSON** (`*_poses.json`, version 2, from "Export all") → outputs a video
- A **directory of single-frame JSONs** → outputs a video

Always also need a `--video` path.

## Commands

**Single frame → PNG**
```
python3 tools/overlay_pose.py \
  --pose <path/to/pose.json> \
  --video <path/to/video.mp4> \
  --output <path/to/output.png>
```

**Multi-frame JSON → annotated video**
```
python3 tools/overlay_pose.py \
  --poses <path/to/poses.json> \
  --video <path/to/video.mp4> \
  --output <path/to/output.mp4>
```

**Directory of JSONs → annotated video**
```
python3 tools/overlay_pose.py \
  --poses-dir <path/to/dir/> \
  --video <path/to/video.mp4> \
  --output <path/to/output.mp4>
```

## Optional flags

| Flag | Default | Description |
|------|---------|-------------|
| `--no-angles` | off | Omit angle arcs and degree labels |
| `--no-skeleton` | off | Omit bone connections |
| `--no-keypoints` | off | Omit keypoint circles |
| `--label-color #RRGGBB` | arc colour | Override text colour for all labels |
| `--label-size PX` | 12 | Font size in pixels |
| `--label-bg #RRGGBB\|none` | #000000 | Label background box colour, or none |
| `--label-fps FPS` | auto | Labeller FPS if different from video FPS |

## After running

- If the output is a PNG, display it using the Read tool so the user can see the result.
- If paths are ambiguous, ask the user to clarify before running.
- Save outputs inside the same directory as the input files unless the user specifies otherwise.
