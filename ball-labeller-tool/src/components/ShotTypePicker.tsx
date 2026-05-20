import { useState } from 'react'
import type { ShotType } from '../types.ts'
import { SHOT_TYPE_COLORS, SHOT_TYPE_GROUPS, SHOT_TYPE_LABELS } from '../types.ts'

interface Props {
  value: ShotType | null
  recents: ShotType[]
  onSelect: (t: ShotType | null) => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
}

export default function ShotTypePicker({ value, recents, onSelect, searchInputRef }: Props) {
  const [filter, setFilter] = useState('')
  const [listOpen, setListOpen] = useState(false)

  const lowerFilter = filter.toLowerCase()
  const filteredGroups = Object.entries(SHOT_TYPE_GROUPS)
    .map(([cat, shots]) => ({
      cat,
      shots: lowerFilter
        ? shots.filter(
            (s) =>
              SHOT_TYPE_LABELS[s].toLowerCase().includes(lowerFilter) ||
              s.includes(lowerFilter),
          )
        : shots,
    }))
    .filter(({ shots }) => shots.length > 0)

  const handleSelect = (t: ShotType) => {
    onSelect(t)
    setFilter('')
    setListOpen(false)
    searchInputRef.current?.blur()
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">Shot type</p>

      {/* Current badge */}
      {value ? (
        <div
          className="flex items-center justify-between px-2.5 py-1.5 rounded text-sm font-medium text-white"
          style={{ backgroundColor: SHOT_TYPE_COLORS[value] }}
        >
          <span className="truncate">{SHOT_TYPE_LABELS[value]}</span>
          <button
            onClick={() => onSelect(null)}
            className="ml-1.5 shrink-0 opacity-70 hover:opacity-100 text-base leading-none"
            title="Clear shot type"
          >
            ×
          </button>
        </div>
      ) : (
        <div className="px-2.5 py-1.5 rounded text-sm text-slate-500 bg-slate-700">
          Not set
        </div>
      )}

      {/* Recents */}
      {recents.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {recents.map((s) => (
            <button
              key={s}
              onClick={() => handleSelect(s)}
              className="px-2 py-0.5 rounded text-xs font-medium text-white transition-opacity hover:opacity-80 truncate max-w-full"
              style={{ backgroundColor: SHOT_TYPE_COLORS[s] }}
              title={SHOT_TYPE_LABELS[s]}
            >
              {SHOT_TYPE_LABELS[s]}
            </button>
          ))}
        </div>
      )}

      {/* Search + inline list */}
      <input
        ref={searchInputRef}
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onFocus={() => setListOpen(true)}
        onBlur={() => setTimeout(() => setListOpen(false), 120)}
        placeholder={recents.length > 0 ? 'All shots… (T)' : 'Search shots… (T)'}
        className="w-full bg-slate-700 border border-slate-600 rounded px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-400"
      />

      {listOpen && (
        <div className="bg-slate-900 border border-slate-700 rounded overflow-hidden">
          {filteredGroups.map(({ cat, shots }) => (
            <div key={cat}>
              <p className="text-xs text-slate-500 px-2.5 pt-1.5 pb-0.5 font-medium uppercase tracking-wide">
                {cat}
              </p>
              {shots.map((s) => (
                <button
                  key={s}
                  onMouseDown={() => handleSelect(s)}
                  className="w-full text-left px-2.5 py-1 text-sm text-slate-200 hover:bg-slate-700 flex items-center gap-2"
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: SHOT_TYPE_COLORS[s] }}
                  />
                  {SHOT_TYPE_LABELS[s]}
                </button>
              ))}
            </div>
          ))}
          {filteredGroups.length === 0 && (
            <p className="text-xs text-slate-500 px-2.5 py-3">No shots match</p>
          )}
        </div>
      )}
    </div>
  )
}
