import type { LabelRecord, ReviewTarget } from '../types.ts'

const PRE_ROLL = 10

export function buildReviewQueue(
  labels: Map<number, LabelRecord>,
  frameCount: number,
): ReviewTarget[] {
  const sorted = [...labels.values()].sort((a, b) => a.frame - b.frame)
  const racketFrames = sorted.filter((r) => r.impact === 'racket').map((r) => r.frame)
  const unlabelled = sorted.filter((r) => r.impact === 'racket' && r.shot_type === null)

  return unlabelled.map((target) => {
    const f = target.frame

    // Clip start: previous racket contact minus pre-roll buffer
    const prevRacket = racketFrames.filter((rf) => rf < f).pop()
    const clipStart = Math.max(0, (prevRacket ?? 0) - PRE_ROLL)

    // Clip end: next labelled impact frame, or first dead frame, or last frame
    let clipEnd = frameCount - 1
    for (const r of sorted) {
      if (r.frame <= f) continue
      if (r.impact !== null || r.play_state === 'dead') {
        clipEnd = r.frame
        break
      }
    }

    return { frame: f, clipStart, clipEnd }
  })
}
