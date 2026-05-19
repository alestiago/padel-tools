# Plan — TrackNetV2 ball detector for `ball-velocity-tool`

## Problem

The current `blobDetector.ts` uses a global yellow-green colour filter with no blob
isolation. It averages **all** matching pixels in the frame into one centroid, so any
yellow-green object (jersey, ad banner) poisons the result. This produced only 14
detections across ~2 900 analysed frames.

## Why TrackNetV2

TrackNetV2 takes **3 consecutive frames as a single 9-channel input** and outputs a
heatmap of ball probability. Because it reasons over motion it is robust to:
- Fast-moving balls with motion blur (undetectable by colour filters)
- Backgrounds that share the ball's colour
- Partial occlusion

Pre-trained weights exist for tennis/badminton (same ball size/speed profile as padel),
so no custom dataset is needed.

---

## Architecture overview

```
AnalyzeStep (main thread)
  │
  │  3-frame RGB buffers  (640×360, ImageData)
  ▼
TrackNetWorker (Web Worker)          ← new file
  │  onnxruntime-web session
  │  input:  Float32Array (1, 9, 288, 512)
  │  output: Float32Array (1, 1, 288, 512)  heatmap
  ▼
tracknetDetector.ts                  ← new file (replaces blobDetector.ts)
  │  peak detection + threshold + coord rescale
  ▼
BallDetection { u, v }               ← same type as today, no downstream changes
```

The Worker isolates inference from the React render thread. The rest of the pipeline
(`applyH`, `computeVelocities`, `ResultsStep`, CSV export) is **unchanged**.

---

## Prerequisites — ONNX model

TrackNetV2 ships as a PyTorch checkpoint. It must be exported to ONNX once, then
committed to the repo (or loaded from a URL).

```bash
# Run once, locally, requires Python + torch
pip install torch onnx
python tools/export_tracknet.py          # script to write (see Step 1)
# → public/tracknetv2.onnx  (~12 MB)
```

`export_tracknet.py` should:
1. Download the official checkpoint (badminton weights from the TrackNetV2 repo).
2. Load the model in eval mode.
3. Call `torch.onnx.export` with a dummy `(1, 9, 288, 512)` float32 input.
4. Set `opset_version=17`, `dynamic_axes` off (fixed resolution is fine).

The ONNX file goes in `ball-velocity-tool/public/` so Vite serves it as a static asset.

---

## Implementation steps

### Step 1 — `tools/export_tracknet.py`

Write the Python export script (see Prerequisites above). Verify the exported model
runs with `onnxruntime` locally before wiring up the browser side.

### Step 2 — Add `onnxruntime-web`

```bash
cd ball-velocity-tool
npm install onnxruntime-web
```

Configure Vite to serve the ONNX Runtime WASM binaries:

```ts
// vite.config.ts — add to the existing config
import { viteStaticCopy } from 'vite-plugin-static-copy'

plugins: [
  react(),
  viteStaticCopy({
    targets: [{
      src: 'node_modules/onnxruntime-web/dist/*.wasm',
      dest: '.',
    }],
  }),
]
```

Also install `vite-plugin-static-copy` as a dev dependency.

### Step 3 — `src/lib/tracknetDetector.ts`

Replaces `blobDetector.ts`. Pure functions, no ONNX dependency (inference stays in the
worker).

```ts
// Resize ImageData → Float32Array (1, 3, 288, 512), channel-first, [0,1]
export function preprocessFrame(imageData: ImageData): Float32Array

// Stack 3 preprocessed frames → (1, 9, 288, 512)
export function stackFrames(f0: Float32Array, f1: Float32Array, f2: Float32Array): Float32Array

// Find peak in heatmap output (1, 1, 288, 512), apply threshold
// Returns {u, v} in analysis-canvas pixel space, or null
export function decodeHeatmap(
  heatmap: Float32Array,
  heatmapW: number,     // 512
  heatmapH: number,     // 288
  canvasW: number,      // 640
  canvasH: number,      // 360
  threshold?: number,   // default 0.5
): { u: number; v: number } | null
```

`decodeHeatmap` finds `argmax` in the heatmap, checks it is above threshold, then
rescales the heatmap coordinate to canvas pixel space.

### Step 4 — `src/workers/tracknetWorker.ts`

```ts
// Web Worker — owns the ONNX session for its entire lifetime
import * as ort from 'onnxruntime-web'

let session: ort.InferenceSession | null = null

self.onmessage = async (e) => {
  if (e.data.type === 'init') {
    session = await ort.InferenceSession.create('/tracknetv2.onnx')
    self.postMessage({ type: 'ready' })
    return
  }
  if (e.data.type === 'infer') {
    const input = new ort.Tensor('float32', e.data.data, [1, 9, 288, 512])
    const { output } = await session!.run({ input })
    self.postMessage({ type: 'result', data: output.data }, [output.data.buffer])
    return
  }
}
```

Use `Transferable` buffers (`[output.data.buffer]`) to avoid copying the heatmap array
across the Worker boundary.

### Step 5 — Update `AnalyzeStep.tsx`

The current loop seeks one frame at a time and calls `detectBall(imageData)`.
Changes needed:

- **On mount**: spawn the Worker, wait for `ready` before enabling the Start button.
- **Frame buffer**: keep a ring buffer of the last 3 preprocessed frames
  (`Float32Array[]`). The first two analyzed frames cannot produce a detection (buffer
  not full yet); mark their `ball` as `null`.
- **Per frame**: preprocess → push to buffer → when buffer has 3 frames, send
  `infer` message to Worker, `await` the response, call `decodeHeatmap`.
- **On unmount**: `worker.terminate()`.

The `frameStep` setting remains useful — at `frameStep=1` TrackNetV2 sees every frame;
at `frameStep=2` it sees every other frame. Both are valid; the 3-frame buffer always
holds 3 analysed frames regardless of their original index in the video.

The `AnalysisConfig` type and the `videoFps` / `frameStep` settings are unchanged.

### Step 6 — Remove `blobDetector.ts`

Delete the file once `AnalyzeStep` no longer imports it.

---

## Threshold tuning

`decodeHeatmap` exposes a `threshold` parameter (default `0.5`). The UI in
`AnalyzeStep` config screen can expose this as a slider (0.3 – 0.8) so the user can
trade recall vs precision without redeploying.

---

## File changeset summary

| File | Action |
|------|--------|
| `tools/export_tracknet.py` | New — one-time ONNX export script |
| `ball-velocity-tool/public/tracknetv2.onnx` | New — committed model (~12 MB) |
| `ball-velocity-tool/package.json` | Add `onnxruntime-web`, `vite-plugin-static-copy` |
| `ball-velocity-tool/vite.config.ts` | Add static copy plugin for WASM binaries |
| `ball-velocity-tool/src/lib/tracknetDetector.ts` | New — pre/post-processing |
| `ball-velocity-tool/src/workers/tracknetWorker.ts` | New — ONNX inference worker |
| `ball-velocity-tool/src/components/AnalyzeStep.tsx` | Update — worker + 3-frame buffer |
| `ball-velocity-tool/src/lib/blobDetector.ts` | Delete |

Everything downstream (`applyH.ts`, `velocityCalc.ts`, `ResultsStep.tsx`, CSV export,
`types.ts`) is untouched.

---

## Open questions

1. **Which checkpoint?** The original TrackNetV2 repo (neco8/TrackNetV2 on GitHub) has
   badminton weights. A tennis-trained variant may perform better on padel. Worth
   testing both before committing.

2. **ONNX Runtime WASM vs WebGPU backend?** `onnxruntime-web` supports a WebGPU
   execution provider (faster on modern browsers). Start with WASM for broadest
   compatibility; adding WebGPU is one line once the WASM path is confirmed.

3. **Model size in repo?** 12 MB in `public/` is fine for a local dev tool. If it ever
   becomes a hosted app, move it to a CDN and pass the URL to
   `InferenceSession.create()`.
