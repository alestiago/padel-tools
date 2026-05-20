import type { LabelRecord, ReviewTarget, VideoMeta } from '../types.ts'
import { SHOT_TYPE_LABELS } from '../types.ts'
import { exportJson } from '../lib/exportJson.ts'
import { exportCsv } from '../lib/exportCsv.ts'

interface Props {
  meta: VideoMeta
  labels: Map<number, LabelRecord>
  queue: ReviewTarget[]
  skipped: ReviewTarget[]
  onReviewSkipped: (queue: ReviewTarget[]) => void
}

export default function DoneScreen({ meta, labels, queue, skipped, onReviewSkipped }: Props) {
  const labelled = queue.filter((t) => !skipped.some((s) => s.frame === t.frame))
  const labelledCount = labelled.filter((t) => labels.get(t.frame)?.shot_type !== null).length

  // Count by shot type
  const byType = new Map<string, number>()
  for (const t of labelled) {
    const st = labels.get(t.frame)?.shot_type
    if (st) byType.set(st, (byType.get(st) ?? 0) + 1)
  }
  const sortedTypes = [...byType.entries()].sort((a, b) => b[1] - a[1])

  return (
    <div className="flex-1 flex flex-col items-center justify-start pt-12 px-8 gap-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-2">Review Complete</h1>
        <p className="text-slate-400 text-sm">{meta.file.name}</p>
      </div>

      <div className="w-full max-w-md bg-slate-800 rounded-xl p-5 space-y-4">
        <p className="text-sm font-medium text-slate-300">Summary</p>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="bg-slate-700 rounded-lg p-3">
            <p className="text-2xl font-bold text-slate-100">{queue.length}</p>
            <p className="text-xs text-slate-400 mt-0.5">Total shots</p>
          </div>
          <div className="bg-slate-700 rounded-lg p-3">
            <p className="text-2xl font-bold text-green-400">{labelledCount}</p>
            <p className="text-xs text-slate-400 mt-0.5">Labelled</p>
          </div>
          <div className="bg-slate-700 rounded-lg p-3">
            <p className="text-2xl font-bold text-amber-400">{skipped.length}</p>
            <p className="text-xs text-slate-400 mt-0.5">Skipped</p>
          </div>
        </div>

        {sortedTypes.length > 0 && (
          <div className="space-y-1 pt-1">
            <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">By shot type</p>
            {sortedTypes.map(([type, count]) => (
              <div key={type} className="flex justify-between text-sm text-slate-300">
                <span>{SHOT_TYPE_LABELS[type as keyof typeof SHOT_TYPE_LABELS] ?? type}</span>
                <span className="font-mono text-slate-400">{count}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-3 w-full max-w-md">
        <button
          onClick={() => exportJson(meta, labels)}
          className="flex-1 bg-blue-700 hover:bg-blue-600 text-white font-medium py-3 rounded-lg transition-colors"
        >
          Export JSON
        </button>
        <button
          onClick={() => exportCsv(meta, labels)}
          className="flex-1 bg-green-700 hover:bg-green-600 text-white font-medium py-3 rounded-lg transition-colors"
        >
          Export CSV
        </button>
      </div>

      {skipped.length > 0 && (
        <button
          onClick={() => onReviewSkipped(skipped)}
          className="w-full max-w-md bg-amber-700 hover:bg-amber-600 text-white font-medium py-3 rounded-lg transition-colors"
        >
          Review {skipped.length} skipped shot{skipped.length === 1 ? '' : 's'}
        </button>
      )}
    </div>
  )
}
