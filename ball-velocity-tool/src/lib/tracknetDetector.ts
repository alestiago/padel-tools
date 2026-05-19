/** Input resolution expected by the TrackNetV2 ONNX model. */
export const MODEL_W = 512
export const MODEL_H = 288

/**
 * Resize one analysis-canvas frame (RGBA Uint8ClampedArray, srcW×srcH) to
 * MODEL_W×MODEL_H and return a channel-first Float32 RGB plane: (3, H, W).
 */
export async function preprocessFrame(
  data: Uint8ClampedArray,
  srcW: number,
  srcH: number,
): Promise<Float32Array> {
  const src = new OffscreenCanvas(srcW, srcH)
  // Cast: data may have ArrayBufferLike backing, but in practice is always a plain ArrayBuffer.
  src.getContext('2d')!.putImageData(new ImageData(data as unknown as Uint8ClampedArray<ArrayBuffer>, srcW, srcH), 0, 0)

  const dst = new OffscreenCanvas(MODEL_W, MODEL_H)
  dst.getContext('2d')!.drawImage(src, 0, 0, MODEL_W, MODEL_H)
  const px = dst.getContext('2d')!.getImageData(0, 0, MODEL_W, MODEL_H).data

  const n = MODEL_H * MODEL_W
  const f = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    f[i]         = px[i * 4]     / 255  // R
    f[n + i]     = px[i * 4 + 1] / 255  // G
    f[2 * n + i] = px[i * 4 + 2] / 255  // B
  }
  return f
}

/**
 * Stack three channel-first RGB planes (each shape 3×H×W) into the
 * 9-channel input tensor expected by TrackNetV2: shape (1, 9, H, W).
 * f0 = oldest frame, f2 = most recent frame.
 */
export function stackFrames(
  f0: Float32Array,
  f1: Float32Array,
  f2: Float32Array,
): Float32Array {
  const plane = 3 * MODEL_H * MODEL_W
  const input = new Float32Array(9 * MODEL_H * MODEL_W)
  input.set(f0, 0)
  input.set(f1, plane)
  input.set(f2, 2 * plane)
  return input
}

/**
 * Find the ball position from the single-channel heatmap output of the model.
 *
 * heatmap — Float32Array of length MODEL_H × MODEL_W, values in [0, 1].
 * Returns pixel coordinates in analysis-canvas space (srcW × srcH), or null
 * if the peak confidence is below `threshold`.
 */
export function decodeHeatmap(
  heatmap: Float32Array,
  srcW: number,
  srcH: number,
  threshold = 0.5,
): { u: number; v: number } | null {
  let maxVal = 0
  let maxIdx = 0
  for (let i = 0; i < heatmap.length; i++) {
    if (heatmap[i] > maxVal) {
      maxVal = heatmap[i]
      maxIdx = i
    }
  }
  if (maxVal < threshold) return null

  const modelX = maxIdx % MODEL_W
  const modelY = Math.floor(maxIdx / MODEL_W)

  return {
    u: (modelX / MODEL_W) * srcW,
    v: (modelY / MODEL_H) * srcH,
  }
}
