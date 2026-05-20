import type { LabelRecord, VideoMeta } from '../types.ts'

export function exportCsv(meta: VideoMeta, labels: Map<number, LabelRecord>): void {
  const sorted = [...labels.values()].sort((a, b) => a.frame - b.frame)

  const hasImpact = sorted.some((r) => r.impact !== null && r.impact !== undefined)
  const hasShotType = sorted.some((r) => r.shot_type !== null && r.shot_type !== undefined)
  const hasForcing = sorted.some((r) => r.forcing !== null && r.forcing !== undefined)
  const version = hasForcing ? 3 : hasShotType ? 2 : hasImpact ? 1 : 0

  const header = `# version: ${version}\nframe,time_s,play_state,visibility,x,y,impact,shot_type,hand,forcing\n`
  const rows = sorted.map((r) => {
    const time_s = (r.frame / meta.fps).toFixed(4)
    return `${r.frame},${time_s},${r.play_state},${r.visibility},${r.x ?? ''},${r.y ?? ''},${r.impact ?? ''},${r.shot_type ?? ''},${r.hand ?? ''},${r.forcing ?? ''}`
  })

  const csv = header + rows.join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = meta.file.name.replace(/\.[^.]+$/, '') + '_labels.csv'
  a.click()
  URL.revokeObjectURL(url)
}
