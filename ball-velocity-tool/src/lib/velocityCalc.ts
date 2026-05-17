import type { FrameResult } from '../types.ts'

const MAX_REALISTIC_KMH = 250

/**
 * Fills in rawVelocityKmh and velocityKmh for every frame result.
 *
 * Raw velocity = Euclidean distance between consecutive real-world ball
 * positions divided by dt (seconds between analysed frames), converted to km/h.
 *
 * Smoothed velocity = mean of a sliding window centred on each frame,
 * ignoring null and unrealistic values.
 */
export function computeVelocities(
  results: FrameResult[],
  frameStep: number,
  videoFps: number,
  windowSize = 5,
): FrameResult[] {
  const dt = frameStep / videoFps

  // Pass 1 — raw velocities
  const withRaw: FrameResult[] = results.map((r, i) => {
    if (i === 0 || !r.ball || !results[i - 1].ball) {
      return { ...r, rawVelocityKmh: null }
    }
    const prev = results[i - 1].ball!
    const dx = r.ball.x - prev.x
    const dy = r.ball.y - prev.y
    const kmh = (Math.sqrt(dx * dx + dy * dy) / dt) * 3.6
    return { ...r, rawVelocityKmh: kmh > MAX_REALISTIC_KMH ? null : kmh }
  })

  // Pass 2 — sliding-window average
  const half = Math.floor(windowSize / 2)
  return withRaw.map((r, i) => {
    const slice = withRaw
      .slice(Math.max(0, i - half), Math.min(withRaw.length, i + half + 1))
      .map(f => f.rawVelocityKmh)
      .filter((v): v is number => v !== null)

    const avg = slice.length > 0
      ? slice.reduce((a, b) => a + b, 0) / slice.length
      : null

    return { ...r, velocityKmh: avg }
  })
}

/** Binary search: find the frame result closest to a given playback time. */
export function findNearestResult(
  results: FrameResult[],
  timeS: number,
): FrameResult | null {
  if (results.length === 0) return null

  let lo = 0
  let hi = results.length - 1

  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (results[mid].timeS < timeS) lo = mid + 1
    else hi = mid
  }

  if (lo > 0) {
    const a = results[lo - 1]
    const b = results[lo]
    return Math.abs(a.timeS - timeS) < Math.abs(b.timeS - timeS) ? a : b
  }

  return results[lo]
}
