# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### React apps (`ball-labeller-tool`, `ball-velocity-tool`, `homography-tool`)

Each app is independent — run commands from within its own directory:

```bash
npm run dev      # dev server
npm run build    # tsc -b && vite build
npm run lint     # eslint
```

### Python modules (`padel-engine`, `ball-detectors`, `player-detectors`)

Each has an isolated `.venv`. Activate before running:

```bash
source <module>/.venv/bin/activate
pip install -r <module>/requirements.txt   # first-time setup
```

CLI entry points (run from repo root with venv active):

```bash
python padel-engine/tools/detect_impacts.py   # outputs impact events CSV
python padel-engine/tools/detect_last_touch.py
```

### Tools

```bash
python3 tools/extract_plan_diagrams.py   # extracts mermaid blocks from plans/ → .dev/shots/diagrams/
```

## Architecture

### Monorepo layout

Three standalone React apps share no code with each other. Three Python modules share no venv. `tools/` holds ad-hoc OpenCV scripts that consume outputs from the Python modules.

### End-to-end pipeline

```
Video
  └─► homography-tool          → homography JSON (3×3 H matrix)
  └─► ball-labeller-tool       → labels CSV/JSON (per-frame ball annotations)
         ↓
  ball-detectors / player-detectors (Python, ONNX or blob)
         ↓
  padel-engine                 → impact events, touch events CSVs
         ↓
  tools/overlay_*.py           → annotated video output
```

### Coordinate systems

Two spaces used throughout — never mix them:
- **Pixel space** `(u, v)`: raw camera frame coordinates.
- **Court space** `(x, y)` in metres: x ∈ [0, 10], y ∈ [0, 20], net at y = 10. Origin is the near-left corner from the recording camera.

The homography JSON stores a 3×3 projective matrix H that maps pixel → court. Every module that does geometry loads this file first.

### ball-labeller-tool

Multi-step wizard: **Load → Label → Export**.

- `App.tsx` owns the `Map<frame, LabelRecord>` state and passes slices down.
- `labelStore.ts` persists that map to `localStorage` keyed by video filename.
- `VideoCanvas.tsx` draws directly on a `<canvas>` element; the loupe (magnifying glass on click) is rendered via `loupeDraw.ts`.
- `parseLabels.ts` / `exportCsv.ts` / `exportJson.ts` implement the versioned schema (see below).

**Label schema versions:**

| Version | Fields present |
|---|---|
| v0 | `frame`, `play_state`, `visibility`, `x`, `y` |
| v1 | + `impact` (surface: racket/floor/wall/fence/net) |
| v2 | + shot primitive dimensions + `shot_type` (planned — see `plans/2026-05-19-shot-type-labelling.md`) |

Version is auto-detected on load (presence of `impact` → v1, presence of `shot_type` → v2). It is written as a comment header in CSV (`# version: N`) and as a top-level field in JSON.

### padel-engine

Pure Python library. Three detectors run in order:

1. `motion_detector.py` — smooths raw ball positions into per-frame velocity + direction.
2. `impact_detector.py` — finds direction-change peaks; classifies surface using court geometry + player proximity.
3. `touch_detector.py` — assigns each impact to the nearest player.

All detectors accept and return `dict[int, <frame model>]` keyed by frame number. Models live in `padel_engine/models/`.

### Detector conventions

- **Ball detectors** (`ball-detectors/detector/`): each exposes `.detect(frame) → (u, v) | None`. Multiple strategies (blob v1–v4, YOLO, TrackNetV2/ONNX) are interchangeable.
- **Player detectors** (`player-detectors/detector/`): each exposes `.detect(frame) → list[PlayerFrame]`. v2 adds side assignment (`near`/`far` by court y) and status (`detected`/`extrapolated`/`occluded`).

### Design documents

`plans/` contains timestamped markdown files that record design decisions, failure analyses, and implementation specs. Mermaid diagrams in plans are rendered to `.dev/shots/diagrams/` via `tools/extract_plan_diagrams.py`. The current active spec for shot-type labelling is `plans/2026-05-19-shot-type-labelling.md`.
