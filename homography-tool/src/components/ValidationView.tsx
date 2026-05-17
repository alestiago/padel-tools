import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { COURT_KEYPOINTS, COURT_LINES } from '../lib/courtKeypoints'
import { applyH, invert3 } from '../lib/homographyDLT'
import type { CapturedFrame, HomographyResult, MarkedPoint } from '../types'

interface Props {
  frame: CapturedFrame
  points: MarkedPoint[]
  result: HomographyResult
  onBack: () => void
}

function ErrorBadge({ errM }: { errM: number }) {
  const { t } = useTranslation()
  const cm = (errM * 100).toFixed(1)
  if (errM < 0.05) return <span className="text-green-400 font-semibold">{t('validationView.qualityExcellent', { cm })}</span>
  if (errM < 0.15) return <span className="text-amber-400 font-semibold">{t('validationView.qualityAcceptable', { cm })}</span>
  return <span className="text-red-400 font-semibold">{t('validationView.qualityPoor', { cm })}</span>
}

export default function ValidationView({ frame, points, result, onBack }: Props) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [exported, setExported] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    canvas.width  = frame.width
    canvas.height = frame.height

    const H_inv = invert3(result.H)
    const img = new Image()
    img.onload = () => {
      ctx.drawImage(img, 0, 0)

      if (H_inv) {
        ctx.lineWidth   = Math.max(2, frame.width / 500)
        ctx.strokeStyle = 'rgba(74, 222, 128, 0.85)'
        ctx.shadowColor = 'rgba(74, 222, 128, 0.4)'
        ctx.shadowBlur  = 6
        for (const [[x1, y1], [x2, y2]] of COURT_LINES) {
          const [u1, v1] = applyH(H_inv, x1, y1)
          const [u2, v2] = applyH(H_inv, x2, y2)
          ctx.beginPath()
          ctx.moveTo(u1, v1)
          ctx.lineTo(u2, v2)
          ctx.stroke()
        }
        ctx.shadowBlur = 0
      }

      const r = Math.max(10, frame.width / 120)
      for (const mp of points) {
        const kp = COURT_KEYPOINTS.find(k => k.id === mp.keypointId)!
        const { u, v } = mp.img
        ctx.beginPath()
        ctx.arc(u, v, r + 2, 0, Math.PI * 2)
        ctx.strokeStyle = 'white'
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(u, v, r, 0, Math.PI * 2)
        ctx.fillStyle = kp.color
        ctx.fill()
        ctx.fillStyle = 'white'
        ctx.font = `bold ${Math.round(r * 1.3)}px monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(kp.id, u, v)
      }
    }
    img.src = frame.dataUrl
  }, [frame, points, result])

  const exportJson = () => {
    const payload = {
      version: 1,
      timestamp: new Date().toISOString(),
      video_file: frame.videoFileName,
      frame_timestamp_s: frame.timestampS,
      frame_size: { width: frame.width, height: frame.height },
      H: result.H,
      reprojection_error_m: result.reprojectionErrorM,
      keypoints: points.map(mp => {
        const kp = COURT_KEYPOINTS.find(k => k.id === mp.keypointId)!
        const entry: {
          id: string
          img: number[]
          real: number[]
          imaginary?: boolean
          segments?: { a: number[][]; b: number[][] }
        } = { id: mp.keypointId, img: [mp.img.u, mp.img.v], real: [kp.real.x, kp.real.y] }
        if (mp.imaginary) {
          entry.imaginary = true
          entry.segments = {
            a: [
              [mp.imaginary.segmentA[0].u, mp.imaginary.segmentA[0].v],
              [mp.imaginary.segmentA[1].u, mp.imaginary.segmentA[1].v],
            ],
            b: [
              [mp.imaginary.segmentB[0].u, mp.imaginary.segmentB[0].v],
              [mp.imaginary.segmentB[1].u, mp.imaginary.segmentB[1].v],
            ],
          }
        }
        return entry
      }),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `homography_${frame.videoFileName.replace(/\.[^.]+$/, '')}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    setExported(true)
  }

  const errM = result.reprojectionErrorM
  const feedback = errM < 0.05
    ? t('validationView.feedbackExcellent')
    : errM < 0.15
    ? t('validationView.feedbackAcceptable')
    : t('validationView.feedbackPoor')

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-4 items-start">
        {/* Overlay canvas */}
        <div className="space-y-2">
          <canvas
            ref={canvasRef}
            className="w-full rounded-xl bg-black"
            style={{ imageRendering: 'auto' }}
          />
          <p className="text-xs text-slate-500">{t('validationView.overlayHint')}</p>
        </div>

        {/* Stats + export */}
        <div className="bg-slate-800 rounded-xl p-5 space-y-5">
          <div>
            <p className="text-xs text-slate-400 font-medium mb-1">{t('validationView.reprojLabel')}</p>
            <ErrorBadge errM={result.reprojectionErrorM} />
            <p className="text-xs text-slate-500 mt-1">{feedback}</p>
          </div>

          <div>
            <p className="text-xs text-slate-400 font-medium mb-2">{t('validationView.pointsUsed')}</p>
            <div className="space-y-1">
              {points.map(mp => {
                const kp = COURT_KEYPOINTS.find(k => k.id === mp.keypointId)!
                return (
                  <div key={mp.keypointId} className="flex items-center gap-2 text-xs">
                    <span
                      className="w-3 h-3 rounded-full shrink-0 border"
                      style={{
                        backgroundColor: mp.imaginary ? 'transparent' : kp.color,
                        borderColor: kp.color,
                        borderStyle: mp.imaginary ? 'dashed' : 'solid',
                      }}
                    />
                    <span className="font-mono font-bold" style={{ color: kp.color }}>{kp.id}</span>
                    <span className="text-slate-400 truncate">{t(kp.labelKey)}</span>
                    {mp.imaginary && <span className="ml-auto text-slate-500 shrink-0">✦</span>}
                  </div>
                )
              })}
            </div>
          </div>

          <div>
            <p className="text-xs text-slate-400 font-medium mb-1">{t('validationView.matrixLabel')}</p>
            <pre className="text-[10px] text-slate-300 bg-slate-900 rounded p-2 leading-relaxed overflow-auto">
              {result.H.map(row => row.map(v => v.toFixed(6)).join('  ')).join('\n')}
            </pre>
          </div>

          <button
            onClick={exportJson}
            className="w-full py-2.5 rounded-lg bg-green-500 hover:bg-green-400 text-slate-900 font-semibold text-sm transition-colors"
          >
            {exported ? t('validationView.exportDone') : t('validationView.export')}
          </button>
        </div>
      </div>

      <button
        onClick={onBack}
        className="text-sm text-slate-500 hover:text-slate-300 transition-colors"
      >
        {t('validationView.back')}
      </button>
    </div>
  )
}
