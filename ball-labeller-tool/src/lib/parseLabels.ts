import type { Hand, ImpactSurface, LabelRecord, PlayState, ShotType, Visibility } from '../types.ts'
import { HANDS, SHOT_TYPES } from '../types.ts'

export type LabelVersion = 0 | 1 | 2

export interface ParseResult {
  labels: LabelRecord[]
  detectedVersion: LabelVersion
  fps?: number
}

function toImpact(val: string | null | undefined): ImpactSurface | null {
  if (!val) return null
  const valid: ImpactSurface[] = ['floor', 'racket', 'wall', 'fence', 'net']
  return valid.includes(val as ImpactSurface) ? (val as ImpactSurface) : null
}

function toShotType(val: string | null | undefined): ShotType | null {
  if (!val) return null
  // Migrate old name
  const normalised = val === 'drive' ? 'groundstroke' : val === 'passing_volley' ? 'medium_volley' : val
  return SHOT_TYPES.includes(normalised as ShotType) ? (normalised as ShotType) : null
}

function toHand(val: string | null | undefined): Hand | null {
  if (!val) return null
  return HANDS.includes(val as Hand) ? (val as Hand) : null
}

function toPlayState(val: string | null | undefined): PlayState {
  return val === 'dead' ? 'dead' : 'in_play'
}

function toVisibility(val: string | null | undefined): Visibility {
  if (val === 'occluded') return 'occluded'
  if (val === 'out_of_frame') return 'out_of_frame'
  return 'visible'
}

export function parseCsv(text: string, version: LabelVersion): ParseResult {
  const lines = text.split('\n')
  const dataLines = lines.filter((l) => !l.startsWith('#') && l.trim() !== '')
  if (dataLines.length === 0) return { labels: [], detectedVersion: 0 }

  const header = dataLines[0].split(',').map((h) => h.trim())
  const col = (name: string) => header.indexOf(name)

  const hasImpact = col('impact') !== -1
  const hasShotType = col('shot_type') !== -1 || col('hand') !== -1
  const detectedVersion: LabelVersion = hasShotType ? 2 : hasImpact ? 1 : 0

  const labels: LabelRecord[] = []
  for (let i = 1; i < dataLines.length; i++) {
    const parts = dataLines[i].split(',')
    const frame = parseInt(parts[col('frame')], 10)
    if (isNaN(frame)) continue

    const xStr = parts[col('x')]
    const yStr = parts[col('y')]
    const x = xStr ? parseFloat(xStr) : null
    const y = yStr ? parseFloat(yStr) : null

    const impactStr = version >= 1 && hasImpact ? parts[col('impact')] : undefined
    const shotIdx = col('shot_type')
    const shotStr = version >= 2 && shotIdx !== -1 ? parts[shotIdx] : undefined
    const handIdx = col('hand')
    const handStr = version >= 2 && handIdx !== -1 ? parts[handIdx] : undefined

    labels.push({
      frame,
      play_state: toPlayState(parts[col('play_state')]),
      visibility: toVisibility(parts[col('visibility')]),
      x: x !== null && !isNaN(x) ? x : null,
      y: y !== null && !isNaN(y) ? y : null,
      impact: toImpact(impactStr),
      shot_type: toShotType(shotStr),
      hand: toHand(handStr),
    })
  }

  return { labels, detectedVersion }
}

export function parseJson(text: string, version: LabelVersion): ParseResult {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text)
  } catch {
    return { labels: [], detectedVersion: 0 }
  }

  const rawLabels = Array.isArray(data.labels) ? (data.labels as Record<string, unknown>[]) : []
  const fps = typeof data.fps === 'number' ? data.fps : undefined

  const hasImpact = rawLabels.length > 0 && 'impact' in rawLabels[0]
  const hasShotType =
    rawLabels.length > 0 && ('shot_type' in rawLabels[0] || 'hand' in rawLabels[0])
  const detectedVersion: LabelVersion = hasShotType ? 2 : hasImpact ? 1 : 0

  const labels: LabelRecord[] = rawLabels.map((r) => ({
    frame: Number(r.frame),
    play_state: toPlayState(r.play_state as string),
    visibility: toVisibility(r.visibility as string),
    x: r.x != null ? Number(r.x) : null,
    y: r.y != null ? Number(r.y) : null,
    impact: version >= 1 && hasImpact ? toImpact(r.impact as string) : null,
    shot_type: version >= 2 ? toShotType(r.shot_type as string) : null,
    hand: version >= 2 ? toHand(r.hand as string) : null,
  }))

  return { labels, detectedVersion, fps }
}

export function detectVersion(text: string, filename: string): LabelVersion {
  if (filename.toLowerCase().endsWith('.json')) {
    try {
      const data = JSON.parse(text) as Record<string, unknown>
      const first = (data.labels as Record<string, unknown>[] | undefined)?.[0]
      if (first && ('shot_type' in first || 'hand' in first)) return 2
      if (first && 'impact' in first) return 1
      return 0
    } catch {
      return 0
    }
  }
  const header = text.split('\n').find((l) => !l.startsWith('#') && l.trim() !== '') ?? ''
  const cols = header.split(',').map((h) => h.trim())
  if (cols.includes('shot_type') || cols.includes('hand')) return 2
  if (cols.includes('impact')) return 1
  return 0
}

export async function parseLabelsFile(file: File, version: LabelVersion): Promise<ParseResult> {
  const text = await file.text()
  if (file.name.toLowerCase().endsWith('.json')) {
    return parseJson(text, version)
  }
  return parseCsv(text, version)
}
