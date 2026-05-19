import { useEffect, useRef } from 'react'
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
  if (record.play_state === 'dead' && record.visibility === 'occluded') return '#7f1d1d'
  if (record.play_state === 'in_play' && record.visibility === 'visible') return '#16a34a'
  if (record.play_state === 'in_play' && record.visibility === 'occluded') return '#d97706'
  return '#1e293b'
}

export default function Timeline({ frameCount, labels, currentFrame, onSeek }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || frameCount === 0) return

    const dpr = window.devicePixelRatio || 1
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr
      canvas.height = ch * dpr
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, cw, ch)

    // Draw frame blocks
    const pxPerFrame = cw / frameCount
    for (let f = 0; f < frameCount; f++) {
      const x = (f / frameCount) * cw
      const w = Math.max(1, pxPerFrame)
      ctx.fillStyle = frameColor(labels.get(f))
      ctx.fillRect(x, 0, w, ch)
    }

    // Impact markers — bright tick at the top of each impact frame
    for (const [f, rec] of labels) {
      if (!rec.impact) continue
      const IMPACT_COLORS: Record<string, string> = {
        floor: '#f97316', racket: '#22c55e', wall: '#22d3ee',
        fence: '#ef4444', net: '#94a3b8',
      }
      const x = (f / frameCount) * cw
      const w = Math.max(2, pxPerFrame)
      ctx.fillStyle = IMPACT_COLORS[rec.impact] ?? '#facc15'
      ctx.fillRect(x, 0, w, 4)
    }

    // Current frame indicator
    const curX = (currentFrame / frameCount) * cw
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(curX - 1, 0, 2, ch)

    ctx.restore()
  }, [labels, currentFrame, frameCount])

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || frameCount === 0) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const frame = Math.max(0, Math.min(frameCount - 1, Math.round((x / rect.width) * frameCount)))
    onSeek(frame)
  }

  const handleRangeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSeek(parseInt(e.target.value, 10))
  }

  return (
    <div className="flex flex-col gap-1 px-2 py-1">
      <canvas
        ref={canvasRef}
        className="w-full h-8 rounded cursor-pointer"
        onClick={handleClick}
      />
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
