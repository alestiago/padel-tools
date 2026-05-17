import { useEffect, useRef, useState } from 'react'
import type { AnalysisConfig, FrameResult, HomographyJson } from '../types.ts'
import { findNearestResult } from '../lib/velocityCalc.ts'

interface Props {
  videoFile: File
  homography: HomographyJson
  results: FrameResult[]
  config: AnalysisConfig
  onBack: () => void
}

const TRAIL_LENGTH = 8

export default function ResultsStep({ videoFile, homography, results, config, onBack }: Props) {
  const videoRef    = useRef<HTMLVideoElement>(null)
  const overlayRef  = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef      = useRef<number>(0)
  const [videoUrl]  = useState(() => URL.createObjectURL(videoFile))

  // Stats derived from results
  const detections   = results.filter(r => r.ball !== null)
  const velocities   = results.map(r => r.velocityKmh).filter((v): v is number => v !== null)
  const maxVelocity  = velocities.length > 0 ? Math.max(...velocities) : null
  const avgVelocity  = velocities.length > 0
    ? velocities.reduce((a, b) => a + b, 0) / velocities.length
    : null
  const detectionRate = results.length > 0
    ? ((detections.length / results.length) * 100).toFixed(1)
    : '0'

  // Keep overlay canvas size in sync with video display size
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => {
      const canvas = overlayRef.current
      if (!canvas) return
      canvas.width  = container.clientWidth
      canvas.height = container.clientHeight
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // rAF overlay loop
  useEffect(() => {
    const video   = videoRef.current
    const canvas  = overlayRef.current
    if (!video || !canvas) return

    const vw = homography.frame_size.width
    const vh = homography.frame_size.height
    const dt = config.frameStep / config.videoFps

    function draw() {
      const ctx = canvas!.getContext('2d')
      if (!ctx) return

      ctx.clearRect(0, 0, canvas!.width, canvas!.height)

      const t = video!.currentTime
      const nearest = findNearestResult(results, t)
      if (!nearest) return

      const scaleX = canvas!.width  / vw
      const scaleY = canvas!.height / vh

      // Draw fading trail
      for (let j = 1; j <= TRAIL_LENGTH; j++) {
        const past = findNearestResult(results, t - j * dt)
        if (!past?.ball) continue
        const alpha = (1 - j / TRAIL_LENGTH) * 0.45
        ctx.beginPath()
        ctx.arc(past.ball.u * scaleX, past.ball.v * scaleY, 8, 0, 2 * Math.PI)
        ctx.strokeStyle = `rgba(34,197,94,${alpha})`
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      // Draw current ball
      if (nearest.ball) {
        const cx = nearest.ball.u * scaleX
        const cy = nearest.ball.v * scaleY

        ctx.beginPath()
        ctx.arc(cx, cy, 14, 0, 2 * Math.PI)
        ctx.strokeStyle = '#22c55e'
        ctx.lineWidth = 2.5
        ctx.stroke()

        ctx.beginPath()
        ctx.arc(cx, cy, 3, 0, 2 * Math.PI)
        ctx.fillStyle = '#22c55e'
        ctx.fill()

        if (nearest.velocityKmh != null) {
          const label = `${Math.round(nearest.velocityKmh)} km/h`
          ctx.font = 'bold 14px system-ui'
          const textX = cx + 20
          const textY = cy - 8

          // Background pill
          const metrics = ctx.measureText(label)
          ctx.fillStyle = 'rgba(0,0,0,0.55)'
          ctx.beginPath()
          ctx.roundRect(textX - 4, textY - 14, metrics.width + 8, 20, 4)
          ctx.fill()

          ctx.fillStyle = '#86efac'
          ctx.fillText(label, textX, textY)
        }
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [results, config, homography]) // eslint-disable-line react-hooks/exhaustive-deps

  // Revoke blob URL on unmount
  useEffect(() => () => URL.revokeObjectURL(videoUrl), [videoUrl])

  function exportCsv() {
    const header = 'frame_index,time_s,ball_u_px,ball_v_px,ball_x_m,ball_y_m,raw_velocity_kmh,velocity_kmh\n'
    const rows = results.map(r =>
      [
        r.frameIndex,
        r.timeS.toFixed(4),
        r.ball?.u.toFixed(1) ?? '',
        r.ball?.v.toFixed(1) ?? '',
        r.ball?.x.toFixed(3) ?? '',
        r.ball?.y.toFixed(3) ?? '',
        r.rawVelocityKmh?.toFixed(1) ?? '',
        r.velocityKmh?.toFixed(1) ?? '',
      ].join(',')
    ).join('\n')

    const blob = new Blob([header + rows], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `ball_velocity_${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="mt-6 space-y-5">
      {/* Video + overlay */}
      <div
        ref={containerRef}
        className="relative rounded-xl overflow-hidden border border-slate-700 bg-black"
        style={{ aspectRatio: `${homography.frame_size.width}/${homography.frame_size.height}` }}
      >
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          className="w-full h-full object-contain"
        />
        <canvas
          ref={overlayRef}
          className="absolute inset-0 pointer-events-none"
        />
      </div>

      {/* Stats + actions */}
      <div className="grid grid-cols-2 gap-4">
        {/* Stats */}
        <div className="bg-slate-800/60 rounded-2xl p-5 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Statistics</h2>
          <StatRow label="Max velocity"        value={maxVelocity  != null ? `${maxVelocity.toFixed(0)} km/h`  : '—'} highlight />
          <StatRow label="Avg velocity"        value={avgVelocity  != null ? `${avgVelocity.toFixed(0)} km/h`  : '—'} />
          <StatRow label="Frames with ball"    value={`${detections.length} / ${results.length} (${detectionRate}%)`} />
          <StatRow label="Analysis rate"       value={`${(config.videoFps / config.frameStep).toFixed(0)} fps`} />
          <StatRow label="Reprojection error"  value={`${(homography.reprojection_error_m * 100).toFixed(1)} cm`} />
        </div>

        {/* Actions */}
        <div className="bg-slate-800/60 rounded-2xl p-5 flex flex-col gap-3 justify-center">
          <button
            onClick={exportCsv}
            className="px-4 py-2.5 rounded-xl bg-green-500 hover:bg-green-400 text-slate-900 font-medium text-sm transition-colors cursor-pointer text-center"
          >
            ↓ Export CSV
          </button>
          <button
            onClick={onBack}
            className="px-4 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-300 font-medium text-sm transition-colors cursor-pointer text-center"
          >
            ← Change settings
          </button>
        </div>
      </div>
    </div>
  )
}

function StatRow({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-xs text-slate-400">{label}</span>
      <span className={`text-sm font-semibold ${highlight ? 'text-green-400' : 'text-slate-200'}`}>
        {value}
      </span>
    </div>
  )
}
