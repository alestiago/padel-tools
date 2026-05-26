# Pose Labeller Tool — Design Plan

**Goal:** A standalone React app that lets the user load a video, scrub to any frame, place body keypoints on the player by clicking, and then renders the skeleton with joint angles overlaid. Exports keypoints + computed angles as JSON.

---

## Context

Biomechanical analysis of padel strokes requires knowing joint angles at the moment of contact (e.g. elbow flexion during a smash, knee bend at split-step, trunk rotation at impact). Ball-labeller-tool already identifies the contact frame; this tool takes that frame and adds the spatial body configuration on top of it. The output is a ground-truth dataset for training pose-estimation models or for manual biomechanical study.

---

## Keypoint Schema

A curated 15-point skeleton, chosen to cover the joints relevant to a padel stroke without being as dense as COCO-17.

| ID | Name | Side |
|---|---|---|
| 0 | `head` | — |
| 1 | `neck` | — |
| 2 | `shoulder` | `left` / `right` |
| 3 | `elbow` | `left` / `right` |
| 4 | `wrist` | `left` / `right` |
| 5 | `hip` | `left` / `right` |
| 6 | `knee` | `left` / `right` |
| 7 | `ankle` | `left` / `right` |
| 8 | `toe` | `left` / `right` |

Each keypoint stores `{ x, y }` in pixel space and an optional `visibility` flag (`visible` / `occluded` / `not_in_frame`).

---

## Skeleton Connections

Connections define which keypoints are linked for drawing and angle computation.

```
head — neck
neck — left_shoulder — left_elbow — left_wrist
neck — right_shoulder — right_elbow — right_wrist
left_shoulder — left_hip — left_knee — left_ankle — left_toe
right_shoulder — right_hip — right_knee — right_ankle — right_toe
left_hip — right_hip        (pelvis crossbar)
left_shoulder — right_shoulder  (shoulder crossbar)
```

---

## Joint Angles

An angle is defined by three keypoints: **proximal → vertex → distal**. The angle is the interior angle at the vertex, computed via the dot-product formula on the two vectors.

| Angle name | Triplet |
|---|---|
| `left_elbow` | left_shoulder → left_elbow → left_wrist |
| `right_elbow` | right_shoulder → right_elbow → right_wrist |
| `left_knee` | left_hip → left_knee → left_ankle |
| `right_knee` | right_hip → right_knee → right_ankle |
| `left_shoulder_abduction` | neck → left_shoulder → left_elbow |
| `right_shoulder_abduction` | neck → right_shoulder → right_elbow |
| `left_hip_flexion` | left_shoulder → left_hip → left_knee |
| `right_hip_flexion` | right_shoulder → right_hip → right_knee |
| `trunk_lean` | neck → mid_hip → mid_knee (mid = average of left+right) |

An angle is only rendered when all three keypoints of its triplet have been placed and are marked `visible` or `occluded`.

---

## Architecture

New standalone React app at `pose-labeller-tool/`. Same Vite + React + TypeScript + Tailwind stack as the other tools. No code shared at runtime.

```
pose-labeller-tool/
  src/
    App.tsx              # step state machine: Load → Label → Export
    components/
      VideoScrubber.tsx  # video element + frame-step controls
      PoseCanvas.tsx     # canvas overlay: draws frame, skeleton, keypoints, angles
      KeypointPanel.tsx  # sidebar listing all 15 keypoints, highlight active one
      AngleOverlay.tsx   # rendering logic for arc + degree label at each vertex
    lib/
      angles.ts          # dot-product angle computation
      skeleton.ts        # connection list + angle triplet definitions
      exportJson.ts      # serialise to JSON
    types.ts
```

### State

```ts
type Visibility = 'visible' | 'occluded' | 'not_in_frame';

type Keypoint = {
  x: number;
  y: number;
  visibility: Visibility;
};

type PoseLabel = {
  videoFile: string;
  frame: number;          // 0-based frame index
  timestampMs: number;
  keypoints: Record<string, Keypoint>;   // key = "left_knee", "right_elbow", etc.
  angles: Record<string, number | null>; // degrees, null when not computable
};
```

`angles` are recomputed on every keypoint change — they are derived, not entered by hand.

---

## UI Design

### Step 1 — Load

Drop-zone for a video file. Once loaded, advances to Label.

### Step 2 — Label

```
┌──────────────────────────────────────────────────────────────┐
│  Pose Labeller          Frame 142 / 1800    [◀ ▶ ▶▶] [Export]│
├──────────────────────────────────────────┬───────────────────┤
│                                          │  Keypoints        │
│                                          │  ● head           │
│         canvas (video frame)             │  ● neck           │
│         + skeleton overlay               │  ◌ left_shoulder  │ ← active
│         + angle arcs                     │  ● left_elbow     │
│                                          │  …                │
│                                          │                   │
│                                          │  Angles           │
│                                          │  left_elbow  92°  │
│                                          │  right_knee  141° │
│                                          │  …                │
├──────────────────────────────────────────┴───────────────────┤
│  ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
└──────────────────────────────────────────────────────────────┘
```

**Interaction model:**

1. User selects which keypoint to place from the **Keypoints panel** (or cycles through with `Tab`).
2. User clicks on the canvas to place it. The click coordinate is stored in pixel space.
3. Right-click on an existing keypoint → context menu to mark `occluded` / `not_in_frame` / `delete`.
4. Placed keypoints render as coloured circles; the active (next-to-place) keypoint is highlighted in the panel.
5. Skeleton lines appear as each segment becomes fully defined.
6. Angle arcs + degree labels appear as each triplet becomes fully defined.

**Frame navigation:**

- `←` / `→` arrow keys step one frame at a time.
- `Shift+←` / `Shift+→` step 10 frames.
- Clicking the scrubber bar seeks to that position.
- Frame index is shown in the header; entering a number in the header jumps directly.

**Undo:** `Cmd+Z` removes the last placed keypoint.

### Step 3 — Export

Downloads `<videoname>_pose_<frame>.json`. Also offers "Add another frame" to label the same video at a different frame without reloading.

---

## Angle Rendering

At each vertex keypoint, draw:
- A circular arc between the two limb vectors, radius ≈ 20 px.
- The degree value as a label offset along the bisector of the two vectors.
- Colour-code by ergonomic range: green (safe range for that joint), amber (borderline), red (outside typical padel range). Ranges are configurable constants in `skeleton.ts`.

---

## Export Format

```json
{
  "version": 1,
  "videoFile": "match_001.mp4",
  "frame": 142,
  "timestampMs": 4733,
  "keypoints": {
    "head":           { "x": 412, "y": 88,  "visibility": "visible" },
    "neck":           { "x": 410, "y": 115, "visibility": "visible" },
    "left_shoulder":  { "x": 388, "y": 138, "visibility": "visible" },
    "left_elbow":     { "x": 365, "y": 182, "visibility": "visible" },
    "left_wrist":     { "x": 340, "y": 220, "visibility": "visible" },
    "right_shoulder": { "x": 432, "y": 140, "visibility": "visible" },
    "right_elbow":    { "x": 455, "y": 185, "visibility": "occluded" },
    "right_wrist":    { "x": 478, "y": 225, "visibility": "occluded" },
    "left_hip":       { "x": 395, "y": 210, "visibility": "visible" },
    "right_hip":      { "x": 425, "y": 212, "visibility": "visible" },
    "left_knee":      { "x": 390, "y": 280, "visibility": "visible" },
    "right_knee":     { "x": 430, "y": 282, "visibility": "visible" },
    "left_ankle":     { "x": 385, "y": 345, "visibility": "visible" },
    "right_ankle":    { "x": 435, "y": 347, "visibility": "visible" },
    "left_toe":       { "x": 372, "y": 360, "visibility": "visible" },
    "right_toe":      { "x": 450, "y": 362, "visibility": "visible" }
  },
  "angles": {
    "left_elbow":               92,
    "right_elbow":              null,
    "left_knee":                141,
    "right_knee":               138,
    "left_shoulder_abduction":  74,
    "right_shoulder_abduction": null,
    "left_hip_flexion":         160,
    "right_hip_flexion":        158,
    "trunk_lean":               172
  }
}
```

---

## Open Questions

1. **Multi-player support** — should one label file hold poses for both players in the same frame, or one file per player? Simplest: one file per (video, frame, player) tuple; player index added as a top-level field when needed.
2. **Loupe integration** — the ball-labeller loupe (magnifying glass on click) is useful for precise placement on small joints. Worth porting `loupeDraw.ts` once the basic tool works.
3. **Pose estimation bootstrap** — running a lightweight pose model (MoveNet, MediaPipe) client-side to give an initial skeleton that the labeller corrects would dramatically reduce click count. Viable via ONNX Runtime Web or TFLite WASM. Deferred to v2.
