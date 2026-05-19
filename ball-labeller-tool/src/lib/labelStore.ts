import type { LabelRecord } from '../types.ts'

const KEY_PREFIX = 'ball-labeller:'

interface StoredData {
  labels: LabelRecord[]
  fps: number
}

export function saveLabels(filename: string, labels: LabelRecord[], fps: number): void {
  const key = KEY_PREFIX + filename
  const data: StoredData = { labels, fps }
  try {
    localStorage.setItem(key, JSON.stringify(data))
  } catch {
    // Storage might be full; silently ignore
  }
}

export function loadLabels(filename: string): { labels: LabelRecord[]; fps: number } | null {
  const key = KEY_PREFIX + filename
  const raw = localStorage.getItem(key)
  if (!raw) return null
  try {
    const data = JSON.parse(raw) as StoredData
    if (!Array.isArray(data.labels) || typeof data.fps !== 'number') return null
    // Back-compat: older sessions won't have the impact field
    const labels = data.labels.map((r) => ({ ...r, impact: r.impact ?? null }))
    return { labels, fps: data.fps }
  } catch {
    return null
  }
}

export function clearLabels(filename: string): void {
  const key = KEY_PREFIX + filename
  localStorage.removeItem(key)
}
