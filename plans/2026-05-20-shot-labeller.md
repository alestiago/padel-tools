# Shot Labeller — Design Plan

**Goal:** A dedicated review tool (`shot-labeller`) that accepts a video and a ball-labeller export, finds every racket contact with no `shot_type`, plays a contextual video clip centred on that contact, and lets the labeller assign `shot_type`, `hand`, and `forcing` one shot at a time. Auto-advances to the next unlabelled contact after each confirmation.

---

## Context

`ball-labeller-tool` produces per-frame labels including `impact`, `shot_type`, `hand`, and `forcing`. In practice, labellers often mark racket contacts during a first positional pass without stopping to classify the shot. `shot-labeller` is a purpose-built second-pass tool: it surfaces only the unlabelled contacts and presents just enough video context to classify each one quickly.

---

## Clip Boundary Definition

Each unlabelled racket contact at frame **F** is shown as a video clip bounded as follows:

| Boundary | Rule |
|---|---|
| **Start** | Frame of the previous racket contact before F. If none exists, frame 0. |
| **End** | Frame of the next ball contact (any `impact` surface) after F, OR the first `play_state = dead` frame after F, whichever comes first. If neither exists, last frame of the video. |

**Rationale:** The clip from the previous racket hit to the next surface contact captures the full trajectory of the shot: the incoming ball, the stroke at F, and where the ball goes next. This is exactly the window a human expert uses to identify serve vs lob vs bandeja, etc.

A small **pre-roll buffer** (e.g. 10 frames before the start boundary) is applied so the labeller sees the ball in flight before the previous hit, not just the hit frame itself.

---

## Architecture

### Standalone app vs. extension of ball-labeller-tool

#### Option A — New standalone React app (`shot-labeller-tool`)

A new directory at repo root, same Vite + React + TypeScript + Tailwind stack as the other tools. Independent `package.json`. Shares no runtime code with ball-labeller (types are copied or extracted to a shared package later if needed).

**Pros:** Clean separation; ball-labeller stays unchanged; shot-labeller can evolve its own UX without coupling.  
**Cons:** Some duplication (ShotTypePicker, label parsing, export); slight bootstrap cost.

#### Option B — New step inside ball-labeller-tool

A fourth `AppStep` added to the existing wizard: Load → Label → **Review** → Export.

**Pros:** Zero new project; reuses all existing components and types verbatim; single deployment.  
**Cons:** Conflates two distinct workflows; ball-labeller already has a `load` step that doesn't ask for a labels file — adapting it adds complexity; the review UX (clip-centric, auto-advancing) is fundamentally different from the frame-by-frame UX.

#### Verdict — Option A

The two tools have different primary interactions. Keeping them separate avoids polluting ball-labeller's load/label flow with review concerns. Shared types (`LabelRecord`, `ShotType`, etc.) are small enough to duplicate until a shared package is warranted.

---

## Auto-Advance Trigger

Once the labeller sets a `shot_type`, the tool should advance automatically — the user's intent is clear and requiring an explicit "Next" button would double the click count. `hand` and `forcing` can be set before or after advancing; they are optional enrichments.

**Debated alternative:** Require an explicit "Confirm" action (Enter / button click) to allow adjusting all three fields before moving on. Verdict: auto-advance on `shot_type` selection, but allow the labeller to hold `Shift` (or press `B` / keyboard shortcut) to stay on the current clip and adjust `hand`/`forcing` before the advance fires. Simplest approach: a 400 ms delay before advancing so corrections can be made.

---

## UI Design

### Layout

```
┌─────────────────────────────────────────────────────┐
│  Shot Labeller          Shot 3 / 17    [Skip] [Back] │  ← header
├─────────────────────────────────────────────────────┤
│                                                     │
│              video player (looping clip)            │
│                                                     │
│  ████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │  ← clip progress
├──────────────────────┬──────────────────────────────┤
│  Shot type           │  Hand         Forcing        │
│  [ recent chips ]    │  [Forehand]  [Forced]        │
│  [ search input  ]   │  [Backhand]  [Unforced]      │
│  [ grouped list  ]   │                              │
└──────────────────────┴──────────────────────────────┘
```

- **Video** fills the top portion and loops the clip automatically.
- **Clip progress bar** shows position within the clip (not the full video), with a marker at the target frame F.
- **Shot type panel** (left of controls): recents + search, same interaction as `ShotTypePicker` in ball-labeller.
- **Hand + Forcing** (right of controls): two-button toggles, with SHOT_TYPE_CONSTRAINTS pre-selection applied automatically.
- **Header**: current shot index out of total unlabelled; Skip (moves to next without labelling); Back (returns to previous shot, discarding the just-applied label).

### Clip looping

The `<video>` element is seeked to `clipStart` and played. A `timeupdate` listener pauses and re-seeks to `clipStart` when `currentTime` reaches `clipEnd`, implementing a seamless loop without re-loading the source.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `T` | Focus shot type search |
| `F` / `B` | Forehand / Backhand |
| `U` / `R` | Unforced / forced (R = pRessed / Reduced) |
| `N` / `Tab` | Next shot (confirm + advance, or skip if no shot type set) |
| `←` / `→` | Rewind / fast-forward within the clip |
| `Space` | Play / pause |
| `Esc` | Return to previous shot |

---

## Data Flow

```
Load screen
  ├─ Drop / browse video file
  └─ Drop / browse labels JSON or CSV
        │
        ▼
Parse labels (reuse parseLabels logic)
Find unlabelled contacts: frames where impact = 'racket' AND shot_type = null
Sort ascending by frame
        │
        ▼
Review loop (one contact at a time)
  Seek video to clipStart
  Play clip (loop)
  User selects shot_type → write to working labels map → auto-advance after 400 ms
        │
        ▼
Done screen: all contacts labelled (or skipped)
  Export updated labels JSON / CSV
```

---

## State Model

```typescript
interface ReviewTarget {
  frame: number         // the unlabelled racket contact frame
  clipStart: number     // frame index (with pre-roll)
  clipEnd: number       // frame index
}

// Working copy of the full labels map, updated as the user labels each shot.
// Export at the end writes this map out.
type WorkingLabels = Map<number, LabelRecord>
```

The `currentIndex` pointer advances through `ReviewTarget[]`. Going back decrements it and reverts the working label for that frame to null.

---

## Skipped shots

Skipped contacts are moved to the end of the queue (or tracked separately). The header counter shows "Shot 3 / 17 (2 skipped)". A dedicated "Review skipped" pass is available from the done screen.

---

## Implementation Steps

### 1. Bootstrap `shot-labeller-tool/`
- `npm create vite@latest shot-labeller-tool -- --template react-ts`
- Add Tailwind CSS (same config as ball-labeller-tool).

### 2. Copy shared types and lib
- Copy `src/types.ts` from ball-labeller (or symlink / extract later).
- Copy `src/lib/parseLabels.ts`, `exportCsv.ts`, `exportJson.ts`.
- Copy `src/components/ShotTypePicker.tsx`.

### 3. `src/lib/buildReviewQueue.ts` (new)
- Input: `Map<number, LabelRecord>`, `fps: number`, `frameCount: number`.
- Output: `ReviewTarget[]` — one entry per racket contact with `shot_type === null`, sorted by frame.
- Clip start: `previousRacketFrame ?? 0`, minus 10-frame pre-roll, clamped to 0.
- Clip end: scan forward from F for next labelled frame with any `impact`, or first `play_state = dead` frame, or `frameCount - 1`.

### 4. `src/components/LoadScreen.tsx`
- Two drop-zones: video file + labels file.
- Parse labels on file select; show count of unlabelled racket contacts found.
- "Start review" button enabled once both files are loaded and at least one unlabelled contact exists.

### 5. `src/components/ReviewScreen.tsx`
- Owns `video` ref, `currentIndex`, `workingLabels` state.
- `useEffect` on `currentIndex`: seek to `clipStart`, play.
- `timeupdate` handler: if `currentTime >= clipEnd / fps`, seek back to `clipStart / fps` (loop).
- Renders `ClipProgressBar`, `ShotTypePicker`, hand + forcing buttons.
- `handleSetShotType`: writes to `workingLabels`, schedules 400 ms auto-advance.
- `handleSkip`: appends current target to skip queue, advances.
- `handleBack`: decrements index, reverts label to null.

### 6. `src/components/ClipProgressBar.tsx`
- A thin horizontal bar showing position within the clip.
- A fixed marker at the target frame F (normalised within clip).
- Clickable to seek within the clip.

### 7. `src/components/DoneScreen.tsx`
- Shows how many shots were labelled vs skipped.
- "Review skipped" button restarts the loop over the skip queue.
- Export JSON / Export CSV buttons (same output format as ball-labeller).

### 8. `src/App.tsx`
- Three-state machine: `'load' | 'review' | 'done'`.
- Passes `workingLabels` through to export.

---

## Open Questions

1. **Pre-roll duration** — 10 frames at 25 fps ≈ 400 ms. Is that enough context before the previous racket contact, or should the pre-roll extend further back (e.g. 30 frames)?

2. **Post-roll** — Should the clip extend a few frames beyond the next surface contact so the labeller sees the ball land fully? Currently the plan stops exactly at the next contact frame.

3. **Hand / forcing on auto-advance** — If the labeller selects a shot type and the 400 ms timer fires before they set hand/forcing, should those fields be left null, or should SHOT_TYPE_CONSTRAINTS auto-apply them? Answer: SHOT_TYPE_CONSTRAINTS always apply on shot_type selection; hand/forcing can then be overridden within the window.

4. **Labels-only mode** — Should the tool support labelling from labels alone (without video), showing only frame metadata? Likely not — the whole value is the video clip.

5. **Multiple labellers / merge** — If two labellers work on separate halves of the video, the export format is the same and merging is a simple frame-union. No tool support needed yet.
