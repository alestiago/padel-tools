# Plan — Ball Labeller Tool

A web tool (Vite + React + TypeScript + Tailwind) where the user loads a video and manually labels the ball position frame by frame. The output is a JSON file consumable by the rest of the pipeline (e.g., as ground-truth for model evaluation or as a fallback when automated detectors fail).

---

## Interface Options

### Option A — Frame-by-frame scrubber with click annotation ★ RECOMMENDED

The user navigates frames one at a time with arrow keys and clicks the ball position on the canvas. Two independent sticky dimensions — **play state** and **visibility** — are set via keyboard shortcuts or sidebar selectors and persist across frames until changed.

```
┌──────────────────────────────────────────────┐
│  [Video canvas — click to mark ball]         │
│                                              │
│  ● previous label dots (trail, last 5)       │
│  ✕ current frame marker                      │
│                                              │
│  [loupe magnifier near cursor, like homog.]  │
└──────────────────────────────────────────────┘
│ ◀◀  ◀  ▶  ▶▶     Frame 142 / 3600   00:04.7 │
│ ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  ← labelled/unlabelled indicator
└──────────────────────────────────────────────┘
Sidebar: status buttons + stats + export
```

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `→` / `←` | Next / previous frame |
| `Shift+→` / `Shift+←` | Jump 10 frames |
| `P` | Set play state: **in play** (sticky) |
| `D` | Set play state: **dead** (sticky) |
| `V` | Set visibility: **visible** (sticky — click canvas to set position) |
| `O` | Set visibility: **occluded** (sticky — click canvas for estimated position) |
| `F` | Set visibility: **out of frame** (sticky — no click needed) |
| `Backspace` | Clear current frame label |
| `Ctrl+Z` | Undo |
| `Space` | Toggle play/pause (for context review) |
| `G` | Jump to next unlabelled frame |

**Pros:**
- Standard in professional annotation tools (CVAT, LabelStudio, Supervisely).
- Arrow-key navigation is extremely fast — annotators reach >200 frames/min.
- Click-on-canvas is the most spatially precise input method available in a browser.
- Fits naturally with the magnifying loupe already implemented in `homography-tool`.
- No ML dependency — works offline, zero latency.

**Cons:**
- Pure manual — slow for long videos.
- Requires sustained user attention frame by frame.

---

### Option B — Playback + real-time click marking

The video plays at reduced speed (0.25×–0.5×) and the user clicks the ball while it plays, like a rhythm game. Gaps where no click was made are flagged for review.

**Pros:**
- Feels natural for experienced annotators.
- Faster for dense rallies with a continuously visible ball.

**Cons:**
- Timing the click to the right frame is physically hard at ≥25 fps.
- Reduced speed is still too fast for 60 fps padel footage.
- Correcting mistakes requires scrubbing back, which is more friction than Option A.
- Ball moves across multiple pixels per frame — click timing error of even one frame shifts the position significantly.

---

### Option C — Auto-suggest + correction

Run a blob/color detector or TrackNetV2 in-browser (ONNX) on the full video first, then show the proposed positions and let the user approve, reject, or drag-correct each frame.

**Pros:**
- Dramatically faster when the detector is ≥60% accurate.
- Leverages existing `onnxruntime-web` infrastructure.

**Cons:**
- Requires an ONNX model (either blob heuristic or TrackNetV2) to be loaded.
- Detector failures cluster (e.g., ball behind a player for 30 frames straight) — reviewing a run of bad suggestions is not faster than labelling from scratch.
- Adds significant implementation complexity (two-pass pipeline, drag-to-correct UI).
- Suitable as a v2 enhancement, not a v1 foundation.

---

### Option D — Sparse keyframe labelling + interpolation

User labels only key frames (ball bounces, direction changes) and the tool interpolates positions between them.

**Pros:**
- Minimum labelling effort.

**Cons:**
- Ball trajectory in padel is not linear: topspin, after-bounce acceleration, glass reflections, etc.
- Linear interpolation introduces systematic errors between keyframes.
- Interpolated labels are not ground-truth — defeats the purpose of a labeller.

---

## Recommendation: Option A

Frame-by-frame scrubber with click annotation. It is the simplest to implement, the most precise, and matches the mental model of every existing annotation tool. Option C (auto-suggest) is a natural v2 extension and can be added on top of Option A's data model without changes.

---

## Label Dimensions

Each frame carries two independent sticky values. Storing both explicitly (not just null/non-null coordinates) is essential for training signal: a model should learn differently from "ball is definitely not here" vs "we don't know", and rally-segmentation logic needs play state independently of whether the ball is visible.

### Play State (sticky)

Tracks whether the ball is active in a rally. Toggled once at rally boundaries and held until the next boundary.

| Value | Key | Meaning |
|-------|-----|---------|
| `in_play` | `P` | Ball is part of an active rally |
| `dead` | `D` | Ball not in play (between points, pick-up, serve preparation) |

### Visibility (sticky)

Tracks whether and where the ball can be seen. Toggled whenever the ball's visibility changes.

| Value | Key | x/y | Meaning |
|-------|-----|-----|---------|
| `visible` | `V` | set | Ball clearly seen; user clicked its center |
| `occluded` | `O` | optional | Ball hidden behind a player or object; click for an estimated position |
| `out_of_frame` | `F` | null | Ball left the camera view entirely |

### Unlabelled

A frame where neither dimension has been set yet. This is the default state; it means "not yet reviewed", not "no ball". Exported separately or omitted, depending on export settings.

### Stickiness

Both dimensions are sticky: selecting a value sets a persistent mode that applies to every subsequent frame until the user explicitly changes it. The sidebar shows the currently active mode for each dimension with a highlighted button. This is how professional annotation tools work — the annotator sets a context (e.g., "in_play + visible") and navigates through frames, only pressing keys when something changes.

Example workflow for a rally:
1. Press `P` (in play) + `V` (visible) → click ball position on frames 142–160.
2. Ball goes behind a player → press `O` (occluded) → advance frames 161–163 without clicking.
3. Ball exits frame → press `F` (out of frame) → advance frame 164.
4. Point ends → press `D` (dead) + `F` (still out of frame) → advance through inter-point frames.
5. Next rally starts → press `P` + `V` → continue clicking.

---

## Handling Edge Cases

### Ball out of frame
- User presses `F` — no canvas click required.
- Timeline bar shows this frame in a distinct colour (e.g., grey).
- Useful for tracking the ball's exit direction: could add an optional "exit side" selector (left / right / top / bottom) as a future enhancement.

### Ball obscured by a player or object
- User presses `O`. Optionally can still click an estimated position (stored with `occluded` status so downstream code can choose to use or ignore it).
- Trail of previous dots helps the user extrapolate where the ball likely is.
- The loupe magnifier helps see through player silhouettes (ball is often visible at the arm/racket edge).

### Dead ball (between points)
- User presses `D` to switch play state to dead. The visibility dimension is independent — a dead ball may still be `visible` (e.g., bouncing out of court) or `out_of_frame` (picked up off-camera).
- Rally boundaries are derivable from the exported data: first `dead`→`in_play` transition in `play_state` marks a rally start.

### Ball in motion blur
- Ball center is still estimable even when blurred — user clicks the center of the blur smear.
- No special state; status is `visible`.
- Optionally add a `blur` boolean flag per frame (future enhancement, useful for training data filtering).

### Multiple balls visible
- Common in practice sessions (spare balls on court floor).
- Convention: label the ball currently in play (the one in motion or most recently struck).
- Sidebar shows a note: "label the ball in play".

### Serve toss
- Ball is in the air and clearly visible but the point hasn't started.
- Use `dead + visible` — the ball has a real pixel position but play state is still dead. Downstream filtering can decide whether to include toss frames in velocity calculations.

### Video frames with no ball detection confidence
- Status `unlabelled` means skip, not "no ball". The export omits `unlabelled` frames by default (configurable).

---

## Core Functionalities

### 1. Video loading
- `<input type="file">` accepting `.mp4`, `.mov`, `.webm`.
- Rendered in a `<video>` element; frame extraction via `<canvas>` + `drawImage`.
- FPS detection: `video.duration` + a binary-search seek to measure frame boundaries (same technique used in `ball-velocity-tool`).

### 2. Frame navigation
- Seeking to an exact frame: `video.currentTime = frame / fps`.
- Arrow keys call `seekToFrame(current ± 1)`.
- Frame counter + time display in the toolbar.
- Timeline slider with per-frame colour coding encoding both dimensions: e.g., green = in_play+visible, orange = in_play+occluded, grey = any+out_of_frame, red stripe = dead, white = unlabelled.

### 3. Click-to-label on canvas
- Canvas overlays the video element at the same pixel dimensions.
- Click event → translate from canvas CSS coords to video pixel coords (account for `object-fit: contain` letterboxing).
- On click: store `{frame, play_state, visibility: 'visible', x, y}` using the current sticky play state, and advance to next frame automatically (configurable).

### 4. Magnifying loupe
- Reuse the loupe from `homography-tool` (`drawLoupe.ts`).
- Follows the cursor while the mouse is over the canvas.
- 4× zoom in a 120px circle showing the region around the cursor.
- Crosshair overlay in the loupe center.

### 5. Label trail overlay
- Render the last N (default 5) labelled positions as semi-transparent dots on the canvas.
- Dots are colour-coded by status. Helps the user see the ball's recent trajectory and extrapolate.

### 6. Status selectors (two groups, both sticky)
- **Play state group**: [In Play `P`] [Dead `D`] — toggle buttons, one always active.
- **Visibility group**: [Visible `V`] [Occluded `O`] [Out of Frame `F`] — toggle buttons, one always active.
- Both groups show their active selection highlighted at all times.
- Switching either dimension applies immediately to the current frame and all subsequent frames until changed again.
- The current combination (e.g., "In Play / Occluded") is summarised in a status bar above the canvas.

### 7. Undo / redo
- Simple stack of `LabelRecord[]` snapshots. Ctrl+Z / Ctrl+Shift+Z.
- Undo removes the last action (label, clear, status change).

### 8. Progress tracking
- Sidebar shows: total frames, labelled count, breakdown by status.
- "Jump to next unlabelled" shortcut (`G`) for efficient gap-filling.

### 9. Auto-save to localStorage
- Debounced save of the full label set every 2 seconds.
- On page load: detect saved session for the same filename, offer to restore.
- Prevents data loss on accidental page refresh.

### 10. Import existing labels
- Load a previously exported JSON to continue a session.
- Merges with current labels (existing entries overwrite imported ones by default).

### 11. Export
- Button: "Export JSON" — downloads the label file.
- Option: "Export CSV" (flat, one row per frame).
- Omit `unlabelled` frames from the export by default; option to include them.

### 12. Frame skip mode (efficiency)
- Toggle: "Label every N frames" (default N=1). Keyboard navigation jumps by N.
- Useful for long videos where the ball trajectory is smooth — label every 3rd frame and interpolate only for display, not for export.

---

## Output Format

```json
{
  "version": 1,
  "video_file": "match.mp4",
  "fps": 30.0,
  "frame_count": 3600,
  "frame_size": { "width": 1920, "height": 1080 },
  "labels": [
    { "frame": 0,   "play_state": "dead",    "visibility": "out_of_frame", "x": null, "y": null },
    { "frame": 142, "play_state": "in_play", "visibility": "visible",      "x": 834,  "y": 512  },
    { "frame": 143, "play_state": "in_play", "visibility": "visible",      "x": 901,  "y": 498  },
    { "frame": 144, "play_state": "in_play", "visibility": "occluded",     "x": 950,  "y": 490  },
    { "frame": 145, "play_state": "in_play", "visibility": "out_of_frame", "x": null, "y": null }
  ]
}
```

CSV equivalent:
```
frame,time_s,play_state,visibility,x,y
0,0.000,dead,out_of_frame,,
142,4.733,in_play,visible,834,512
143,4.767,in_play,visible,901,498
144,4.800,in_play,occluded,950,490
145,4.833,in_play,out_of_frame,,
```

---

## App Structure

Same scaffold as `ball-velocity-tool` and `homography-tool`:

```
padel_tools/
├── ball-labeller-tool/
│   ├── index.html
│   ├── vite.config.ts
│   ├── package.json          (Vite 8, React 19, TS ~6, Tailwind 4)
│   └── src/
│       ├── main.tsx
│       ├── App.tsx           (step router: Load → Label → Export)
│       ├── types.ts          (LabelRecord, PlayState, Visibility, SessionState)
│       ├── components/
│       │   ├── LoadStep.tsx      (video file picker)
│       │   ├── LabelStep.tsx     (main annotation canvas + sidebar)
│       │   ├── VideoCanvas.tsx   (canvas overlay, loupe, trail dots)
│       │   ├── Timeline.tsx      (frame slider with label colours)
│       │   ├── PlayStateSelector.tsx  (In Play / Dead sticky toggle)
│       │   ├── VisibilitySelector.tsx (Visible / Occluded / Out of Frame sticky toggle)
│       │   └── ExportStep.tsx    (summary + download buttons)
│       └── lib/
│           ├── frameSeeker.ts    (precise video frame seek logic)
│           ├── loupeDraw.ts      (loupe, copied/adapted from homography-tool)
│           ├── labelStore.ts     (in-memory + localStorage persistence)
│           ├── exportJson.ts     (serialise to JSON)
│           └── exportCsv.ts      (serialise to CSV)
```

---

## Implementation Steps

1. **Scaffold** `ball-labeller-tool` from `npm create vite@latest` (React + TS). Add Tailwind 4.
2. **LoadStep**: video file picker, read duration + detect FPS. Store in state.
3. **VideoCanvas**: overlay canvas on video element, handle coordinate mapping with letterbox correction.
4. **Frame seeking**: implement `seekToFrame` with a settled-seek promise (listen for `seeked` event).
5. **Click-to-label**: canvas `click` handler → compute video pixel coords → save label.
6. **Keyboard shortcuts**: `useEffect` with `keydown` listener mapping arrow keys and status shortcuts.
7. **Loupe**: port `drawLoupe.ts` from `homography-tool`, render after each seek.
8. **Trail overlay**: draw last 5 labelled positions as dots after each seek.
9. **Timeline**: colour-coded slider (`<input type="range">` or custom canvas bar).
10. **Sticky selectors sidebar**: two independent toggle groups (play state + visibility) with keyboard shortcut hints. Changing either updates the active mode and applies it to the current frame.
11. **Undo stack**: wrap label mutations in a reducer with history.
12. **localStorage auto-save**: debounced `useEffect` on label state.
13. **ExportStep**: JSON + CSV download via Blob URL.

---

## Notes

- **No ONNX / ML needed for v1** — the tool is purely manual. Keeps the build simple and load time fast.
- **Coordinate system**: pixel coords in the original video resolution (not canvas display size). Downstream tools can apply homography if needed.
- **FPS detection edge case**: some container formats report 0 fps until metadata loads — defer FPS detection to `loadedmetadata` event.
- **No homography dependency**: unlike `ball-velocity-tool`, this tool does not require a `homography_video.json`. It outputs raw pixel positions; callers apply H themselves.
- **Future v2**: add an "auto-suggest" pass using the TrackNetV2 ONNX model (already available in `ball-velocity-tool/src/lib/tracknetDetector.ts`) to pre-fill labels, then let the user correct.
