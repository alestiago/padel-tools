import type { KeypointId, KeypointsMap } from '../types.ts'
import { KEYPOINT_GROUPS, KEYPOINT_LABELS } from '../types.ts'
import { computeAngles } from '../lib/angles.ts'
import { ANGLE_DEFS } from '../lib/skeleton.ts'
import { angleColor } from '../lib/angles.ts'

interface Props {
  keypoints: KeypointsMap
  activeKeypoint: KeypointId
  onSelect: (id: KeypointId) => void
  onRemove: (id: KeypointId) => void
}

function StatusDot({ vis }: { vis?: 'visible' | 'occluded' | 'not_in_frame' }) {
  if (!vis) return <span className="w-2 h-2 rounded-full border border-slate-600 shrink-0" />
  if (vis === 'visible') return <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
  if (vis === 'occluded') return <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
  return <span className="w-2 h-2 rounded-full bg-slate-600 shrink-0" />
}

export default function KeypointPanel({ keypoints, activeKeypoint, onSelect, onRemove }: Props) {
  const angles = computeAngles(keypoints)
  const allAngleDefs = [
    ...ANGLE_DEFS,
    { id: 'trunk_lean', label: 'Trunk', safeMin: 140, safeMax: 180 },
  ]

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto">
      <div>
        <p className="text-xs text-slate-400 uppercase tracking-wide font-medium mb-2">Keypoints</p>
        <div className="space-y-3">
          {KEYPOINT_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="text-xs text-slate-600 mb-1">{group.label}</p>
              <div className="space-y-0.5">
                {group.ids.map((id) => {
                  const kp = keypoints[id]
                  const isActive = id === activeKeypoint
                  return (
                    <button
                      key={id}
                      onClick={() => onSelect(id)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left transition-colors ${
                        isActive
                          ? 'bg-blue-700 text-white'
                          : 'hover:bg-slate-700 text-slate-300'
                      }`}
                    >
                      <StatusDot vis={kp?.visibility} />
                      <span className="flex-1">{KEYPOINT_LABELS[id]}</span>
                      {kp && kp.visibility !== 'not_in_frame' && (
                        <span className={`text-xs font-mono ${isActive ? 'text-blue-200' : 'text-slate-500'}`}>
                          {Math.round(kp.x)},{Math.round(kp.y)}
                        </span>
                      )}
                      {kp?.visibility === 'occluded' && (
                        <span className="text-xs text-amber-500">occ</span>
                      )}
                      {kp?.visibility === 'not_in_frame' && (
                        <span className="text-xs text-slate-600">—</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {keypoints[activeKeypoint] && (
        <button
          onClick={() => onRemove(activeKeypoint)}
          className="w-full px-2 py-1.5 rounded text-xs font-medium bg-red-900 hover:bg-red-800 text-red-200 transition-colors"
        >
          Remove {KEYPOINT_LABELS[activeKeypoint]}
        </button>
      )}

      <div className="border-t border-slate-700 pt-3">
        <p className="text-xs text-slate-400 uppercase tracking-wide font-medium mb-2">Angles</p>
        <div className="space-y-1">
          {allAngleDefs.map((def) => {
            const deg = angles[def.id]
            if (deg === null) {
              return (
                <div key={def.id} className="flex items-center justify-between px-1 py-0.5">
                  <span className="text-xs text-slate-600">{def.label}</span>
                  <span className="text-xs text-slate-700">—</span>
                </div>
              )
            }
            const color = angleColor(deg, def.safeMin, def.safeMax)
            return (
              <div key={def.id} className="flex items-center justify-between px-1 py-0.5">
                <span className="text-xs text-slate-400">{def.label}</span>
                <span className="text-xs font-mono font-medium" style={{ color }}>
                  {Math.round(deg)}°
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
