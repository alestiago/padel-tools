import type { ImpactSurface, LabelRecord, PlayState, Visibility } from '../types.ts'

export type LabelVersion = 0 | 1

export interface ParseResult {
  labels: LabelRecord[]
  /** Version inferred from the file content — may differ from the user-selected override. */
  detectedVersion: LabelVersion
  /** fps from JSON metadata, if present. */
  fps?: number
}

function toImpact(val: string | null | undefined): ImpactSurface | null {
  if (!val) return null
  const valid: ImpactSurface[] = ['floor', 'racket', 'wall', 'fence', 'net']
  return valid.includes(val as ImpactSurface) ? (val as ImpactSurface) : null
}

function toPlayState(val: string | null | undefined): PlayState {
  return val === 'dead' ? 'dead' : 'in_play'
}

function toVisibility(val: string | null | undefined): Visibility {
  if (val === 'occluded') return 'occluded'
  if (val === 'out_of_frame') return 'out_of_frame'
  return 'visible'
}

/** Parse a labels CSV (with or without leading # comment lines). */
export function parseCsv(text: string, version: LabelVersion): ParseResult {
  const lines = text.split('\n')

  // Strip comment lines to find the real header and data
  const dataLines = lines.filter((l) => !l.startsWith('#') && l.trim() !== '')
  if (dataLines.length === 0) return { labels: [], detectedVersion: 0 }

  const header = dataLines[0].split(',').map((h) => h.trim())
  const col = (name: string) => header.indexOf(name)

  const hasImpact = col('impact') !== -1
  const detectedVersion: LabelVersion = hasImpact ? 1 : 0

  const labels: LabelRecord[] = []
  for (let i = 1; i < dataLines.length; i++) {
    const parts = dataLines[i].split(',')
    const frameStr = parts[col('frame')]
    const frame = parseInt(frameStr, 10)
    if (isNaN(frame)) continue

    const xStr = parts[col('x')]
    const yStr = parts[col('y')]
    const x = xStr ? parseFloat(xStr) : null
    const y = yStr ? parseFloat(yStr) : null

    const impactStr = version === 1 && hasImpact ? parts[col('impact')] : undefined

    labels.push({
      frame,
      play_state: toPlayState(parts[col('play_state')]),
      visibility: toVisibility(parts[col('visibility')]),
      x: x !== null && !isNaN(x) ? x : null,
      y: y !== null && !isNaN(y) ? y : null,
      impact: toImpact(impactStr),
    })
  }

  return { labels, detectedVersion }
}

/** Parse a labels JSON export. */
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
  const detectedVersion: LabelVersion = hasImpact ? 1 : 0

  const labels: LabelRecord[] = rawLabels.map((r) => ({
    frame: Number(r.frame),
    play_state: toPlayState(r.play_state as string),
    visibility: toVisibility(r.visibility as string),
    x: r.x != null ? Number(r.x) : null,
    y: r.y != null ? Number(r.y) : null,
    impact: version === 1 && hasImpact ? toImpact(r.impact as string) : null,
  }))

  return { labels, detectedVersion, fps }
}

/** Read just enough of the file text to guess the schema version. */
export function detectVersion(text: string, filename: string): LabelVersion {
  if (filename.toLowerCase().endsWith('.json')) {
    try {
      const data = JSON.parse(text) as Record<string, unknown>
      const first = (data.labels as Record<string, unknown>[] | undefined)?.[0]
      return first && 'impact' in first ? 1 : 0
    } catch {
      return 0
    }
  }
  // CSV: check the header row (first non-comment line)
  const header = text.split('\n').find((l) => !l.startsWith('#') && l.trim() !== '') ?? ''
  return header.split(',').map((h) => h.trim()).includes('impact') ? 1 : 0
}

/** Top-level convenience: read a File and return a ParseResult. */
export async function parseLabelsFile(
  file: File,
  version: LabelVersion,
): Promise<ParseResult> {
  const text = await file.text()
  if (file.name.toLowerCase().endsWith('.json')) {
    return parseJson(text, version)
  }
  return parseCsv(text, version)
}
