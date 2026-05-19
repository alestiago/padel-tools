# Plan — WebGL GPU inference backend

## Problem

WASM inference runs TrackNetV2 single-threaded on the CPU. On a modern laptop (M1/M2)
that is roughly **150–350 ms per frame**; on older or non-Apple hardware it can reach
500 ms. For a 3-minute padel video at `frameStep = 2` (≈ 2 700 analysed frames) this
means **7–25 minutes** of wall time even with seek/infer pipelining.

onnxruntime-web ships a WebGL execution provider that maps every ONNX op to a WebGL2
draw call, offloading compute to the GPU. All ops used by TrackNetV2 (Conv2d, BN, ReLU,
MaxPool, NearestUpsample, Sigmoid, Concat) are supported by the WebGL backend.

---

## Performance estimate

| Backend | Inference / frame | 2 700 frames (no overlap) | With seek overlap |
|---------|-------------------|--------------------------|-------------------|
| WASM (current) | 150–350 ms | 7–16 min | 5–12 min |
| WebGL (target) | 20–60 ms | 1–3 min | ~1 min* |

\* At 20–60 ms inference, seek latency (typically 50–150 ms on H.264) becomes the new
bottleneck. The seek/infer pipeline implemented previously will fully absorb inference
cost, leaving seek as the ceiling. Practical expectation: **3–5 min for a 3-minute
video** (down from 10–20 min with pure WASM).

**Warm-up cost**: The first `session.run()` compiles a WebGL shader program per unique
op configuration. For a U-Net with ~18 conv layers this takes **2–10 seconds** on first
load. Chrome caches compiled shader programs on disk so subsequent page loads are fast
(< 500 ms). Safari and Firefox do not guarantee persistent shader caches.

---

## Architecture changes

### Import

`onnxruntime-web/webgl` (`ort.webgl.min.mjs`, 454 KB) is a self-contained WebGL-only
build with **no dynamic imports and no WASM files required**. It resolves in Vite
workers without any plugin changes.

For robustness, use `onnxruntime-web/all` (`ort.all.bundle.min.mjs`, 840 KB) which
includes both the WebGL and WASM backends and lets the runtime fall back automatically.
The all-bundle inlines the WASM glue (no `.mjs` file needed at runtime) and only needs
the `.wasm` binary, which is already served from `public/`.

```
Before: import * as ort from 'onnxruntime-web/wasm'
After:  import * as ort from 'onnxruntime-web/all'
```

### Execution providers

```ts
// try WebGL first; WASM catches any unsupported op or device
executionProviders: ['webgl', 'wasm']
```

### Warm-up message

After `InferenceSession.create()` succeeds, run one silent dummy inference on a
zero-filled tensor before posting `{ type: 'ready' }`. This forces shader compilation
inside the worker so the first real frame runs at full speed.

New worker message sequence:

```
worker ← { type: 'init' }
worker → { type: 'warming' }          ← new
         [2–10 s shader compilation]
worker → { type: 'ready' }            ← unchanged, now means "GPU hot"
```

---

## Implementation steps

### Step 1 — Update `tracknetWorker.ts`

1. Change import to `onnxruntime-web/all`.
2. Set `executionProviders: ['webgl', 'wasm']`.
3. Remove the `ort.env.wasm.numThreads = 1` line (irrelevant once WebGL is the primary
   backend; keep for WASM fallback correctness — move it after the provider decision if
   needed).
4. After session creation, post `{ type: 'warming' }`, then run a dummy inference:

```ts
postMessage({ type: 'warming' })
const dummy = new ort.Tensor('float32', new Float32Array(9 * 288 * 512), [1, 9, 288, 512])
await session.run({ input: dummy })
postMessage({ type: 'ready' })
```

### Step 2 — Update `AnalyzeStep.tsx`

Replace the binary `modelReady: boolean` with a richer status union so the UI can
distinguish loading vs compiling vs ready:

```ts
type ModelStatus = 'loading' | 'warming' | 'ready' | 'error'
```

Handle the new `warming` message in the worker `onmessage` handler:

```ts
if (e.data.type === 'warming') setModelStatus('warming')
if (e.data.type === 'ready')   setModelStatus('ready')
if (e.data.type === 'error')   setModelStatus('error') // keep existing
```

The Start button label and disabled state driven by `modelStatus`:

| Status | Button label | Disabled |
|--------|-------------|----------|
| `loading` | Loading model… | yes |
| `warming` | Compiling GPU shaders… | yes |
| `ready` | Start analysis | no |
| `error` | Start analysis | yes (error shown separately) |

The existing `modelError` state stays for the error message text.

### Step 3 — Vite config

`ort.all.bundle.min.mjs` has one `/*@vite-ignore*/` dynamic import (for the WASM
binary path). This does not reference `ort-wasm-simd-threaded.mjs`, so the existing
middleware that serves that file is no longer needed by the new import — but it does no
harm and can stay.

No Vite config changes are strictly required. Optionally remove the middleware if
`onnxruntime-web/wasm` is no longer imported anywhere.

### Step 4 — Verify WASM binary is still present

`ort.all.bundle.min.mjs` still needs `ort-wasm-simd-threaded.wasm` in `public/` (for
the WASM fallback path). It is already there via `postinstall`. No change needed.

---

## Fallback behaviour

If the device does not support WebGL2 (very rare on modern browsers), the runtime
automatically falls back to WASM because `executionProviders: ['webgl', 'wasm']` lists
both. The warm-up step still runs (WASM is slower to warm up, ~500 ms), and the UI
remains correct.

---

## File changeset

| File | Change |
|------|--------|
| `src/workers/tracknetWorker.ts` | Change import; add `executionProviders`; add warm-up dummy inference; post `warming` message |
| `src/components/AnalyzeStep.tsx` | Replace `modelReady: boolean` with `modelStatus: ModelStatus`; handle `warming` message; update button label |
| `vite.config.ts` | No required change (middleware can be removed as clean-up if desired) |

---

## Implementation result — NOT VIABLE in a Web Worker

Attempted during 2026-05-17 session. Two blocking issues found:

**Issue 1 — WebGL proxy worker**: onnxruntime-web's WebGL backend creates a nested
proxy worker internally to marshal GPU calls. This fails when the caller is already
inside a Web Worker (nested workers fail silently, then inference throws "invalid input
shape" from a broken internal state).

**Issue 2 — `ort.all` JSEP imports**: The `ort.all.bundle.min.mjs` includes the
JSEP-enabled WASM backend (for WebGPU). It dynamically imports
`ort-wasm-simd-threaded.jsep.mjs` at runtime; this file is not served, causing
"Failed to fetch dynamically imported module" and a total backend failure.

**Resolution**: Reverted `tracknetWorker.ts` to `onnxruntime-web/wasm` with
`executionProviders: ['wasm']`. The `ModelStatus` union and warm-up UI scaffolding
were kept in `AnalyzeStep.tsx` for future use.

**Path forward — move inference to the main thread**:
GPU execution providers (WebGL, WebGPU) work correctly when `InferenceSession` is
created on the main thread. The refactor required:
1. Move session creation and `session.run()` to the main thread.
2. Post pixel data to a preprocessing Web Worker (OffscreenCanvas resize), receive
   back the `Float32Array` tensor, run inference on the main thread, post the result.
3. The `warming` / `ready` states and amber UI indicator are already wired for this.

---

## Open questions

1. **WebGL vs WebGPU** — onnxruntime-web also ships a WebGPU backend
   (`onnxruntime-web/webgpu`). WebGPU provides lower driver overhead and typically
   another 2–4× vs WebGL on the same hardware. Browser support is now good
   (Chrome 113+, Edge 113+, Safari 18+). If moving inference to the main thread,
   prefer WebGPU over WebGL.
