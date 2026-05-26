import type { Visibility } from '../types.ts'

interface Props {
  value: Visibility
  onChange: (v: Visibility) => void
}

export default function VisibilitySelector({ value, onChange }: Props) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">Visibility</p>
      <div className="grid grid-cols-2 gap-1">
        <button
          onClick={() => onChange('unspecified')}
          className={`col-span-2 px-2 py-1.5 rounded text-sm font-medium transition-colors ${
            value === 'unspecified'
              ? 'bg-slate-500 text-white'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
        >
          Unspecified
        </button>
        <button
          onClick={() => onChange('visible')}
          className={`px-2 py-1.5 rounded text-sm font-medium transition-colors ${
            value === 'visible'
              ? 'bg-green-700 text-white'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
        >
          Visible <span className="text-xs opacity-60">(V)</span>
        </button>
        <button
          onClick={() => onChange('motion_blur')}
          className={`px-2 py-1.5 rounded text-sm font-medium transition-colors ${
            value === 'motion_blur'
              ? 'bg-cyan-700 text-white'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
        >
          Motion Blur <span className="text-xs opacity-60">(M)</span>
        </button>
        <button
          onClick={() => onChange('occluded')}
          className={`px-2 py-1.5 rounded text-sm font-medium transition-colors ${
            value === 'occluded'
              ? 'bg-amber-700 text-white'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
        >
          Occluded <span className="text-xs opacity-60">(O)</span>
        </button>
        <button
          onClick={() => onChange('out_of_frame')}
          className={`px-2 py-1.5 rounded text-sm font-medium transition-colors ${
            value === 'out_of_frame'
              ? 'bg-slate-500 text-white'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
        >
          Out of Frame <span className="text-xs opacity-60">(K)</span>
        </button>
      </div>
    </div>
  )
}
