import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { COURT_KEYPOINTS, COURT_LINES } from '../lib/courtKeypoints'
import { angleBetweenLines, applyH, invert3, lineIntersect } from '../lib/homographyDLT'
import type { Mat3 } from '../lib/homographyDLT'
import { drawLoupe } from '../lib/drawLoupe'
import type { CapturedFrame, CourtKeypoint, ImaginarySegments, ImgPoint, MarkedPoint } from '../types'

interface Props {
  frame: CapturedFrame
  points: MarkedPoint[]
  currentKeypoint: CourtKeypoint | null
  imaginaryMode: boolean
  onPointPlaced: (img: ImgPoint, imaginary?: ImaginarySegments) => void
  onPointMoved: (keypointId: string, img: ImgPoint) => void
  liveH?: Mat3 | null
}

type ImagPhase =
  | { step: 0 }
  | { step: 1; a1: ImgPoint }
  | { step: 2; a1: ImgPoint; a2: ImgPoint }
  | { step: 3; a1: ImgPoint; a2: ImgPoint; b1: ImgPoint }


const HIT_PX = 12
const TAP_THRESHOLD = 8  // px — above this movement distance a touch counts as drag, not tap

// ── Canvas helpers ────────────────────────────────────────────────────────────

function extendLineToBounds(
  p1: [number, number], p2: [number, number],
  W: number, H: number,
): [[number, number], [number, number]] | null {
  const dx = p2[0] - p1[0]
  const dy = p2[1] - p1[1]
  if (Math.abs(dx) < 1e-8 && Math.abs(dy) < 1e-8) return null

  let tMin = -1e9, tMax = 1e9

  if (Math.abs(dx) > 1e-8) {
    const t0 = -p1[0] / dx
    const t1 = (W - p1[0]) / dx
    tMin = Math.max(tMin, Math.min(t0, t1))
    tMax = Math.min(tMax, Math.max(t0, t1))
  } else if (p1[0] < 0 || p1[0] > W) {
    return null
  }

  if (Math.abs(dy) > 1e-8) {
    const t0 = -p1[1] / dy
    const t1 = (H - p1[1]) / dy
    tMin = Math.max(tMin, Math.min(t0, t1))
    tMax = Math.min(tMax, Math.max(t0, t1))
  } else if (p1[1] < 0 || p1[1] > H) {
    return null
  }

  if (tMin >= tMax) return null
  return [
    [p1[0] + tMin * dx, p1[1] + tMin * dy],
    [p1[0] + tMax * dx, p1[1] + tMax * dy],
  ]
}

function drawSegmentWithExtension(
  ctx: CanvasRenderingContext2D,
  p1: [number, number], p2: [number, number],
  W: number, H: number,
  color: string,
  lw: number,
) {
  const extended = extendLineToBounds(p1, p2, W, H)

  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = lw

  if (extended) {
    ctx.globalAlpha = 0.3
    ctx.setLineDash([10, 7])
    ctx.beginPath()
    ctx.moveTo(extended[0][0], extended[0][1])
    ctx.lineTo(extended[1][0], extended[1][1])
    ctx.stroke()
  }

  ctx.globalAlpha = 0.9
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(p1[0], p1[1])
  ctx.lineTo(p2[0], p2[1])
  ctx.stroke()

  ctx.globalAlpha = 1
  for (const p of [p1, p2]) {
    ctx.beginPath()
    ctx.arc(p[0], p[1], lw * 2, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
  }

  ctx.restore()
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AnnotationCanvas({
  frame, points, currentKeypoint, imaginaryMode, onPointPlaced, onPointMoved, liveH,
}: Props) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [loadedImg, setLoadedImg] = useState<HTMLImageElement | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [imagPhase, setImagPhase] = useState<ImagPhase>({ step: 0 })
  const [mousePos, setMousePos] = useState<ImgPoint | null>(null)

  // Refs used by the non-passive touchmove listener to avoid stale closures
  const dragIdRef = useRef<string | null>(null)
  const touchStartRef = useRef<{ clientX: number; clientY: number; id: number } | null>(null)
  const touchMoveHandlerRef = useRef<((e: TouchEvent) => void) | null>(null)

  useEffect(() => { dragIdRef.current = dragId }, [dragId])

  useEffect(() => {
    const img = new Image()
    img.onload = () => setLoadedImg(img)
    img.src = frame.dataUrl
    return () => { img.onload = null }
  }, [frame.dataUrl])

  useEffect(() => {
    if (!imaginaryMode) {
      setImagPhase({ step: 0 })
      setMousePos(null)
    }
  }, [imaginaryMode])

  // ── Draw ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !loadedImg) return
    const ctx = canvas.getContext('2d')!
    canvas.width  = frame.width
    canvas.height = frame.height
    ctx.drawImage(loadedImg, 0, 0)

    const W = frame.width
    const H = frame.height
    const displayWidth = canvas.getBoundingClientRect().width || W
    const scale = W / displayWidth
    const r = Math.max(8, 6 * scale)
    const lw = Math.max(1.5, 2.5 * scale)

    // Ghost crosshair for current point (normal mode only)
    if (currentKeypoint && !imaginaryMode) {
      ctx.strokeStyle = currentKeypoint.color
      ctx.globalAlpha = 0.25
      ctx.setLineDash([20, 12])
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, H / 2)
      ctx.lineTo(W, H / 2)
      ctx.moveTo(W / 2, 0)
      ctx.lineTo(W / 2, H)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }

    // Pass 1: segments for already-placed imaginary points
    for (const mp of points) {
      if (!mp.imaginary) continue
      const kp = COURT_KEYPOINTS.find(k => k.id === mp.keypointId)!
      const { segmentA, segmentB } = mp.imaginary
      drawSegmentWithExtension(ctx,
        [segmentA[0].u, segmentA[0].v], [segmentA[1].u, segmentA[1].v],
        W, H, kp.color, lw,
      )
      drawSegmentWithExtension(ctx,
        [segmentB[0].u, segmentB[0].v], [segmentB[1].u, segmentB[1].v],
        W, H, kp.color, lw,
      )
    }

    // Pass 2: dots for all placed points (drawn on top of segments)
    for (const mp of points) {
      const kp = COURT_KEYPOINTS.find(k => k.id === mp.keypointId)!
      const { u, v } = mp.img
      const isImaginary = !!mp.imaginary

      if (u < -r * 4 || u > W + r * 4 || v < -r * 4 || v > H + r * 4) continue

      ctx.save()
      ctx.beginPath()
      ctx.arc(u, v, r + 2, 0, Math.PI * 2)
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 2
      if (isImaginary) ctx.setLineDash([4, 3])
      ctx.stroke()
      ctx.setLineDash([])

      ctx.beginPath()
      ctx.arc(u, v, r, 0, Math.PI * 2)
      ctx.fillStyle = kp.color
      ctx.globalAlpha = isImaginary ? 0.75 : 1
      ctx.fill()
      ctx.globalAlpha = 1

      ctx.fillStyle = 'white'
      ctx.font = `bold ${Math.round(r * 1.4)}px monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(kp.id, u, v)
      ctx.restore()
    }

    // Pass 3: live court-line preview (when H is available)
    if (liveH) {
      const H_inv = invert3(liveH)
      if (H_inv) {
        ctx.save()
        ctx.lineWidth   = Math.max(1.5, W / 700)
        ctx.strokeStyle = 'rgba(74, 222, 128, 0.45)'
        ctx.shadowColor = 'rgba(74, 222, 128, 0.25)'
        ctx.shadowBlur  = 4
        for (const [[x1, y1], [x2, y2]] of COURT_LINES) {
          const [u1, v1] = applyH(H_inv, x1, y1)
          const [u2, v2] = applyH(H_inv, x2, y2)
          ctx.beginPath()
          ctx.moveTo(u1, v1)
          ctx.lineTo(u2, v2)
          ctx.stroke()
        }
        ctx.restore()
      }
    }

    // Pass 4: loupe — shown whenever there's an active position in placement or imaginary mode
    if ((currentKeypoint || imaginaryMode) && mousePos) {
      drawLoupe(ctx, mousePos, loadedImg, W, H, scale)
    }

    // Pass 5: in-progress imaginary selection overlay
    if (imaginaryMode && currentKeypoint) {
      const color = currentKeypoint.color

      if (imagPhase.step === 1 || imagPhase.step === 2 || imagPhase.step === 3) {
        const { a1 } = imagPhase
        ctx.beginPath()
        ctx.arc(a1.u, a1.v, lw * 2.5, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()

        if (imagPhase.step === 1 && mousePos) {
          ctx.save()
          ctx.strokeStyle = color
          ctx.lineWidth = lw
          ctx.globalAlpha = 0.45
          ctx.setLineDash([6, 4])
          ctx.beginPath()
          ctx.moveTo(a1.u, a1.v)
          ctx.lineTo(mousePos.u, mousePos.v)
          ctx.stroke()
          ctx.restore()
        }
      }

      if (imagPhase.step === 2 || imagPhase.step === 3) {
        const { a1, a2 } = imagPhase
        drawSegmentWithExtension(ctx, [a1.u, a1.v], [a2.u, a2.v], W, H, color, lw)
      }

      if (imagPhase.step === 3) {
        const { a1, a2, b1 } = imagPhase

        ctx.beginPath()
        ctx.arc(b1.u, b1.v, lw * 2.5, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()

        if (mousePos) {
          ctx.save()
          ctx.strokeStyle = color
          ctx.lineWidth = lw
          ctx.globalAlpha = 0.45
          ctx.setLineDash([6, 4])
          ctx.beginPath()
          ctx.moveTo(b1.u, b1.v)
          ctx.lineTo(mousePos.u, mousePos.v)
          ctx.stroke()
          ctx.restore()

          const inter = lineIntersect(
            [a1.u, a1.v], [a2.u, a2.v],
            [b1.u, b1.v], [mousePos.u, mousePos.v],
          )
          if (inter) {
            const iu = inter[0], iv = inter[1]
            if (iu > -r * 6 && iu < W + r * 6 && iv > -r * 6 && iv < H + r * 6) {
              ctx.save()
              ctx.globalAlpha = 0.55
              ctx.setLineDash([4, 3])
              ctx.beginPath()
              ctx.arc(iu, iv, r, 0, Math.PI * 2)
              ctx.strokeStyle = 'white'
              ctx.lineWidth = 2
              ctx.stroke()
              ctx.setLineDash([])
              ctx.beginPath()
              ctx.arc(iu, iv, r * 0.5, 0, Math.PI * 2)
              ctx.fillStyle = color
              ctx.fill()
              ctx.restore()
            }
          }
        }
      }
    }
  }, [loadedImg, points, currentKeypoint, frame, imaginaryMode, imagPhase, mousePos, liveH])

  // ── Coordinate helpers ──────────────────────────────────────────────────────

  const toFrameCoordsFromClient = (clientX: number, clientY: number): ImgPoint => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      u: (clientX - rect.left) * (frame.width  / rect.width),
      v: (clientY - rect.top)  * (frame.height / rect.height),
    }
  }

  const toFrameCoords = (e: React.MouseEvent): ImgPoint =>
    toFrameCoordsFromClient(e.clientX, e.clientY)

  const findNear = (clientX: number, clientY: number): string | null => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const scaleX = rect.width  / frame.width
    const scaleY = rect.height / frame.height
    for (const mp of points) {
      const dx = mp.img.u * scaleX - (clientX - rect.left)
      const dy = mp.img.v * scaleY - (clientY - rect.top)
      if (Math.sqrt(dx * dx + dy * dy) < HIT_PX) return mp.keypointId
    }
    return null
  }

  // ── Shared placement logic (mouse + touch) ──────────────────────────────────

  const handlePlacement = (pt: ImgPoint) => {
    if (imaginaryMode) {
      if (imagPhase.step === 0) {
        setImagPhase({ step: 1, a1: pt })
      } else if (imagPhase.step === 1) {
        setImagPhase({ step: 2, a1: imagPhase.a1, a2: pt })
      } else if (imagPhase.step === 2) {
        setImagPhase({ step: 3, a1: imagPhase.a1, a2: imagPhase.a2, b1: pt })
      } else if (imagPhase.step === 3) {
        const { a1, a2, b1 } = imagPhase
        const inter = lineIntersect(
          [a1.u, a1.v], [a2.u, a2.v],
          [b1.u, b1.v], [pt.u, pt.v],
        )
        if (inter) {
          onPointPlaced(
            { u: inter[0], v: inter[1] },
            { segmentA: [a1, a2], segmentB: [b1, pt] },
          )
        } else {
          setImagPhase({ step: 0 })
        }
      }
      return
    }
    if (currentKeypoint) onPointPlaced(pt)
  }

  // ── Mouse handlers ──────────────────────────────────────────────────────────

  const onMouseDown = (e: React.MouseEvent) => {
    const hit = findNear(e.clientX, e.clientY)
    if (hit) {
      setDragId(hit)
    } else {
      handlePlacement(toFrameCoords(e))
    }
  }

  const onMouseMove = (e: React.MouseEvent) => {
    const pt = toFrameCoords(e)
    if (dragId) onPointMoved(dragId, pt)
    setMousePos(pt)
  }

  const onMouseUp = () => setDragId(null)

  const onMouseLeave = () => {
    setDragId(null)
    setMousePos(null)
  }

  // ── Touch handlers ──────────────────────────────────────────────────────────

  const onTouchStart = (e: React.TouchEvent) => {
    const touch = e.changedTouches[0]
    touchStartRef.current = { clientX: touch.clientX, clientY: touch.clientY, id: touch.identifier }
    setMousePos(toFrameCoordsFromClient(touch.clientX, touch.clientY))
    const hit = findNear(touch.clientX, touch.clientY)
    if (hit) setDragId(hit)
  }

  const onTouchEnd = (e: React.TouchEvent) => {
    const touch = e.changedTouches[0]
    const start = touchStartRef.current
    if (start && !dragIdRef.current) {
      const dx = touch.clientX - start.clientX
      const dy = touch.clientY - start.clientY
      if (Math.sqrt(dx * dx + dy * dy) < TAP_THRESHOLD) {
        handlePlacement(toFrameCoordsFromClient(touch.clientX, touch.clientY))
      }
    }
    setDragId(null)
    setMousePos(null)
    touchStartRef.current = null
  }

  // touchmove must be non-passive to call preventDefault and suppress page scroll.
  // React JSX handlers are passive by default, so we register manually.
  // A stable wrapper calls touchMoveHandlerRef.current so the effect runs only once.
  touchMoveHandlerRef.current = (e: TouchEvent) => {
    const start = touchStartRef.current
    if (!start) return
    const touch = [...e.changedTouches].find(t => t.identifier === start.id)
    if (!touch) return
    e.preventDefault()
    const pt = toFrameCoordsFromClient(touch.clientX, touch.clientY)
    setMousePos(pt)
    if (dragIdRef.current) onPointMoved(dragIdRef.current, pt)
  }

  useEffect(() => {
    const canvas = canvasRef.current!
    const handler = (e: TouchEvent) => touchMoveHandlerRef.current?.(e)
    canvas.addEventListener('touchmove', handler, { passive: false })
    return () => canvas.removeEventListener('touchmove', handler)
  }, [])

  // ── Derived state ───────────────────────────────────────────────────────────

  const angleWarning = imagPhase.step === 3 && mousePos
    ? angleBetweenLines(
        [imagPhase.a1.u, imagPhase.a1.v], [imagPhase.a2.u, imagPhase.a2.v],
        [imagPhase.b1.u, imagPhase.b1.v], [mousePos.u, mousePos.v],
      ) < 10
    : false

  const cursor = dragId ? 'grabbing' : (imaginaryMode || currentKeypoint) ? 'crosshair' : 'default'

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        className="w-full rounded-xl bg-black"
        style={{ cursor, imageRendering: 'auto' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      />
      {imaginaryMode && (
        <div className="absolute inset-x-4 bottom-3 flex flex-col items-center gap-1.5 pointer-events-none">
          <span className="bg-slate-900/85 text-slate-100 text-xs px-3 py-1.5 rounded-full backdrop-blur-sm border border-slate-700/50">
            {t(`annotationCanvas.phase${imagPhase.step}` as const)}
          </span>
          {angleWarning && (
            <span className="bg-amber-950/90 text-amber-300 text-xs px-3 py-1 rounded-full border border-amber-700/50">
              {t('annotationCanvas.parallelWarning')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
