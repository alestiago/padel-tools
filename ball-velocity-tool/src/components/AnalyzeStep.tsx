import { useEffect, useRef, useState } from 'react'
import type { AnalysisConfig, FrameResult, HomographyJson } from '../types.ts'
import { applyH } from '../lib/applyH.ts'
import { detectBall } from '../lib/blobDetector.ts'
import { computeVelocities } from '../lib/velocityCalc.ts'

interface Props {
  videoFile: File
  homography: HomographyJson
  onDone: (results: FrameResult[], config: AnalysisConfig) => void
  onBack: () => void
}

// Analysis canvas resolution — small for fast pixel ops
const ANALYSIS_W = 640
const ANALYSIS_H = 360

type Phase = 'config' | 'processing' | 'done'

export default function AnalyzeStep({ videoFile, homography, onDone, onBack }: Props) {
  const [phase, setPhase]       = useState<Phase>('config')
  const [videoFps, setVideoFps] = useState(30)
  const [frameStep, setFrameStep] = useState(2)
  const [progress, setProgress] = useState(0)
  const [frameCount, setFrameCount] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const abortRef = useRef(false)
  const analysisCanvas = useRef<HTMLCanvasElement | null>(null)

  const effectiveAnalysisFps = (videoFps / frameStep).toFixed(1)

  useEffect(() => {
    if (phase !== 'processing') return

    abortRef.current = false
    void runAnalysis()

    return () => { abortRef.current = true }
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps

  async function runAnalysis() {
    const videoUrl = URL.createObjectURL(videoFile)
    const video = document.createElement('video')
    video.src = videoUrl
    video.muted = true
    video.preload = 'auto'

    await new Promise<void>(resolve =>
      video.addEventListener('loadedmetadata', () => resolve(), { once: true })
    )

    const duration = video.duration
    const total = Math.ceil(duration * videoFps / frameStep)
    setTotalFrames(total)

    const canvas = analysisCanvas.current ?? document.createElement('canvas')
    canvas.width  = ANALYSIS_W
    canvas.height = ANALYSIS_H
    analysisCanvas.current = canvas
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!

    const H = homography.H
    const scaleX = homography.frame_size.width  / ANALYSIS_W
    const scaleY = homography.frame_size.height / ANALYSIS_H

    const raw: FrameResult[] = []

    for (let i = 0; i <= total; i++) {
      if (abortRef.current) break

      const t = i * frameStep / videoFps
      video.currentTime = t
      await new Promise<void>(resolve =>
        video.addEventListener('seeked', () => resolve(), { once: true })
      )

      ctx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H)
      const imageData = ctx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H)
      const blob = detectBall(imageData)

      let ball: FrameResult['ball'] = null
      if (blob) {
        const u = blob.u * scaleX
        const v = blob.v * scaleY
        const [x, y] = applyH(H, u, v)
        // Only accept if within court bounds (10 m × 20 m) + small margin
        if (x >= -1 && x <= 11 && y >= -1 && y <= 21) {
          ball = { u, v, x, y }
        }
      }

      raw.push({ frameIndex: i, timeS: t, ball, rawVelocityKmh: null, velocityKmh: null })

      setFrameCount(i + 1)
      setProgress((i + 1) / total)

      if (i % 15 === 0) {
        setPreviewUrl(canvas.toDataURL('image/jpeg', 0.5))
        // Yield to browser so UI can repaint
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }

    URL.revokeObjectURL(videoUrl)

    const results = computeVelocities(raw, frameStep, videoFps)
    setPhase('done')
    onDone(results, { videoFps, frameStep })
  }

  // ── Config screen ──────────────────────────────────────────────────────────

  if (phase === 'config') {
    return (
      <div className="mt-8 max-w-xl mx-auto space-y-8">
        <div className="bg-slate-800/60 rounded-2xl p-6 space-y-6">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">Analysis settings</h2>

          <Field label="Video frame rate">
            <RadioGroup
              options={[24, 25, 30, 50, 60]}
              value={videoFps}
              onChange={setVideoFps}
              label={v => `${v} fps`}
            />
          </Field>

          <Field label="Analyse every N frames">
            <RadioGroup
              options={[1, 2, 3, 5]}
              value={frameStep}
              onChange={setFrameStep}
              label={v => `${v}`}
            />
            <p className="text-xs text-slate-500 mt-2">
              Effective analysis rate: <span className="text-slate-300">{effectiveAnalysisFps} fps</span>
            </p>
          </Field>
        </div>

        <div className="flex gap-3 justify-end">
          <button
            onClick={onBack}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
          >
            ← Back
          </button>
          <button
            onClick={() => setPhase('processing')}
            className="px-6 py-2.5 rounded-xl font-medium text-sm bg-green-500 hover:bg-green-400 text-slate-900 transition-colors cursor-pointer"
          >
            Start analysis
          </button>
        </div>
      </div>
    )
  }

  // ── Processing screen ──────────────────────────────────────────────────────

  return (
    <div className="mt-8 max-w-2xl mx-auto space-y-6">
      <div className="bg-slate-800/60 rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-300">
            {phase === 'done' ? 'Analysis complete' : 'Analysing…'}
          </p>
          <p className="text-xs text-slate-500">
            Frame {frameCount} / {totalFrames}
          </p>
        </div>

        <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-green-500 rounded-full transition-all duration-100"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>

        <p className="text-xs text-slate-500">{Math.round(progress * 100)}%</p>
      </div>

      {previewUrl && (
        <div className="rounded-xl overflow-hidden border border-slate-700">
          <img src={previewUrl} alt="Current frame" className="w-full" />
        </div>
      )}
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</label>
      {children}
    </div>
  )
}

function RadioGroup<T extends number>({
  options, value, onChange, label,
}: {
  options: T[]
  value: T
  onChange: (v: T) => void
  label: (v: T) => string
}) {
  return (
    <div className="flex gap-2 flex-wrap">
      {options.map(opt => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={[
            'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer',
            opt === value
              ? 'bg-green-500 text-slate-900'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600',
          ].join(' ')}
        >
          {label(opt)}
        </button>
      ))}
    </div>
  )
}
