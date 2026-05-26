import type { KeypointId, KeypointVisibility, KeypointsMap } from '../types.ts'
import { KEYPOINT_IDS } from '../types.ts'

export type PoseFileVersion = 1 | 2

export interface ParsePosesResult {
  frameLabels: Map<number, KeypointsMap>
  fps?: number
  version: PoseFileVersion
}

function toVisibility(val: unknown): KeypointVisibility {
  if (val === 'occluded') return 'occluded'
  if (val === 'not_in_frame') return 'not_in_frame'
  return 'visible'
}

function isKeypointId(val: unknown): val is KeypointId {
  return typeof val === 'string' && (KEYPOINT_IDS as readonly string[]).includes(val)
}

function parseKeypointsMap(raw: Record<string, unknown>): KeypointsMap {
  const kps: KeypointsMap = {}
  for (const key of Object.keys(raw)) {
    if (!isKeypointId(key)) continue
    const kp = raw[key] as Record<string, unknown>
    kps[key] = {
      x: Number(kp.x),
      y: Number(kp.y),
      visibility: toVisibility(kp.visibility),
    }
  }
  return kps
}

export function parsePosesJson(text: string): ParsePosesResult | null {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }

  const version = typeof data.version === 'number' ? data.version : 1
  const fps = typeof data.fps === 'number' ? data.fps : undefined

  // version 2: MultiPoseExport — poses array with per-frame keypoints
  if (version === 2 && Array.isArray(data.poses)) {
    const frameLabels = new Map<number, KeypointsMap>()
    for (const pose of data.poses as Record<string, unknown>[]) {
      const frame = Number(pose.frame)
      if (isNaN(frame)) continue
      const raw = pose.keypoints as Record<string, unknown> | undefined
      if (!raw) continue
      frameLabels.set(frame, parseKeypointsMap(raw))
    }
    return { frameLabels, fps, version: 2 }
  }

  // version 1: PoseExport — single frame
  if (version === 1) {
    const frame = typeof data.frame === 'number' ? data.frame : 0
    const raw = data.keypoints as Record<string, unknown> | undefined
    const frameLabels = new Map<number, KeypointsMap>([
      [frame, raw ? parseKeypointsMap(raw) : {}],
    ])
    return { frameLabels, fps, version: 1 }
  }

  return null
}

export function detectPoseVersion(text: string): PoseFileVersion {
  try {
    const data = JSON.parse(text) as Record<string, unknown>
    return (data.version as PoseFileVersion) ?? 1
  } catch {
    return 1
  }
}
