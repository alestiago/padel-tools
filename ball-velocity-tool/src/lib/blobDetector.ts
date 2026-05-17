export interface BlobResult {
  /** Centroid in the analysis canvas pixel space */
  u: number
  v: number
  /** Number of matching pixels (proxy for confidence) */
  size: number
}

/**
 * Detects the padel/tennis ball (yellow-green) in an ImageData.
 *
 * Uses normalised RGB: the ball has high green, significant red, low blue —
 * and is bright enough to distinguish from dark green court surfaces.
 *
 * Returns the centroid of all matching pixels, or null when no plausible
 * ball-sized blob is found.
 */
export function detectBall(
  imageData: ImageData,
  minSize = 4,
  maxSize = 600,
): BlobResult | null {
  const { data, width, height } = imageData

  let sumU = 0
  let sumV = 0
  let count = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      const r = data[idx]
      const g = data[idx + 1]
      const b = data[idx + 2]
      if (isYellowGreen(r, g, b)) {
        sumU += x
        sumV += y
        count++
      }
    }
  }

  if (count < minSize || count > maxSize) return null

  return { u: sumU / count, v: sumV / count, size: count }
}

function isYellowGreen(r: number, g: number, b: number): boolean {
  const sum = r + g + b
  if (sum < 300) return false          // too dark
  const rn = r / sum
  const gn = g / sum
  const bn = b / sum
  return (
    gn > 0.30 &&    // green-dominant
    rn > 0.22 &&    // significant red (yellow bias)
    bn < 0.26 &&    // low blue
    gn > bn &&
    rn > bn
  )
}
