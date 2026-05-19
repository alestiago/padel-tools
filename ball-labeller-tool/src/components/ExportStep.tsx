import type { LabelRecord, VideoMeta } from '../types.ts'
import { exportJson } from '../lib/exportJson.ts'
import { exportCsv } from '../lib/exportCsv.ts'

interface Props {
  meta: VideoMeta
  labels: Map<number, LabelRecord>
  onBack: () => void
}

export default function ExportStep({ meta, labels, onBack }: Props) {
  const total = meta.frameCount
  const labelled = labels.size
  const pct = total > 0 ? Math.round((labelled / total) * 100) : 0

  const arr = [...labels.values()]

  const inPlayVisible = arr.filter(r => r.play_state === 'in_play' && r.visibility === 'visible').length
  const inPlayOccluded = arr.filter(r => r.play_state === 'in_play' && r.visibility === 'occluded').length
  const inPlayOof = arr.filter(r => r.play_state === 'in_play' && r.visibility === 'out_of_frame').length
  const dead = arr.filter(r => r.play_state === 'dead').length
  const impacts = arr.filter(r => r.impact !== null && r.impact !== undefined).length

  return (
    <div className="flex-1 flex flex-col items-center justify-start pt-12 px-8 gap-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-2">Export Labels</h1>
        <p className="text-slate-400 text-sm">{meta.file.name}</p>
      </div>

      {/* Stats card */}
      <div className="w-full max-w-md bg-slate-800 rounded-xl p-5 space-y-4">
        <p className="text-sm font-medium text-slate-300">Summary</p>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="bg-slate-700 rounded-lg p-3">
            <p className="text-2xl font-bold text-slate-100">{total}</p>
            <p className="text-xs text-slate-400 mt-0.5">Total frames</p>
          </div>
          <div className="bg-slate-700 rounded-lg p-3">
            <p className="text-2xl font-bold text-slate-100">{labelled}</p>
            <p className="text-xs text-slate-400 mt-0.5">Labelled</p>
          </div>
          <div className="bg-slate-700 rounded-lg p-3">
            <p className="text-2xl font-bold text-slate-100">{pct}%</p>
            <p className="text-xs text-slate-400 mt-0.5">Complete</p>
          </div>
        </div>

        {/* Progress bar */}
        <div className="w-full bg-slate-700 rounded-full h-2">
          <div
            className="bg-green-600 h-2 rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="space-y-2 text-sm">
          <p className="text-slate-400 font-medium text-xs uppercase tracking-wide">Breakdown</p>
          <div className="flex justify-between text-slate-300">
            <span>In Play + Visible</span>
            <span className="font-mono">{inPlayVisible}</span>
          </div>
          <div className="flex justify-between text-slate-300">
            <span>In Play + Occluded</span>
            <span className="font-mono">{inPlayOccluded}</span>
          </div>
          <div className="flex justify-between text-slate-300">
            <span>In Play + Out of Frame</span>
            <span className="font-mono">{inPlayOof}</span>
          </div>
          <div className="flex justify-between text-slate-300">
            <span>Dead (all)</span>
            <span className="font-mono">{dead}</span>
          </div>
          {impacts > 0 && (
            <>
              <div className="border-t border-slate-600 pt-2 mt-1 flex justify-between text-orange-300">
                <span>Impacts labelled</span>
                <span className="font-mono">{impacts}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Download buttons */}
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

      <button
        onClick={onBack}
        className="text-slate-400 hover:text-slate-200 text-sm transition-colors"
      >
        &larr; Back to labelling
      </button>
    </div>
  )
}
