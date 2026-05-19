import * as ort from 'onnxruntime-web/wasm'
import { preprocessFrame, stackFrames, decodeHeatmap, MODEL_H, MODEL_W } from '../lib/tracknetDetector.ts'

// WASM binary served from public/ (copied by postinstall).
ort.env.wasm.wasmPaths = '/'
// Use all available CPU cores only when the page is cross-origin isolated
// (COOP + COEP headers confirmed by the browser). Without isolation,
// SharedArrayBuffer is unavailable and the thread-pool bootstrap hangs.
ort.env.wasm.numThreads = crossOriginIsolated ? navigator.hardwareConcurrency : 1

let session: ort.InferenceSession | null = null

onmessage = async (e: MessageEvent) => {
  const { type } = e.data as { type: string }

  if (type === 'init') {
    try {
      session = await ort.InferenceSession.create('/tracknetv2.onnx', {
        executionProviders: ['wasm'],
      })
      postMessage({ type: 'ready' })
    } catch (err) {
      postMessage({ type: 'error', message: String(err) })
    }
    return
  }

  if (type === 'infer') {
    const { frames, w, h, threshold } = e.data as {
      frames: [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray]
      w: number
      h: number
      threshold: number
    }

    const [f0, f1, f2] = await Promise.all([
      preprocessFrame(frames[0], w, h),
      preprocessFrame(frames[1], w, h),
      preprocessFrame(frames[2], w, h),
    ])

    const inputData = stackFrames(f0, f1, f2)
    const tensor    = new ort.Tensor('float32', inputData, [1, 9, MODEL_H, MODEL_W])
    const results   = await session!.run({ input: tensor })

    // Model output: (1, 1, MODEL_H, MODEL_W) — last frame's heatmap only
    const heatmap = results['output'].data as Float32Array
    const ball    = decodeHeatmap(heatmap, w, h, threshold)

    postMessage({ type: 'result', ball })
  }
}
