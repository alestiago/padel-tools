# Shot Type Labelling UI — Design Plan

**Goal:** After marking a frame as `impact = racket`, let the labeller assign a shot type as quickly as possible. The labelling session involves watching video frame by frame; every extra click or keypress away from the video costs time and breaks rhythm.

---

## Context: What Already Exists

`plans/2026-05-19-shot-type-labelling.md` specifies a full primitive-dimensions approach: the labeller sets ~8 observable attributes (contact_height, spin, bounced, etc.) and the shot type **derives automatically**. That plan is thorough and produces rich ML training data, but it is expensive per frame — 3–6 toggle clicks per impact. This plan evaluates whether a simpler direct-selection UI can get comparable quality faster.

The 20 shot types (from the existing spec):
`serve | drive | high_volley | passing_volley | low_volley | volley_chiquita | lob | volley_lob | salida_lob | smash | gancho | kick_smash | rulo | bandeja | vibora | bajada | salida | salida_chiquita | chiquita | contrapared | contrapared_lateral`

---

## UI Alternatives

### A — Dimension Primitives (existing plan)

The labeller sets contact_height, bounced, spin, etc.; shot type is derived.

**Pros:** Consistent; resolves ambiguous cases via rules; produces primitive dimension data useful for ML beyond shot type alone.  
**Cons:** 3–6 clicks per impact even for common shots; requires the labeller to decompose what they saw rather than recognise it holistically; cognitive overhead mid-session.

**Verdict:** Appropriate when the primitives themselves are training targets. Too slow when only `shot_type` is needed.

---

### B — Typeahead Input

A text field that filters the 20 shot names as you type (e.g. `ba` → bandeja, bajada).

**Pros:** Compact; familiar pattern; handles all 20 types equally.  
**Cons:** Requires keyboard hand movement on every new shot type; hard to operate one-handed; mouse labellers must switch input device; autocomplete is slower than direct tap when options are few.

**Verdict:** Good fallback / search mechanism, not the primary interaction.

---

### C — Full Grid of Shot Chips

All 20 shot types rendered as coloured buttons, grouped by contact category (overhead / volley / ground / wall), visible whenever `impact = racket` is selected. One click sets the type; clicking the active type clears it.

**Pros:** No typing; all options visible; one click.  
**Cons:** 20 buttons is visually busy in a 220 px sidebar; rare shots (kick_smash, contrapared_lateral) occupy the same visual weight as common ones (drive, bandeja); panel height grows large.

**Verdict:** Viable but needs pruning. Better as a grouped compact layout.

---

### D — Sticky Shot + Recents Bar

Shot type is **sticky** (persists across frames until changed), just like `play_state` and `visibility` already are in the tool. The sidebar shows only the **6–8 most recently used** shots as large, quickly re-tappable buttons. A small "Change…" button opens an inline typeahead for anything not in the recents list.

**Pros:** Zero extra clicks when consecutive racket impacts are the same shot (very common in padel — a player hits 3 bandeja in a row); minimal sidebar space; matches the existing sticky UX pattern.  
**Cons:** First use of a session requires going through the typeahead; recents list is session-scoped and starts empty; less discoverable for new labellers.

**Verdict:** Fastest in steady-state once warmed up; best for dense, single-session labelling runs.

---

### E — Two-Level Category Picker

Level 1: four broad category buttons rendered inline with the impact selector — **Overhead / Volley / Ground / Wall**. Selecting one swaps the impact sub-panel to show only the 4–6 shot types in that category.

**Pros:** Reduces choices at each step (4 → 4–6); visually manageable; matches how a labeller mentally classifies shots (category first, then sub-type).  
**Cons:** Two clicks per shot type change; requires committing to a category before seeing sub-types.

**Verdict:** Good for discoverability and new labellers; slightly slower than the recents-bar for experienced ones.

---

## Recommendation: D + B (Sticky Recents + Typeahead Fallback)

The dominant use-case is a single labeller watching a complete rally and tagging every racket contact. Padel rallies have strong shot-type locality: a player at the net will hit several volleys in a row; overhead sequences cluster. Stickiness exploits this directly — the labeller only acts when the shot *changes*, not on every frame.

**Specific design:**

1. **Sticky shot type badge** — sits directly below the `ImpactSelector` in the sidebar, always showing the current sticky shot type in its colour (reuses the colour scheme from the existing plan). Clicking it opens the picker.

2. **Recents tray** — 6 chips laid out in a 2×3 grid showing the most recently used shot types this session, ordered by recency. Each chip is a single click to set + sticky.

3. **"All shots" button** — below the tray, opens an inline searchable panel listing all 20 shot types grouped by category. Selecting one sets the shot type, adds it to the recents tray, and closes the panel. Keyboard shortcut `T` focuses this input directly.

4. **Shot type auto-set on impact** — when the labeller presses `I` to cycle to `racket` impact, the current sticky shot type is applied to that frame automatically. No extra click needed if the shot type hasn't changed.

5. **VideoCanvas badge** — three-letter abbreviation drawn below the impact diamond (as in the existing plan) so the labeller can see the shot type without looking at the sidebar.

**What this defers:** The full primitive dimensions (contact_height, spin, bounced, etc.) are not collected in this UI. They can be added in a second pass via a dedicated refinement tool, or collected by the dimension-primitive UI from the existing plan used separately on completed label sets. Storing `shot_type` directly (not derived) is the right schema for this approach — see schema section below.

---

## Keyboard Shortcut

`T` — focus the shot type search input. Type the first 2–3 letters, hit Enter to confirm and close.

Keeps hands close: `I` cycles to racket impact, `T` optionally changes shot type, arrow keys advance.

---

## Shot Type Groupings (for the "All shots" panel)

| Category | Shots |
|---|---|
| Overhead | smash · gancho · kick_smash · rulo · bandeja · vibora |
| Volley | high_volley · passing_volley · low_volley · volley_lob · volley_chiquita |
| Ground | drive · lob · chiquita · serve |
| Wall | salida · salida_lob · salida_chiquita · bajada · contrapared · contrapared_lateral |

---

## Schema

`LabelRecord` gains a single new field:

```typescript
shot_type: ShotType | null   // null until explicitly set
```

`ShotType` is a union of all 20 string literals. Stored directly — not derived from primitives (that remains a future option via the existing plan). Version bump: `v2` when any label has a non-null `shot_type`.

`labelStore.ts` back-compat: existing v1 labels default `shot_type` to `null` on load.

---

## Implementation Steps

### 1. `src/types.ts`
- Add `ShotType` union type and `SHOT_TYPES` const array.
- Add `SHOT_TYPE_GROUPS` mapping category → `ShotType[]` (four groups above).
- Add `SHOT_TYPE_LABELS` and `SHOT_TYPE_COLORS` record maps.
- Add `shot_type: ShotType | null` to `LabelRecord`.

### 2. `src/components/ShotTypePicker.tsx` (new)
- Props: `value: ShotType | null`, `recents: ShotType[]`, `onSelect: (t: ShotType | null) => void`, `searchFocused: boolean`, `onSearchFocus: () => void`.
- Renders: sticky badge (current value, coloured), 2×3 recents grid, `T` hint, inline collapsible "All shots" grouped list with a filter `<input>`.
- Manages its own open/closed state for the "All shots" panel.

### 3. `src/components/ImpactSelector.tsx` (update)
- No change to surface selection logic.
- When `value === 'racket'`, render `<ShotTypePicker>` below the surface buttons.

### 4. `src/components/LabelStep.tsx` (update)
- Add `stickyShot: ShotType | null` state (defaults `null`).
- Add `recentShots: ShotType[]` state (max 8, session-scoped, most-recent-first).
- `handleSetImpact`: when surface becomes `'racket'`, also set `shot_type = stickyShot` on the record.
- `handleSetShotType(t)`: update current frame's label, update `stickyShot`, update `recentShots`.
- `T` key: focus the ShotTypePicker search input via a forwarded ref.
- Clearing impact away from `racket` also clears `shot_type` on that frame (but not `stickyShot`).

### 5. `src/components/VideoCanvas.tsx` (update)
- Draw three-letter abbreviation below the impact diamond when `shot_type` is non-null.
- Colour matches `SHOT_TYPE_COLORS`.

### 6. `src/lib/exportCsv.ts` (update)
- Append `shot_type` column.
- Version `2` when any `shot_type` is non-null.

### 7. `src/lib/exportJson.ts` (update)
- Add `shot_type` field to each label object.
- Version `2` when any `shot_type` is non-null.

### 8. `src/lib/parseLabels.ts` (update)
- `LabelVersion` → `0 | 1 | 2`.
- `detectVersion`: `shot_type` column/key present → `2`.
- Coerce `shot_type` on load; default to `null` for v0/v1.

### 9. `src/lib/labelStore.ts` (update)
- Back-compat: default `shot_type: null` when loading older stored records.

### 10. `src/components/LoadStep.tsx` (update)
- Version toggle extended to `v0 / v1 / v2`.

### 11. `src/components/ExportStep.tsx` (update)
- Add `Shot types labelled: N / M racket impacts` count row.

---

## Open Questions

1. **Recents scope** — session-only, or persist to `localStorage` per video file? Per-file persistence means the labeller's previous session choices are pre-loaded, which is better for multi-session work on one video.

2. **Auto-advance on shot type set** — should confirming a shot type from the "All shots" panel auto-advance one frame, or let the labeller explicitly press the next-frame arrow? Auto-advance risks skipping a frame if the labeller is slow.

3. **Serve handling** — `serve` is always the first racket contact of a point. Should the tool auto-suggest it when the first racket impact in a `play_state = in_play` sequence is labelled?
