import { useCallback, useEffect, useRef } from 'react'
import type { LabelRecord, Visibility } from '../types.ts'
import { SHOT_TYPE_ABBR, SHOT_TYPE_COLORS } from '../types.ts'
import { drawLoupe } from '@shared/loupeDraw.ts'

const IMPACT_COLORS: Record<string, string> = {
  floor: '#f97316', racket: '#22c55e', wall: '#22d3ee',
  fence: '#ef4444', net: '#94a3b8',
}
const IMPACT_LINGER_FRAMES = 90

interface Props {
  videoRef: React.RefObject<HTMLVideoElement | null>
  videoWidth: number
  videoHeight: number
  labels: Map<number, LabelRecord>
  currentFrame: number
  stickyVis: Visibility
  isPlaying: boolean
  onVideoClick: (x: number, y: number) => void
}

interface Layout {
  scale: number
  offsetX: number
  offsetY: number
}

export default function VideoCanvas({
  videoRef,
  videoWidth,
  videoHeight,
  labels,
  currentFrame,
  stickyVis,
  isPlaying,
  onVideoClick,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const mouseRef = useRef<{ display: { x: number; y: number }; video: { x: number; y: number } } | null>(null)
  const rafRef = useRef<number>(0)

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

  const toVideo = useCallback((cx: number, cy: number): { x: number; y: number } | null => {
    const layout = getLayout()
    if (!layout) return null
    const vx = (cx - layout.offsetX) / layout.scale
    const vy = (cy - layout.offsetY) / layout.scale
    if (vx < 0 || vy < 0 || vx > videoWidth || vy > videoHeight) return null
    return { x: vx, y: vy }
  }, [getLayout, videoWidth, videoHeight])

  const toDisplay = useCallback((vx: number, vy: number): { x: number; y: number } | null => {
    const layout = getLayout()
    if (!layout) return null
    return {
      x: vx * layout.scale + layout.offsetX,
      y: vy * layout.scale + layout.offsetY,
    }
  }, [getLayout])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const video = videoRef.current
    const dpr = window.devicePixelRatio || 1
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight

    // Resize if needed
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr
      canvas.height = ch * dpr
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, cw, ch)

    // Dead-point tint
    if (labels.get(currentFrame)?.play_state === 'dead') {
      ctx.fillStyle = 'rgba(220, 38, 38, 0.18)'
      ctx.fillRect(0, 0, cw, ch)
    }

    // Trail dots: only while playing
    for (let i = isPlaying ? 5 : 0; i >= 1; i--) {
      const f = currentFrame - i
      if (f < 0) continue
      const rec = labels.get(f)
      if (!rec || rec.x === null || rec.y === null) continue
      const dp = toDisplay(rec.x, rec.y)
      if (!dp) continue
      const alpha = 0.2 + (0.8 * (5 - i + 1)) / 5
      ctx.globalAlpha = alpha
      ctx.beginPath()
      ctx.arc(dp.x, dp.y, 4, 0, Math.PI * 2)
      if (rec.visibility === 'visible') {
        ctx.fillStyle = '#22c55e'
      } else if (rec.visibility === 'motion_blur') {
        ctx.fillStyle = '#22d3ee'
      } else {
        ctx.fillStyle = '#f97316'
      }
      ctx.fill()
      ctx.globalAlpha = 1
    }

    // Current frame marker
    const curRec = labels.get(currentFrame)
    if (curRec && curRec.x !== null && curRec.y !== null) {
      const dp = toDisplay(curRec.x, curRec.y)
      if (dp) {
        const markerColor = curRec.visibility === 'motion_blur' ? '#22d3ee' : '#ffffff'
        ctx.beginPath()
        ctx.arc(dp.x, dp.y, 6, 0, Math.PI * 2)
        ctx.strokeStyle = markerColor
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(dp.x, dp.y, 2, 0, Math.PI * 2)
        ctx.fillStyle = markerColor
        ctx.fill()

      }
    }

    // Impact overlay — on current frame always; lingers while playing
    {
      // Step 1: find the most recent impact frame (position not required)
      let impactRec: LabelRecord | null = null
      let framesAgo = 0
      const lingerWindow = isPlaying ? IMPACT_LINGER_FRAMES : 0
      for (let i = 0; i <= lingerWindow; i++) {
        const rec = labels.get(currentFrame - i)
        if (rec?.impact) { impactRec = rec; framesAgo = i; break }
      }
      // Step 2: resolve display position — use impact frame's coords, or
      // scan up to 5 frames either side for the nearest labelled position
      let dispX: number | null = impactRec?.x ?? null
      let dispY: number | null = impactRec?.y ?? null
      if (impactRec && (dispX === null || dispY === null)) {
        const impactFrame = currentFrame - framesAgo
        for (let di = 1; di <= 5; di++) {
          for (const f of [impactFrame + di, impactFrame - di]) {
            const r = labels.get(f)
            if (r && r.x !== null && r.y !== null) { dispX = r.x; dispY = r.y; break }
          }
          if (dispX !== null) break
        }
      }
      if (impactRec && dispX !== null && dispY !== null) {
        const dp = toDisplay(dispX, dispY)
        if (dp) {
          const alpha = 1 - framesAgo / IMPACT_LINGER_FRAMES
          const color = IMPACT_COLORS[impactRec.impact!] ?? '#facc15'
          const r = 11
          ctx.globalAlpha = alpha
          ctx.beginPath()
          ctx.moveTo(dp.x, dp.y - r)
          ctx.lineTo(dp.x + r, dp.y)
          ctx.lineTo(dp.x, dp.y + r)
          ctx.lineTo(dp.x - r, dp.y)
          ctx.closePath()
          ctx.strokeStyle = color
          ctx.lineWidth = 2
          ctx.stroke()
          const label =
            impactRec.impact === 'racket' && impactRec.shot_type
              ? SHOT_TYPE_ABBR[impactRec.shot_type]
              : impactRec.impact!
          const labelColor =
            impactRec.impact === 'racket' && impactRec.shot_type
              ? SHOT_TYPE_COLORS[impactRec.shot_type]
              : color
          ctx.font = 'bold 11px sans-serif'
          ctx.fillStyle = labelColor
          ctx.textAlign = 'center'
          ctx.fillText(label, dp.x, dp.y + r + 13)
          ctx.textAlign = 'left'
          ctx.globalAlpha = 1
        }
      }
    }

    // Loupe
    const mouse = mouseRef.current
    const layout = getLayout()
    if (mouse && video && layout && stickyVis !== 'out_of_frame') {
      drawLoupe(ctx, video, mouse.display, mouse.video, layout.scale, cw)
    }

    ctx.restore()
  }, [videoRef, currentFrame, labels, stickyVis, isPlaying, toDisplay, getLayout])

  // Redraw whenever relevant state changes
  useEffect(() => {
    draw()
  }, [draw])

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const videoCoords = toVideo(cx, cy)
    if (videoCoords) {
      mouseRef.current = { display: { x: cx, y: cy }, video: videoCoords }
    } else {
      mouseRef.current = null
    }
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => draw())
  }

  const handleMouseLeave = () => {
    mouseRef.current = null
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => draw())
  }

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const videoCoords = toVideo(cx, cy)
    if (!videoCoords) return
    onVideoClick(videoCoords.x, videoCoords.y)
  }

  const cursor = stickyVis === 'out_of_frame' ? 'not-allowed' : 'crosshair'

  return (
    <div className="relative w-full h-full bg-black">
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-contain"
        muted
        preload="auto"
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ cursor }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      />
    </div>
  )
}
