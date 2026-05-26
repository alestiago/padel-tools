import { useCallback, useEffect, useRef, useState } from 'react'
import type { LabelRecord } from '../types.ts'

interface Props {
  frameCount: number
  labels: Map<number, LabelRecord>
  currentFrame: number
  onSeek: (frame: number) => void
}

function frameColor(record: LabelRecord | undefined): string {
  if (!record) return '#1e293b'
  if (record.visibility === 'out_of_frame') return '#475569'
  if (record.play_state === 'dead' && record.visibility === 'visible') return '#dc2626'
  if (record.play_state === 'dead' && record.visibility === 'motion_blur') return '#9f1239'
  if (record.play_state === 'dead' && record.visibility === 'occluded') return '#7f1d1d'
  if (record.play_state === 'in_play' && record.visibility === 'visible') return '#16a34a'
  if (record.play_state === 'in_play' && record.visibility === 'motion_blur') return '#0e7490'
  if (record.play_state === 'in_play' && record.visibility === 'occluded') return '#d97706'
  if (record.play_state === 'dead') return '#7f1d1d'
  if (record.play_state === 'in_play') return '#14532d'
  return '#1e293b'
}

const IMPACT_COLORS: Record<string, string> = {
  floor: '#f97316', racket: '#22c55e', wall: '#22d3ee',
  fence: '#ef4444', net: '#94a3b8',
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

export default function Timeline({ frameCount, labels, currentFrame, onSeek }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [showSlider, setShowSlider] = useState(false)

  const clampOffset = useCallback((offset: number, z: number) => {
    if (frameCount === 0) return 0
    return clamp(offset, 0, Math.max(0, frameCount - frameCount / z))
  }, [frameCount])

  // Auto-scroll to keep currentFrame in view when navigating
  useEffect(() => {
    if (zoom <= 1 || frameCount === 0) return
    const visibleFrames = frameCount / zoom
    setScrollOffset(prev => {
      const start = clamp(prev, 0, frameCount - visibleFrames)
      if (currentFrame >= start && currentFrame < start + visibleFrames) return prev
      return clamp(currentFrame - visibleFrames / 2, 0, frameCount - visibleFrames)
    })
  }, [currentFrame, zoom, frameCount])

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || frameCount === 0) return

    const dpr = window.devicePixelRatio || 1
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight
    if (cw === 0 || ch === 0) return
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr
      canvas.height = ch * dpr
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, cw, ch)

    const visibleFrames = frameCount / zoom
    const startFrame = clampOffset(scrollOffset, zoom)
    const pxPerFrame = cw / visibleFrames
    const firstVisible = Math.max(0, Math.floor(startFrame))
    const lastVisible = Math.min(frameCount - 1, Math.ceil(startFrame + visibleFrames))

    for (let f = firstVisible; f <= lastVisible; f++) {
      const x = (f - startFrame) * pxPerFrame
      ctx.fillStyle = frameColor(labels.get(f))
      ctx.fillRect(x, 0, Math.max(1, pxPerFrame), ch)
    }

    for (const [f, rec] of labels) {
      if (!rec.impact) continue
      const x = (f - startFrame) * pxPerFrame
      if (x + pxPerFrame < 0 || x > cw) continue
      ctx.fillStyle = IMPACT_COLORS[rec.impact] ?? '#facc15'
      ctx.fillRect(x, 0, Math.max(2, pxPerFrame), 4)
    }

    const curX = (currentFrame - startFrame) * pxPerFrame
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(curX - 1, 0, 2, ch)

    ctx.restore()
  }, [labels, currentFrame, frameCount, zoom, scrollOffset, clampOffset])

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || frameCount === 0) return
    const rect = canvas.getBoundingClientRect()
    const relX = e.clientX - rect.left
    const visibleFrames = frameCount / zoom
    const startFrame = clampOffset(scrollOffset, zoom)
    onSeek(clamp(Math.round(startFrame + (relX / rect.width) * visibleFrames), 0, frameCount - 1))
  }

  const handleRangeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSeek(parseInt(e.target.value, 10))
  }

  const handleZoomSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newZoom = Number(e.target.value)
    setZoom(newZoom)
    if (newZoom === 1) setScrollOffset(0)
  }

  const resetZoom = () => {
    setZoom(1)
    setScrollOffset(0)
  }

  const zoomLabel = zoom >= 10 ? `${zoom.toFixed(0)}×` : `${zoom.toFixed(1)}×`

  return (
    <div className="flex flex-col gap-1 px-2 py-1">
      <canvas
        ref={canvasRef}
        className="w-full h-12 rounded cursor-pointer"
        onClick={handleClick}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => setShowSlider(v => !v)}
          title="Toggle zoom slider"
          className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 transition-colors ${
            showSlider
              ? 'bg-slate-500 text-white'
              : 'bg-slate-700 text-slate-400 hover:text-slate-200'
          }`}
        >
          {zoomLabel}
        </button>
        {showSlider && (
          <input
            type="range"
            min={1}
            max={50}
            step={1}
            value={Math.round(zoom)}
            onChange={handleZoomSlider}
            className="flex-1 accent-slate-400 h-1"
          />
        )}
        <button
          onClick={resetZoom}
          title="Reset zoom"
          className={`ml-auto text-xs px-1.5 py-0.5 rounded shrink-0 transition-colors ${
            zoom > 1
              ? 'text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600'
              : 'text-slate-600 bg-slate-800 cursor-default'
          }`}
        >
          ↺
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(0, frameCount - 1)}
        value={currentFrame}
        onChange={handleRangeChange}
        className="w-full accent-blue-400 h-1"
      />
    </div>
  )
}
