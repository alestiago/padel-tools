import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeypointId, KeypointsMap } from '../types.ts'
import { CONNECTIONS, ANGLE_DEFS } from '../lib/skeleton.ts'
import { computeAngles, angleColor } from '../lib/angles.ts'

const KP_RADIUS = 6
const ARC_RADIUS = 22

function keypointColor(id: KeypointId): string {
  if (id.startsWith('left_')) return '#38bdf8'
  if (id.startsWith('right_')) return '#fb923c'
  return '#e2e8f0'
}

interface Layout {
  scale: number
  offsetX: number
  offsetY: number
}

interface ContextMenu {
  screenX: number
  screenY: number
  keypointId: KeypointId
}

interface Props {
  videoRef: React.RefObject<HTMLVideoElement | null>
  videoWidth: number
  videoHeight: number
  keypoints: KeypointsMap
  activeKeypoint: KeypointId
  onPlace: (id: KeypointId, x: number, y: number) => void
  onRemove: (id: KeypointId) => void
  onSetVisibility: (id: KeypointId, vis: 'occluded' | 'not_in_frame') => void
}

export default function PoseCanvas({
  videoRef,
  videoWidth,
  videoHeight,
  keypoints,
  activeKeypoint,
  onPlace,
  onRemove,
  onSetVisibility,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number>(0)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)

  const getLayout = useCallback((): Layout | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight
    if (cw === 0 || ch === 0 || videoWidth === 0 || videoHeight === 0) return null
    const scale = Math.min(cw / videoWidth, ch / videoHeight)
    return {
      scale,
      offsetX: (cw - videoWidth * scale) / 2,
      offsetY: (ch - videoHeight * scale) / 2,
    }
  }, [videoWidth, videoHeight])

  const toDisplay = useCallback((vx: number, vy: number, layout: Layout) => ({
    x: vx * layout.scale + layout.offsetX,
    y: vy * layout.scale + layout.offsetY,
  }), [])

  const toVideo = useCallback((cx: number, cy: number): { x: number; y: number } | null => {
    const layout = getLayout()
    if (!layout) return null
    const vx = (cx - layout.offsetX) / layout.scale
    const vy = (cy - layout.offsetY) / layout.scale
    if (vx < 0 || vy < 0 || vx > videoWidth || vy > videoHeight) return null
    return { x: vx, y: vy }
  }, [getLayout, videoWidth, videoHeight])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight

    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr
      canvas.height = ch * dpr
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const layout = getLayout()
    if (!layout) return

    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, cw, ch)

    // Skeleton connections
    for (const [aId, bId] of CONNECTIONS) {
      const a = keypoints[aId]
      const b = keypoints[bId]
      if (!a || !b) continue
      if (a.visibility === 'not_in_frame' || b.visibility === 'not_in_frame') continue
      const dp1 = toDisplay(a.x, a.y, layout)
      const dp2 = toDisplay(b.x, b.y, layout)
      const dashed = a.visibility === 'occluded' || b.visibility === 'occluded'
      ctx.save()
      ctx.beginPath()
      if (dashed) ctx.setLineDash([4, 4])
      ctx.moveTo(dp1.x, dp1.y)
      ctx.lineTo(dp2.x, dp2.y)
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.restore()
    }

    // Angle arcs
    const angles = computeAngles(keypoints)
    for (const def of ANGLE_DEFS) {
      const deg = angles[def.id]
      if (deg === null) continue
      const p = keypoints[def.proximal]
      const v = keypoints[def.vertex]
      const d = keypoints[def.distal]
      if (!p || !v || !d) continue
      if (p.visibility === 'not_in_frame' || v.visibility === 'not_in_frame' || d.visibility === 'not_in_frame') continue

      const vd = toDisplay(v.x, v.y, layout)
      // vectors from vertex (in video space, direction doesn't depend on scale)
      const ax = p.x - v.x, ay = p.y - v.y
      const bx = d.x - v.x, by = d.y - v.y
      const startAngle = Math.atan2(ay, ax)
      const endAngle = Math.atan2(by, bx)

      // pick the shorter arc
      let diff = endAngle - startAngle
      while (diff > Math.PI) diff -= 2 * Math.PI
      while (diff < -Math.PI) diff += 2 * Math.PI
      const anticlockwise = diff < 0

      const color = angleColor(deg, def.safeMin, def.safeMax)

      ctx.beginPath()
      ctx.arc(vd.x, vd.y, ARC_RADIUS, startAngle, endAngle, anticlockwise)
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.stroke()

      // Label along bisector
      const lenA = Math.sqrt(ax * ax + ay * ay)
      const lenB = Math.sqrt(bx * bx + by * by)
      const bisx = ax / lenA + bx / lenB
      const bisy = ay / lenA + by / lenB
      const bisLen = Math.sqrt(bisx * bisx + bisy * bisy)
      const labelDist = ARC_RADIUS + 13
      const lx = bisLen > 0 ? vd.x + (bisx / bisLen) * labelDist : vd.x
      const ly = bisLen > 0 ? vd.y + (bisy / bisLen) * labelDist : vd.y - labelDist
      const text = `${Math.round(deg)}°`
      ctx.font = 'bold 11px sans-serif'
      const tw = ctx.measureText(text).width
      ctx.fillStyle = 'rgba(0,0,0,0.65)'
      ctx.fillRect(lx - tw / 2 - 3, ly - 9, tw + 6, 14)
      ctx.fillStyle = color
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, lx, ly - 1)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
    }

    // trunk_lean arc (uses virtual midpoints — drawn separately)
    {
      const deg = angles['trunk_lean']
      const neck = keypoints['neck']
      const lh = keypoints['left_hip']
      const rh = keypoints['right_hip']
      const lk = keypoints['left_knee']
      const rk = keypoints['right_knee']
      if (deg !== null && neck && lh && rh && lk && rk) {
        const midHip = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 }
        const midKnee = { x: (lk.x + rk.x) / 2, y: (lk.y + rk.y) / 2 }
        const vd = toDisplay(midHip.x, midHip.y, layout)
        const ax = neck.x - midHip.x, ay = neck.y - midHip.y
        const bx = midKnee.x - midHip.x, by = midKnee.y - midHip.y
        const startAngle = Math.atan2(ay, ax)
        const endAngle = Math.atan2(by, bx)
        let diff = endAngle - startAngle
        while (diff > Math.PI) diff -= 2 * Math.PI
        while (diff < -Math.PI) diff += 2 * Math.PI
        const color = angleColor(deg, 140, 180)
        ctx.beginPath()
        ctx.arc(vd.x, vd.y, ARC_RADIUS, startAngle, endAngle, diff < 0)
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.stroke()
        const lenA = Math.sqrt(ax * ax + ay * ay)
        const lenB = Math.sqrt(bx * bx + by * by)
        const bisx = ax / lenA + bx / lenB
        const bisy = ay / lenA + by / lenB
        const bisLen = Math.sqrt(bisx * bisx + bisy * bisy)
        const lx = bisLen > 0 ? vd.x + (bisx / bisLen) * (ARC_RADIUS + 13) : vd.x + ARC_RADIUS + 13
        const ly = bisLen > 0 ? vd.y + (bisy / bisLen) * (ARC_RADIUS + 13) : vd.y
        const text = `${Math.round(deg)}°`
        ctx.font = 'bold 11px sans-serif'
        const tw = ctx.measureText(text).width
        ctx.fillStyle = 'rgba(0,0,0,0.65)'
        ctx.fillRect(lx - tw / 2 - 3, ly - 9, tw + 6, 14)
        ctx.fillStyle = color
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, lx, ly - 1)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
      }
    }

    // Keypoints
    for (const [id, kp] of Object.entries(keypoints) as [KeypointId, NonNullable<KeypointsMap[KeypointId]>][]) {
      if (kp.visibility === 'not_in_frame') continue
      const dp = toDisplay(kp.x, kp.y, layout)
      const color = keypointColor(id)
      const isActive = id === activeKeypoint

      if (kp.visibility === 'occluded') {
        ctx.beginPath()
        ctx.setLineDash([3, 3])
        ctx.arc(dp.x, dp.y, KP_RADIUS, 0, Math.PI * 2)
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.setLineDash([])
      } else {
        ctx.beginPath()
        ctx.arc(dp.x, dp.y, KP_RADIUS, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'
        ctx.lineWidth = 1
        ctx.stroke()
      }

      if (isActive) {
        ctx.beginPath()
        ctx.arc(dp.x, dp.y, KP_RADIUS + 4, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }

    // Active keypoint cursor hint (ring) when not yet placed
    if (!keypoints[activeKeypoint]) {
      // draw a faint ring at center as placeholder indication handled by cursor
    }

    ctx.restore()
  }, [keypoints, activeKeypoint, getLayout, toDisplay])

  useEffect(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(draw)
  }, [draw])

  // Also redraw when video frame updates
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onSeeked = () => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(draw)
    }
    video.addEventListener('seeked', onSeeked)
    return () => video.removeEventListener('seeked', onSeeked)
  }, [videoRef, draw])

  const hitTestKeypoint = useCallback((cx: number, cy: number): KeypointId | null => {
    const layout = getLayout()
    if (!layout) return null
    for (const [id, kp] of Object.entries(keypoints) as [KeypointId, NonNullable<KeypointsMap[KeypointId]>][]) {
      if (kp.visibility === 'not_in_frame') continue
      const dp = toDisplay(kp.x, kp.y, layout)
      const dist = Math.sqrt((cx - dp.x) ** 2 + (cy - dp.y) ** 2)
      if (dist <= KP_RADIUS + 4) return id
    }
    return null
  }, [keypoints, getLayout, toDisplay])

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (contextMenu) { setContextMenu(null); return }
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const videoCoords = toVideo(cx, cy)
    if (!videoCoords) return
    onPlace(activeKeypoint, videoCoords.x, videoCoords.y)
  }

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const hit = hitTestKeypoint(cx, cy)
    if (hit) {
      setContextMenu({ screenX: e.clientX, screenY: e.clientY, keypointId: hit })
    }
  }

  return (
    <div className="relative w-full h-full bg-black" onClick={() => setContextMenu(null)}>
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-contain"
        muted
        preload="auto"
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ cursor: 'crosshair' }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      />

      {contextMenu && (
        <div
          className="fixed z-50 bg-slate-800 border border-slate-600 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: contextMenu.screenX, top: contextMenu.screenY }}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="px-3 py-1 text-xs text-slate-400 border-b border-slate-700 mb-1">
            {contextMenu.keypointId.replace(/_/g, ' ')}
          </p>
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
            onClick={() => { onSetVisibility(contextMenu.keypointId, 'occluded'); setContextMenu(null) }}
          >
            Mark occluded
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
            onClick={() => { onSetVisibility(contextMenu.keypointId, 'not_in_frame'); setContextMenu(null) }}
          >
            Mark not in frame
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-slate-700"
            onClick={() => { onRemove(contextMenu.keypointId); setContextMenu(null) }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
