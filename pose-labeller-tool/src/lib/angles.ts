import type { KeypointsMap } from '../types.ts'
import { ANGLE_DEFS } from './skeleton.ts'

function interiorAngleDeg(
  px: number, py: number,
  vx: number, vy: number,
  dx: number, dy: number,
): number {
  const ax = px - vx, ay = py - vy
  const bx = dx - vx, by = dy - vy
  const lenA = Math.sqrt(ax * ax + ay * ay)
  const lenB = Math.sqrt(bx * bx + by * by)
  if (lenA === 0 || lenB === 0) return 0
  const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (lenA * lenB)))
  return Math.acos(cos) * (180 / Math.PI)
}

export function computeAngles(keypoints: KeypointsMap): Record<string, number | null> {
  const result: Record<string, number | null> = {}

  for (const def of ANGLE_DEFS) {
    const p = keypoints[def.proximal]
    const v = keypoints[def.vertex]
    const d = keypoints[def.distal]
    const missing =
      !p || !v || !d ||
      p.visibility === 'not_in_frame' ||
      v.visibility === 'not_in_frame' ||
      d.visibility === 'not_in_frame'
    result[def.id] = missing ? null : interiorAngleDeg(p.x, p.y, v.x, v.y, d.x, d.y)
  }

  // trunk_lean: neck → mid_hip → mid_knee (virtual midpoints, handled specially)
  const neck = keypoints['neck']
  const lh = keypoints['left_hip']
  const rh = keypoints['right_hip']
  const lk = keypoints['left_knee']
  const rk = keypoints['right_knee']
  const trunkReady =
    neck && lh && rh && lk && rk &&
    neck.visibility !== 'not_in_frame' &&
    lh.visibility !== 'not_in_frame' &&
    rh.visibility !== 'not_in_frame' &&
    lk.visibility !== 'not_in_frame' &&
    rk.visibility !== 'not_in_frame'

  if (trunkReady && neck && lh && rh && lk && rk) {
    const midHipX = (lh.x + rh.x) / 2, midHipY = (lh.y + rh.y) / 2
    const midKneeX = (lk.x + rk.x) / 2, midKneeY = (lk.y + rk.y) / 2
    result['trunk_lean'] = interiorAngleDeg(neck.x, neck.y, midHipX, midHipY, midKneeX, midKneeY)
  } else {
    result['trunk_lean'] = null
  }

  return result
}

export function angleColor(deg: number, safeMin: number, safeMax: number): string {
  if (deg >= safeMin && deg <= safeMax) return '#22c55e'
  const margin = (safeMax - safeMin) * 0.15
  if (deg >= safeMin - margin && deg <= safeMax + margin) return '#f59e0b'
  return '#ef4444'
}
