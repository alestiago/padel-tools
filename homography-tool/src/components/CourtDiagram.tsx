import { useTranslation } from 'react-i18next'
import { COURT_KEYPOINTS, NET_Y, SVC_Y_FAR, SVC_Y_NEAR } from '../lib/courtKeypoints'
import type { MarkedPoint } from '../types'

interface Props {
  points: MarkedPoint[]
  currentKeypointId: string | null
}

// Real-world metres → SVG units (1 m = 10 SVG units)
const S = 10
const W = 100  // 10 m
const L = 200  // 20 m
// Glass corner panels on side walls: 4 m from each back wall; fencing runs y=4–16 m
const GLASS_Y = 4 * S

const lines = [
  // back walls (glass fondos)
  { x1: 0, y1: 0,   x2: W, y2: 0   },
  { x1: 0, y1: L,   x2: W, y2: L   },
  // side walls – glass corner sections only
  { x1: 0, y1: 0,        x2: 0, y2: GLASS_Y      },
  { x1: 0, y1: L - GLASS_Y, x2: 0, y2: L          },
  { x1: W, y1: 0,        x2: W, y2: GLASS_Y      },
  { x1: W, y1: L - GLASS_Y, x2: W, y2: L          },
  // net
  { x1: 0, y1: NET_Y * S,     x2: W, y2: NET_Y * S     },
  // service lines
  { x1: 0, y1: SVC_Y_NEAR * S, x2: W, y2: SVC_Y_NEAR * S },
  { x1: 0, y1: SVC_Y_FAR  * S, x2: W, y2: SVC_Y_FAR  * S },
  // center service line
  { x1: W / 2, y1: SVC_Y_NEAR * S, x2: W / 2, y2: SVC_Y_FAR * S },
]

// Side fencing: metal wire mesh between the glass corner panels
const fenceLines = [
  { x1: 0, y1: GLASS_Y, x2: 0, y2: L - GLASS_Y },
  { x1: W, y1: GLASS_Y, x2: W, y2: L - GLASS_Y },
]

export default function CourtDiagram({ points, currentKeypointId }: Props) {
  const { t } = useTranslation()
  const marked = new Map(points.map(p => [p.keypointId, p]))

  return (
    <div className="bg-slate-800 rounded-xl p-3 flex flex-col gap-2">
      <p className="text-xs text-slate-400 font-medium">{t('courtDiagram.title')}</p>
      <svg
        viewBox={`-12 -12 ${W + 24} ${L + 24}`}
        className="w-full"
        style={{ maxHeight: '440px' }}
      >
        {/* Court surface */}
        <rect x={0} y={0} width={W} height={L} fill="#134e4a" rx={1} />

        {/* Lines */}
        {lines.map((l, i) => (
          <line
            key={i}
            x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
            stroke="white" strokeWidth={0.8} strokeOpacity={0.9}
          />
        ))}

        {/* Side fencing */}
        {fenceLines.map((l, i) => (
          <line
            key={i}
            x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
            stroke="#9ca3af" strokeWidth={1.5}
          />
        ))}

        {/* Net indicator */}
        <line
          x1={0} y1={NET_Y * S} x2={W} y2={NET_Y * S}
          stroke="#fbbf24" strokeWidth={1.5} strokeOpacity={0.7}
        />

        {/* Keypoints */}
        {COURT_KEYPOINTS.map(kp => {
          const cx = kp.real.x * S
          const cy = kp.real.y * S
          const mp = marked.get(kp.id)
          const isMarked    = !!mp
          const isImaginary = !!mp?.imaginary
          const isCurrent   = kp.id === currentKeypointId

          return (
            <g key={kp.id}>
              {isCurrent && (
                <circle cx={cx} cy={cy} r={6} fill="none" stroke={kp.color} strokeWidth={1} opacity={0.4}>
                  <animate attributeName="r" values="5;8;5" dur="1.2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.4;0.1;0.4" dur="1.2s" repeatCount="indefinite" />
                </circle>
              )}
              <circle
                cx={cx} cy={cy} r={3}
                fill={isMarked && !isImaginary ? kp.color : 'none'}
                stroke={kp.color}
                strokeWidth={1}
                strokeDasharray={isImaginary ? '2 1.5' : undefined}
                opacity={isMarked || isCurrent ? 1 : 0.35}
              />
              <text
                x={cx + 3.5} y={cy - 3.5}
                fontSize={4} fill={kp.color}
                opacity={isMarked || isCurrent ? 1 : 0.35}
                fontWeight="bold"
              >
                {kp.id}
              </text>
            </g>
          )
        })}
      </svg>

      {/* Legend */}
      <div className="space-y-1 mt-1">
        {COURT_KEYPOINTS.map(kp => {
          const mp = marked.get(kp.id)
          const isMarked    = !!mp
          const isImaginary = !!mp?.imaginary
          const isCurrent   = kp.id === currentKeypointId
          return (
            <div
              key={kp.id}
              className={[
                'flex items-center gap-2 text-xs px-2 py-0.5 rounded',
                isCurrent ? 'bg-slate-700' : '',
              ].join(' ')}
            >
              <span
                className="w-3 h-3 rounded-full shrink-0 border"
                style={{
                  backgroundColor: isMarked && !isImaginary ? kp.color : 'transparent',
                  borderColor: kp.color,
                  borderStyle: isImaginary ? 'dashed' : 'solid',
                  opacity: isMarked || isCurrent ? 1 : 0.35,
                }}
              />
              <span style={{ color: kp.color, opacity: isMarked || isCurrent ? 1 : 0.35 }}
                className="font-mono font-bold w-4 shrink-0"
              >{kp.id}</span>
              <span className={isMarked || isCurrent ? 'text-slate-300' : 'text-slate-600'}>
                {t(kp.labelKey)}
              </span>
              {isMarked && !isImaginary && <span className="ml-auto text-green-400">✓</span>}
              {isImaginary && <span className="ml-auto text-slate-400 text-[10px]">{t('courtDiagram.imaginary')}</span>}
              {isCurrent && <span className="ml-auto text-yellow-400 animate-pulse">←</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
