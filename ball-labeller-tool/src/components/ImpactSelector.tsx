import type { ImpactSurface } from '../types.ts'
import { IMPACT_SHORTCUTS, IMPACT_SURFACES } from '../types.ts'

interface Props {
  value: ImpactSurface | null
  onChange: (v: ImpactSurface | null) => void
}

const SURFACE_STYLES: Record<ImpactSurface, string> = {
  floor:  'bg-orange-700 text-white',
  racket: 'bg-green-700 text-white',
  wall:   'bg-cyan-700 text-white',
  fence:  'bg-red-700 text-white',
  net:    'bg-slate-500 text-white',
}

const SURFACE_LABELS: Record<ImpactSurface, string> = {
  floor:  'Floor',
  racket: 'Racket',
  wall:   'Wall',
  fence:  'Fence',
  net:    'Net',
}

export default function ImpactSelector({ value, onChange }: Props) {
  const handleClick = (surface: ImpactSurface) => {
    onChange(value === surface ? null : surface)
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">Impact</p>
      <div className="grid grid-cols-2 gap-1">
        <button
          onClick={() => onChange(null)}
          className={`col-span-2 px-2 py-1.5 rounded text-sm font-medium transition-colors ${
            value === null
              ? 'bg-slate-500 text-white'
              : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
          }`}
        >
          None
        </button>
        {IMPACT_SURFACES.map((surface) => (
          <button
            key={surface}
            onClick={() => handleClick(surface)}
            className={`px-2 py-1.5 rounded text-sm font-medium transition-colors ${
              value === surface
                ? SURFACE_STYLES[surface]
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            {SURFACE_LABELS[surface]}
            <span className="ml-1 text-xs opacity-50">({IMPACT_SHORTCUTS[surface]})</span>
          </button>
        ))}
      </div>
    </div>
  )
}
