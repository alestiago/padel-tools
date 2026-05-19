import type { Visibility } from '../types.ts'

interface Props {
  value: Visibility
  onChange: (v: Visibility) => void
}

export default function VisibilitySelector({ value, onChange }: Props) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">Visibility</p>
      <div className="flex flex-col gap-1.5">
        <button
          onClick={() => onChange('visible')}
          className={`w-full text-left px-3 py-2 rounded text-sm font-medium transition-colors ${
            value === 'visible'
              ? 'bg-green-700 text-white'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
        >
          Visible
          <span className="ml-2 text-xs opacity-60">(V)</span>
        </button>
        <button
          onClick={() => onChange('occluded')}
          className={`w-full text-left px-3 py-2 rounded text-sm font-medium transition-colors ${
            value === 'occluded'
              ? 'bg-amber-700 text-white'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
        >
          Occluded
          <span className="ml-2 text-xs opacity-60">(O)</span>
        </button>
        <button
          onClick={() => onChange('out_of_frame')}
          className={`w-full text-left px-3 py-2 rounded text-sm font-medium transition-colors ${
            value === 'out_of_frame'
              ? 'bg-slate-500 text-white'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
        >
          Out of Frame
          <span className="ml-2 text-xs opacity-60">(F)</span>
        </button>
      </div>
    </div>
  )
}
