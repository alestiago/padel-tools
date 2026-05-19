# Plan: tools/cenital-view-overlay.py

**Date:** 2026-05-18  
**Goal:** Render a real-time miniature top-down (cenital) court view in the top-right corner of each video frame, showing player positions mapped from the players CSV.

---

## Inputs

| Argument | Description |
|---|---|
| `--video` | Input video (e.g. `overlay_players_v2.mp4`) |
| `--csv` | Players CSV (`frame_index, player_id, court_x_m, court_y_m, side, status, …`) |
| `--homography` | JSON with `frame_size` (used only for resolution consistency) |
| `--output` | Output video path |
| `--map-height` | Pixel height of the mini-map (default: 240) |
| `--alpha` | Overlay opacity 0–1 (default: 0.85) |
| `--margin` | Pixel gap from video edge (default: 12) |
| `--trail` | Number of past frames to show as fading trail (default: 0, off) |

---

## Court geometry in top-down view

The padel court is **10 m wide × 20 m tall** in world coordinates (x: 0–10, y: 0–20).  
In the mini-map the court is rendered in **portrait orientation** (narrow and tall), matching the real aspect ratio 1:2.

```
map_h = --map-height   (e.g. 240 px)
map_w = map_h // 2     (e.g. 120 px)
```

World → map pixel transform (simple linear, no homography needed):
```python
px = int(cx_m / 10.0 * (map_w - 2*PAD)) + PAD
py = int(cy_m / 20.0 * (map_h - 2*PAD)) + PAD
```

`PAD` (~8 px) leaves a small border so dots at the court edge are not clipped.

---

## Approaches

### A – Static court + coloured dots (recommended)

Pre-draw the court outline once on a black canvas:
- **Outer boundary** (white thin line): full 10×20 perimeter
- **Net** (amber): y = 10 m
- **Service lines** (white dim): y = 3.05 m and y = 16.95 m
- **Centre service line** (white dim): x = 5 m between service lines
- **Glass corner panels** (cyan): side walls y = 0–4 m and y = 16–20 m
- **Fence** (gray dashed): side walls y = 4–16 m

Each frame:
1. Copy static canvas
2. Draw one filled circle per player (6–8 px radius), coloured by player ID (same palette as `overlay_players.py`)
3. For occluded/extrapolated rows, draw a hollow circle (outline only)
4. Composite the mini-map rectangle onto the top-right corner with `alpha` blending

**Pros:** Simple, fast, readable.  
**Cons:** No temporal context between frames.

---

### B – Fading position trail

Same as A, but keep a deque of the last `--trail` frames of world positions per player.  
Draw older positions as smaller, dimmer dots (opacity fades linearly to 0 at the oldest point).

```python
for age, (px, py) in enumerate(reversed(trail)):
    alpha_t = 1.0 - age / trail_len
    radius = max(2, int(6 * alpha_t))
    # draw semi-transparent dot
```

**Pros:** Shows movement direction and speed at a glance.  
**Cons:** Slightly more complex; trails can clutter the mini-map.

---

### C – Semi-transparent background panel

Draw a rounded, semi-transparent dark panel behind the mini-map for readability against bright video content.

Implementation: draw a filled dark rectangle at low opacity (0.5) before compositing the court lines.

This is a visual refinement that can be layered on top of A or B.

---

## Conclusion and recommended implementation

**Implement A + C as the baseline**, with `--trail` as an opt-in feature (B).

- Court lines pre-drawn once (no per-frame recompute).
- Semi-transparent panel behind the map (C) so it reads clearly regardless of video content.
- Player dots coloured by ID with hollow style for non-detected states.
- Trail disabled by default; `--trail N` enables it.

The tool requires no homography math at draw time — world coordinates come directly from the CSV. The homography JSON is loaded only to read `frame_size` for any future resolution-scaling guard.

---

## Implementation sketch

```python
# Pre-compute
static_court = draw_court_minimap(map_w, map_h, PAD)  # static canvas
by_frame = load_csv(args.csv)  # {frame_index: [row, ...]}
trail_deque = {pid: collections.deque(maxlen=args.trail) for pid in (1,2,3,4)}

# Per frame
mini = static_court.copy()
for row in by_frame.get(fi, []):
    pid = int(row["player_id"])
    px = world_to_map_x(float(row["court_x_m"]))
    py = world_to_map_y(float(row["court_y_m"]))
    color = _COLORS[pid]
    filled = row["status"] == "detected"
    if args.trail:
        draw_trail(mini, trail_deque[pid], color)
        trail_deque[pid].appendleft((px, py))
    cv2.circle(mini, (px, py), 7, color, -1 if filled else 2, cv2.LINE_AA)

# Composite onto top-right corner
x_off = frame_w - map_w - margin
y_off = margin
composite_minimap(frame, mini, x_off, y_off, args.alpha)
```

---

## Output

Each frame gets a `map_w × map_h` court diagram (e.g. 120×240 px) in the top-right corner. Player dots update every frame in sync with the CSV data.
