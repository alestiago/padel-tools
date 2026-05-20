import type { LabelRecord, VideoMeta } from '../types.ts'

interface ExportShape {
  version: number
  video_file: string
  fps: number
  frame_count: number
  frame_size: { width: number; height: number }
  labels: LabelRecord[]
}

export function exportJson(meta: VideoMeta, labels: Map<number, LabelRecord>): void {
  const sorted = [...labels.values()].sort((a, b) => a.frame - b.frame)

  const hasImpact = sorted.some((r) => r.impact !== null && r.impact !== undefined)
  const hasShotType = sorted.some((r) => r.shot_type !== null && r.shot_type !== undefined)
  const data: ExportShape = {
    version: hasShotType ? 2 : hasImpact ? 1 : 0,
    video_file: meta.file.name,
    fps: meta.fps,
    frame_count: meta.frameCount,
    frame_size: { width: meta.width, height: meta.height },
    labels: sorted,
  }

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = meta.file.name.replace(/\.[^.]+$/, '') + '_labels.json'
  a.click()
  URL.revokeObjectURL(url)
}
