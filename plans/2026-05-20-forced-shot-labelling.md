# Forced / Unforced Shot Labelling — Design Plan

**Goal:** Allow the labeller to mark whether a racket impact was *forced* — the player was barely reaching the ball or in a clearly compromised position — or *unforced* — the player had time, position, and a free swing. This annotation enriches shot-quality analysis and can serve as a training signal for pressure/difficulty models.

---

## Scope

`forced` is a property of a **shot** (racket impact), not a ball-position annotation. It belongs alongside `shot_type` and `hand` in the Stroke section of the sidebar, and follows the same "targets last racket frame" pattern: the labeller can set it from any frame, and it writes to the highest frame ≤ current where `impact = 'racket'`.

---

## Data Model Alternatives

### A — Boolean (`forced: boolean | null`)

Three states: `true` (forced), `false` (unforced), `null` (unset).

**Pros:** Minimal type surface; serialises to `true`/`false`/empty.  
**Cons:** Lossy — `false` conflates "I actively decided: unforced" with "I haven't decided yet." Null already carries that meaning, so `false` should mean unforced explicitly. Works if we treat null as unset and false as a deliberate choice.

### B — Union type (`'forced' | 'unforced' | null`)

Three explicit string states, consistent with `hand: 'forehand' | 'backhand' | null` and `shot_type: ShotType | null`.

**Pros:** Self-documenting in exports; no ambiguity between "not set" and "decided: unforced"; matches the existing pattern throughout the codebase.  
**Cons:** Slightly more verbose than a boolean, which is trivial.

### Verdict — Option B

The union type matches every other nullable discriminated field in the schema. Exported CSV and JSON will contain `forced` / `unforced` / `` (empty), which is unambiguous for downstream analysis.

---

## UI Placement Alternatives

### Option 1 — Inside ImpactSelector (only when `impact = racket` is selected)

Show two small buttons below the racket surface button, contextually visible only on racket frames.

**Pros:** Strongly contextual — physically co-located with the surface that gives it meaning.  
**Cons:** Cannot set it retroactively from another frame (the shot_type/hand pattern — where you can set stroke info from any frame and it writes to the last racket frame — would be broken). Labellers often advance past a racket frame and want to annotate it after the fact.

### Option 2 — In the Stroke section (below hand picker, always visible)

Two compact buttons `Forced` / `Unforced` added to the always-visible Stroke section in the sidebar, alongside hand and shot type. Targeting is identical to hand: always writes to the last racket contact frame ≤ current frame.

**Pros:** Retroactive targeting works naturally; consistent placement and pattern with existing stroke attributes; labeller never needs to seek back to annotate.  
**Cons:** The Stroke section grows slightly taller.

### Option 3 — Separate sidebar section

A dedicated "Pressure" section beneath Stroke.

**Pros:** Clean semantic separation.  
**Cons:** Visually noisy; adds another section header; the concept is still a shot property and belongs with the other shot properties.

### Verdict — Option 2

Placing `forcing` in the Stroke section with the same retroactive-targeting semantics keeps the interaction model consistent and allows fast annotation without frame navigation.

---

## UI Design

Within the existing Stroke section (below the `Forehand` / `Backhand` row):

```
Forcing
[ Forced ]  [ Unforced ]
```

- Two equal-width buttons, toggle-style: clicking the active value clears it (→ null), clicking the inactive value sets it.
- Colour coding: **Forced** = amber (`bg-amber-700`), **Unforced** = slate-green (`bg-emerald-700`), unset = both dim slate.
- A small frame indicator `→ N` appears in the section header when the target frame differs from the current frame (same pattern as the existing shot_type/hand indicator).
- No shortcut assigned initially — hand and shot_type already cover the keyboard; this annotation is made less frequently and two clicks suffice.

---

## Schema

`LabelRecord` gains one new field:

```typescript
forcing: 'forced' | 'unforced' | null
```

`LabelVersion` bumps to `3` when any label has a non-null `forcing`. Existing v2 files load with `forcing: null` on every record (back-compat via `labelStore.ts` and `parseLabels.ts`).

---

## CSV / JSON format

CSV column added after `hand`:

```
frame,time_s,play_state,visibility,x,y,impact,shot_type,hand,forcing
```

`forcing` is exported as `forced` / `unforced` / `` (empty string when null).

JSON: `"forcing": "forced"` / `"forcing": "unforced"` / `"forcing": null`.

---

## Implementation Steps

### 1. `src/types.ts`
- Add `type ShotForcing = 'forced' | 'unforced'`.
- Add `SHOT_FORCINGS: ShotForcing[] = ['forced', 'unforced']`.
- Add `forcing: ShotForcing | null` to `LabelRecord`.

### 2. `src/components/LabelStep.tsx`
- Add `stickyForcing: ShotForcing | null` state (default `null`).
- Add `handleSetForcing(f)`: calls `findLastRacketFrame`, writes `forcing` to that frame, updates `stickyForcing`.
- When `impact → 'racket'` auto-applies sticky values, also apply `stickyForcing`.
- In the Stroke section render, add a "Forcing" row below the Forehand / Backhand row:
  - Show `→ N` frame indicator when `lastRacketFrame !== currentFrame`.
  - Render `Forced` and `Unforced` buttons, active state uses `lastRacketLabel?.forcing`.
- Compute `stickyForcing` from `lastRacketLabel?.forcing` on every render (same pattern as `stickyHand`).

### 3. `src/lib/exportCsv.ts`
- Append `forcing` column to the header.
- Emit `r.forcing ?? ''` per row.
- Version `3` when any `forcing` is non-null.

### 4. `src/lib/exportJson.ts`
- Add `forcing` field to each label object.
- Version `3` when any `forcing` is non-null.

### 5. `src/lib/parseLabels.ts`
- `LabelVersion` → `0 | 1 | 2 | 3`.
- Add `toForcing(val)` coercion function.
- `detectVersion`: `forcing` column/key present → `3`.
- Parse `forcing` on load; default `null` for v0/v1/v2.

### 6. `src/lib/labelStore.ts`
- Back-compat: `forcing: r.forcing ?? null` when loading stored records.

### 7. `src/components/LoadStep.tsx`
- Version toggle extended to include `v3`.

### 8. `src/components/ExportStep.tsx`
- Add "Forcing labelled: N / M racket impacts" count row in amber/emerald when racket impacts exist.

---

## Open Questions

1. **Stickiness scope** — Should `stickyForcing` persist between points, or reset when `play_state` transitions from dead → in_play? Forcing tendency might correlate with players and court position, so persisting across points could reduce clicks. Resetting per point would prevent accidentally carrying over a wrong annotation. Safer default: persist (same as `stickyShot` and `stickyHand`).

2. **Keyboard shortcut** — `F` is taken (out_of_frame). No obvious free letter. If a shortcut becomes desirable, candidates are: `R` (fRced), `U` (Unforced). Leave unassigned until usage patterns emerge.

3. **Definition boundary** — "Barely reaching" and "compromised position" need a shared definition among multiple labellers to achieve inter-rater consistency. Consider adding a tooltip or brief legend to the UI (or a note in the exported data's README).
