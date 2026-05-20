import type { PlayState } from '../types.ts'

interface Props {
  value: PlayState
  onChange: (v: PlayState) => void
}

export default function PlayStateSelector({ value, onChange }: Props) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">Play State</p>
      <div className="flex gap-1.5">
        <button
          onClick={() => onChange('in_play')}
          className={`flex-1 px-2 py-2 rounded text-sm font-medium transition-colors ${
            value === 'in_play'
              ? 'bg-green-700 text-white'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
        >
          In Play <span className="text-xs opacity-60">(P)</span>
        </button>
        <button
          onClick={() => onChange('dead')}
          className={`flex-1 px-2 py-2 rounded text-sm font-medium transition-colors ${
            value === 'dead'
              ? 'bg-red-700 text-white'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
        >
          Dead <span className="text-xs opacity-60">(D)</span>
        </button>
      </div>
    </div>
  )
}
