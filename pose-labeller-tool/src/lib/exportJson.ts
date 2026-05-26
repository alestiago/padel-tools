import type { KeypointsMap } from '../types.ts'
import { computeAngles } from './angles.ts'

export interface PoseFrame {
  frame: number
  timestampMs: number
  keypoints: KeypointsMap
  angles: Record<string, number | null>
}

export interface PoseExport extends PoseFrame {
  version: 1
  videoFile: string
}

export interface MultiPoseExport {
  version: 2
  videoFile: string
  fps: number
  poses: PoseFrame[]
}

export function buildExport(
  videoFile: string,
  frame: number,
  fps: number,
  keypoints: KeypointsMap,
): PoseExport {
  return {
    version: 1,
    videoFile,
    frame,
    timestampMs: Math.round((frame / fps) * 1000),
    keypoints,
    angles: computeAngles(keypoints),
  }
}

export function buildMultiExport(
  videoFile: string,
  fps: number,
  frameLabels: Map<number, KeypointsMap>,
): MultiPoseExport {
  const poses = Array.from(frameLabels.entries())
    .filter(([, kps]) => Object.keys(kps).length > 0)
    .sort(([a], [b]) => a - b)
    .map(([frame, keypoints]) => ({
      frame,
      timestampMs: Math.round((frame / fps) * 1000),
      keypoints,
      angles: computeAngles(keypoints),
    }))
  return { version: 2, videoFile, fps, poses }
}

function triggerDownload(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadJson(data: PoseExport): void {
  const stem = data.videoFile.replace(/\.[^.]+$/, '')
  triggerDownload(`${stem}_pose_${data.frame}.json`, JSON.stringify(data, null, 2))
}

export function downloadAllJson(data: MultiPoseExport): void {
  const stem = data.videoFile.replace(/\.[^.]+$/, '')
  triggerDownload(`${stem}_poses.json`, JSON.stringify(data, null, 2))
}
