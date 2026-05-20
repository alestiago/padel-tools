# Point Outcome Labelling — Design Plan

**Goal:** When a point ends (`play_state → dead`), label (a) the outcome of the final shot — winner / assist / unforced_error / forced_error, with an "assisted by glass" flag for winners — and (b) which player hit each racket-impact shot (A1 / A2 / B1 / B2).

---

## Terminology

| Term | Meaning |
|---|---|
| **winner** | The shot directly and immediately won the point |
| **assist** | The shot set up the opportunity; the partner finished the point (useful in pairs context) |
| **forced_error** | Your shot put the opponent under enough pressure that they made an error |
| **unforced_error** | The opponent made an error not attributable to your shot's pressure |
| **assisted** (sub-flag) | Modifier on `winner` only: the winning shot was assisted by the back/side glass (common in padel — the ball bounced off the glass in a way that made it unreturnable) |
| **player** | A1 / A2 (team A, players 1 and 2) or B1 / B2 (team B) |

---

## Two Concerns to Separate

These two features are related but independent:

1. **Player attribution** — *who hit each shot?* Applies to every racket impact, not just the last one. Useful for per-player ML features regardless of point outcome.
2. **Point outcome** — *how did this point end?* Applies once per point (the final shot). Includes outcome + assisted flag.

Separating them keeps each simpler to implement and reason about.

---

## Part 1 — Player Attribution

### Option A — Per-shot (on every racket impact)

Add a 4-button selector (A1 / A2 / B1 / B2) inside the `ImpactSelector` panel when `impact = racket`, alongside the existing shot-type picker.

**Pros:** Labellers capture who hit every shot; full per-shot attribution for ML; sticky player reduces effort for serving sequences.  
**Cons:** Extra 1-click overhead on every racket frame.

### Option B — Only on the final shot of each point

Show the player selector only as part of the point-outcome panel (only on the final racket impact before dead).

**Pros:** Less total effort; sufficient if the only use-case is "who hit the last shot."  
**Cons:** Throws away per-shot player data; can't build per-player shot-type distributions from labels.

### Option C — Sticky inference

Infer player from side-of-court position (using homography + player detections). Auto-set, labeller only corrects mistakes.

**Pros:** No extra clicks at all; consistent.  
**Cons:** Requires player detections to be available and aligned; adds a dependency that isn't always present during labelling.

### Verdict — Option A

Per-shot player attribution is materially more valuable for ML training. The cost is one additional button click per racket impact (easily offset by stickiness — in a typical rally, each player stays the same until the ball crosses the net). A sticky `stickyPlayer` state (same UX pattern as `stickyPlay` and `stickyShot`) means players hit consecutive shots on their side without re-selecting.

---

## Part 2 — Point Outcome

### Where to store outcome data?

This is the most consequential decision because it determines both the data model and the UI trigger.

#### Store on the last racket impact frame

Outcome, assisted, and (optionally) player are co-located on the actual shot frame.

**Pros:** All shot-level data on one frame; conceptually clean ("this shot won/lost the point").  
**Cons:** Requires backward search from the dead sequence to identify the frame — fragile if that frame isn't labelled yet; navigating to it requires an extra seek; the UI must know to show outcome controls on a non-dead frame.

#### Store on the first dead frame of the sequence

The "first dead frame" is defined as: a dead-labelled frame whose immediately preceding frame is not dead (or is unlabelled). Outcome lives there.

**Pros:** The dead→in_play boundary is unambiguous; the labeller is naturally at or near this frame when the point ends; no backward search needed.  
**Cons:** Outcome is on a different frame than the shot it describes; need to define "first dead frame" carefully when frames are sparse.

#### Store as a separate point record (parallel structure)

A separate `Map<pointId, PointOutcome>` keyed by, e.g., the frame of the first dead label in the sequence.

**Pros:** Clean separation of concerns; no overloading of `LabelRecord`.  
**Cons:** Two data structures to serialise, version, and import; more complex state management; harder to keep in sync with frame labels.

#### Verdict — Store on the first dead frame

The first dead frame is the natural semantic anchor for "point ended here." It requires no backward search: when the labeller presses D and advances, the first frame they label as dead is trivially identified. The outcome panel appears in the sidebar whenever `currentFrame` is the first dead frame of its sequence, defined as:

```
isFirstDeadFrame(f) =
  labels.get(f)?.play_state === 'dead'
  AND labels.get(f - 1)?.play_state !== 'dead'
```

If frames before the dead sequence are unlabelled (gap), `f-1` is undefined → treated as in_play → still correctly triggers.

---

### How to trigger the outcome UI?

#### Trigger A — Auto-panel on D key press

Pressing D opens an inline outcome modal before the sticky play state changes.

**Pros:** Impossible to forget; tight single-pass workflow.  
**Cons:** Interrupts navigation if D was pressed by accident; modal feels heavy; labellers often mark many frames as dead in rapid succession before stopping to label outcome.

#### Trigger B — Sidebar panel auto-appears when on first dead frame

No modal. When `currentFrame` is the first dead frame of a sequence, the sidebar shows the outcome section automatically below `PlayStateSelector`.

**Pros:** Non-intrusive; fits existing sidebar-driven UX; labeller can set outcome whenever they want; no interruption.  
**Cons:** Easy to miss if the labeller moves past the first dead frame quickly.

#### Trigger C — "Jump to next unresolved outcome" shortcut

Shortcut `E` finds the next first-dead frame without an outcome set and seeks to it. Enables a separate outcome-labelling pass after the main ball-position pass.

**Pros:** Excellent for two-pass workflows; labeller doesn't have to think about it during position labelling.  
**Cons:** Requires a second pass; outcome not labelled in real-time with the action.

#### Verdict — B + C

Sidebar auto-appearance (B) handles the natural flow: the labeller presses D, the sidebar immediately shows the outcome section, they label it, continue. Shortcut `E` (C) catches any missed points during a review pass. These are complementary, not exclusive.

---

## Recommended Design

### Player selector (per racket impact)

A 4-button toggle row added to the `ImpactSelector` panel (above the shot type picker, when `impact = racket`):

```
Player   [ A1 ]  [ A2 ]  [ B1 ]  [ B2 ]
```

- Sticky: `stickyPlayer` persists until changed (same pattern as other sticky states).
- Applied automatically when setting `impact = racket`, like `stickyShot`.
- Keyboard shortcut: none needed initially — one click suffices given stickiness.

### Outcome panel (first dead frame of each point)

When `isFirstDeadFrame(currentFrame)` is true, the `PlayStateSelector` section in the sidebar expands to show:

```
Play state  [In Play]  [Dead]

─── Point outcome ───────────────
[ Winner ]  [ Assist ]
[ Forced error ]  [ Unforced error ]

  ↳ if winner selected:
  Assisted by glass?  [ No ]  [ Yes ]
```

- Compact 2×2 button grid for the four outcomes.
- "Assisted by glass" toggle appears only when `outcome = winner`.
- Clicking the active outcome clears it (same toggle pattern used elsewhere).
- Outcomes are colour-coded: winner = green, assist = teal, forced_error = amber, unforced_error = red.

### `E` shortcut — jump to next unresolved point end

`E` seeks to the next first-dead frame that has no outcome set. Useful for review passes. Hint added to the shortcuts list.

### Timeline enhancement

The timeline already marks dead frames in red. Add a small downward tick at each first-dead frame, coloured by outcome (green/teal/amber/red) if set, white if unresolved. This gives a visual overview of point boundaries and labelling completeness.

### VideoCanvas

When `currentFrame` is a first-dead frame and outcome is set, show a small outcome badge near the top of the canvas (e.g., `WIN`, `AST`, `FRC`, `UFE`) in the outcome colour. Non-intrusive — small and fixed position.

---

## Schema

`LabelRecord` gains three new fields:

```typescript
// Shown / editable when impact = 'racket'
player: 'A1' | 'A2' | 'B1' | 'B2' | null

// Stored on the first dead frame of a point sequence; null on all other frames
outcome: 'winner' | 'assist' | 'forced_error' | 'unforced_error' | null
assisted: boolean | null   // only meaningful when outcome = 'winner'
```

`LabelVersion` bumps to `3` when any `outcome` is non-null or any `player` is non-null.

---

## CSV / JSON format additions

CSV column additions (after `shot_type`):
```
player,outcome,assisted
```

`assisted` is exported as `true` / `false` / `` (empty when null).

---

## Implementation Steps

### 1. `src/types.ts`
- Add `Player = 'A1' | 'A2' | 'B1' | 'B2'` type and `PLAYERS` const.
- Add `PointOutcome = 'winner' | 'assist' | 'forced_error' | 'unforced_error'` type.
- Add `OUTCOME_LABELS`, `OUTCOME_ABBR`, `OUTCOME_COLORS` record maps.
- Add `player`, `outcome`, `assisted` to `LabelRecord`.

### 2. `src/components/PlayerSelector.tsx` (new)
- Props: `value`, `onChange`.
- Renders 4 buttons: A1 / A2 / B1 / B2. Active button highlighted.

### 3. `src/components/OutcomeSelector.tsx` (new)
- Props: `outcome`, `assisted`, `onOutcomeChange`, `onAssistedChange`.
- Renders 2×2 outcome grid + conditional `Assisted by glass?` toggle.
- Shows only when passed `visible={true}` from the parent.

### 4. `src/components/ImpactSelector.tsx` (update)
- Add `player`, `onPlayerChange` props.
- Render `<PlayerSelector>` above `<ShotTypePicker>` when `value === 'racket'`.

### 5. `src/components/PlayStateSelector.tsx` (update)
- Add `outcome`, `assisted`, `showOutcome` props.
- When `showOutcome` is true, render `<OutcomeSelector>` below the play state buttons.

### 6. `src/components/LabelStep.tsx` (update)
- Add `stickyPlayer: Player | null` state.
- `isFirstDeadFrame(f)`: check `labels.get(f)?.play_state === 'dead'` and `labels.get(f-1)?.play_state !== 'dead'`.
- `handleSetPlayer(p)`: update current frame, update sticky. Applied automatically alongside `stickyShot` when impact → racket.
- `handleSetOutcome(o)`: finds the first dead frame of the current dead sequence, updates outcome there.
- `handleSetAssisted(b)`: same, updates assisted flag.
- Pass `showOutcome={isFirstDeadFrame(currentFrame)}` to `PlayStateSelector`.
- `E` key: seek to next first-dead frame with null outcome.
- Add `T — search shot types` and `E — next unresolved outcome` to shortcut hint list.

### 7. `src/components/Timeline.tsx` (update)
- Detect first-dead frames and draw a small downward tick at each.
- Tick colour: outcome colour if set, white if unresolved.

### 8. `src/components/VideoCanvas.tsx` (update)
- When on a first-dead frame with outcome set, draw a small badge (e.g., `WIN`) near top-centre.

### 9. `src/lib/exportCsv.ts` (update)
- Add `player`, `outcome`, `assisted` columns.
- Version `3` when any player or outcome field is non-null.

### 10. `src/lib/exportJson.ts` (update)
- Version `3` when any player or outcome field is non-null.

### 11. `src/lib/parseLabels.ts` (update)
- `LabelVersion` → `0 | 1 | 2 | 3`.
- `detectVersion`: `player` or `outcome` column present → `3`.
- Parse `player`, `outcome`, `assisted` on load; default to `null` / `null` / `null`.

### 12. `src/lib/labelStore.ts` (update)
- Back-compat: default `player: null`, `outcome: null`, `assisted: null` on load.

### 13. `src/components/LoadStep.tsx` (update)
- Version toggle extended to `v3`.

### 14. `src/components/ExportStep.tsx` (update)
- Add "Points with outcome: N / M point ends" row.
- Add "Players attributed: N / M racket impacts" row.

---

## Open Questions

1. **"Assisted by glass" semantics** — Should `assisted` mean "the glass was involved" (padel-specific) or "assisted by partner's setup shot"? The latter overlaps with the `assist` outcome. Clarify before implementing to avoid ambiguity in the exported data.

2. **Stickyness of `stickyPlayer`** — Should `stickyPlayer` reset when the labeller switches from one dead sequence to the next in_play sequence, or persist across points? In padel doubles the same two players are always on the same side, so persisting is probably right.

3. **Outcome on unlabelled boundary frames** — If the first dead frame after a in_play sequence has no `play_state` label yet (because the labeller jumped ahead), `isFirstDeadFrame` may mis-identify frames. Should we require contiguous labelling, or handle gaps gracefully with a lookahead?

4. **Retroactive outcome labelling** — Should the `E` shortcut also surface first-dead frames where outcome was set but `assisted` was not set even though outcome is `winner`? Treating partially-labelled outcomes as "unresolved" would be more thorough.

5. **Team label convention** — A/B are arbitrary team assignments. Should the tool prompt the labeller to assign teams at load time (e.g., "which team is A?"), or leave this to convention in the export?
