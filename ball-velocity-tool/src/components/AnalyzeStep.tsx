import { useEffect, useRef, useState } from 'react'
import type { AnalysisConfig, FrameResult, HomographyJson } from '../types.ts'
import { applyH } from '../lib/applyH.ts'
import { computeVelocities } from '../lib/velocityCalc.ts'
import TrackNetWorker from '../workers/tracknetWorker.ts?worker'

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
type ModelStatus = 'loading' | 'warming' | 'ready' | 'error'

export default function AnalyzeStep({ videoFile, homography, onDone, onBack }: Props) {
  const [phase, setPhase]       = useState<Phase>('config')
  const [videoFps, setVideoFps] = useState(30)
  const [frameStep, setFrameStep] = useState(2)
  const [threshold, setThreshold] = useState(0.5)
  const [progress, setProgress] = useState(0)
  const [frameCount, setFrameCount] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [modelStatus, setModelStatus] = useState<ModelStatus>('loading')
  const [modelError, setModelError]   = useState<string | null>(null)
  const [eta, setEta]               = useState<string | null>(null)

  const abortRef        = useRef(false)
  const workerRef       = useRef<Worker | null>(null)
  const analysisCanvas  = useRef<HTMLCanvasElement | null>(null)
  const startTimeRef    = useRef<number>(0)

  const effectiveAnalysisFps = (videoFps / frameStep).toFixed(1)

  // Load model worker once on mount
  useEffect(() => {
    const worker = new TrackNetWorker()
    workerRef.current = worker
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'warming') setModelStatus('warming')
      if (e.data.type === 'ready')   setModelStatus('ready')
      if (e.data.type === 'error') {
        setModelStatus('error')
        setModelError(e.data.message as string)
      }
    }
    worker.postMessage({ type: 'init' })
    return () => worker.terminate()
  }, [])

  useEffect(() => {
    if (phase !== 'processing') return
    abortRef.current = false
    startTimeRef.current = performance.now()
    void runAnalysis()
    return () => { abortRef.current = true }
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps

  function inferBall(frames: Uint8ClampedArray[]): Promise<{ u: number; v: number } | null> {
    return new Promise((resolve) => {
      const worker = workerRef.current!
      worker.onmessage = (e: MessageEvent) => {
        if (e.data.type === 'result') resolve(e.data.ball as { u: number; v: number } | null)
      }
      worker.postMessage({ type: 'infer', frames, w: ANALYSIS_W, h: ANALYSIS_H, threshold })
    })
  }

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
    const total    = Math.ceil(duration * videoFps / frameStep)
    setTotalFrames(total)

    const canvas = analysisCanvas.current ?? document.createElement('canvas')
    canvas.width  = ANALYSIS_W
    canvas.height = ANALYSIS_H
    analysisCanvas.current = canvas
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!

    const H      = homography.H
    const scaleX = homography.frame_size.width  / ANALYSIS_W
    const scaleY = homography.frame_size.height / ANALYSIS_H

    const raw      = [] as FrameResult[]
    const frameBuf = [] as Uint8ClampedArray[]

    // Shared progress/ETA updater used by both paths.
    function updateProgress(done: number) {
      setFrameCount(done)
      setProgress(done / total)
      if (done > 0 && done % 5 === 0) {
        const elapsed    = (performance.now() - startTimeRef.current) / 1000
        const remaining  = (elapsed / done) * (total - done)
        setEta(remaining > 60
          ? `${Math.ceil(remaining / 60)} min left`
          : `${Math.ceil(remaining)} s left`)
      }
    }

    // Shared detection handler used by both paths.
    function resolveBall(detection: { u: number; v: number } | null): FrameResult['ball'] {
      if (!detection) return null
      const u = detection.u * scaleX
      const v = detection.v * scaleY
      const [x, y] = applyH(H, u, v)
      return (x >= -1 && x <= 11 && y >= -1 && y <= 21) ? { u, v, x, y } : null
    }

    // ── Fast path: requestVideoFrameCallback ────────────────────────────────
    // Play the video at 4× speed. rVFC fires once per decoded frame, handing us
    // pixel data without any per-frame seeking. A small queue with backpressure
    // (pause/resume) keeps memory bounded while inference catches up.
    // Falls back to the seeking path on browsers that lack rVFC (Firefox).

    if ('requestVideoFrameCallback' in video) {
      type QEntry = { idx: number; timeS: number; pixels: Uint8ClampedArray }
      const QUEUE_MAX = 6
      const q: QEntry[] = []
      let captureFinished = false
      let wakeInference: (() => void) | null = null

      let lastVF   = -Infinity
      let captureCount = 0

      function pump() {
        video.requestVideoFrameCallback((_, meta: { mediaTime: number }) => {
          if (abortRef.current) { captureFinished = true; wakeInference?.(); return }
          const vf = Math.round(meta.mediaTime * videoFps)
          if (vf >= lastVF + frameStep) {
            ctx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H)
            const pixels = ctx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H).data.slice() as unknown as Uint8ClampedArray
            q.push({ idx: captureCount++, timeS: meta.mediaTime, pixels })
            lastVF = vf
            if (q.length >= QUEUE_MAX) video.pause()
            wakeInference?.(); wakeInference = null
          }
          if (!video.ended && meta.mediaTime < duration - 0.01) pump()
          else { captureFinished = true; wakeInference?.(); wakeInference = null }
        })
      }

      video.playbackRate = 4
      pump()
      video.play()

      let processed = 0
      while (!captureFinished || q.length > 0) {
        if (abortRef.current) break
        if (q.length === 0) { await new Promise<void>(r => { wakeInference = r }); continue }

        const { idx, timeS, pixels } = q.shift()!
        if (!video.ended && video.paused) video.play()

        frameBuf.push(pixels)
        if (frameBuf.length > 3) frameBuf.shift()

        const detection = frameBuf.length === 3 ? await inferBall(frameBuf) : null
        raw.push({ frameIndex: idx, timeS, ball: resolveBall(detection), rawVelocityKmh: null, velocityKmh: null })

        processed++
        updateProgress(processed)
        if (processed % 15 === 0) {
          setPreviewUrl(canvas.toDataURL('image/jpeg', 0.5))
          await new Promise<void>(r => setTimeout(r, 0))
        }
      }

    } else {
      // ── Fallback: seek/infer pipeline (Firefox) ────────────────────────────
      function seekTo(t: number): Promise<void> {
        video.currentTime = t
        return new Promise<void>(r => video.addEventListener('seeked', () => r(), { once: true }))
      }

      await seekTo(0)

      for (let i = 0; i <= total; i++) {
        if (abortRef.current) break

        ctx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H)
        frameBuf.push(ctx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H).data.slice() as unknown as Uint8ClampedArray)
        if (frameBuf.length > 3) frameBuf.shift()

        const seekNext = i < total ? seekTo((i + 1) * frameStep / videoFps) : Promise.resolve()
        const inferP   = frameBuf.length === 3 ? inferBall(frameBuf) : Promise.resolve(null)
        const [, detection] = await Promise.all([seekNext, inferP])

        raw.push({ frameIndex: i, timeS: i * frameStep / videoFps, ball: resolveBall(detection), rawVelocityKmh: null, velocityKmh: null })
        updateProgress(i + 1)
        if (i % 15 === 0) {
          setPreviewUrl(canvas.toDataURL('image/jpeg', 0.5))
          await new Promise<void>(r => setTimeout(r, 0))
        }
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

          <Field label="Detection threshold">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0.3}
                max={0.9}
                step={0.05}
                value={threshold}
                onChange={e => setThreshold(parseFloat(e.target.value))}
                className="flex-1 accent-green-500"
              />
              <span className="text-sm text-slate-300 w-10 text-right">{threshold.toFixed(2)}</span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Lower = more detections but more false positives
            </p>
          </Field>
        </div>

        {modelError && (
          <p className="text-sm text-red-400 bg-red-900/30 rounded-xl px-4 py-3">
            Model failed to load: {modelError}
          </p>
        )}

        {modelStatus === 'warming' && (
          <div className="flex items-center gap-2 text-xs text-amber-400">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            One-time GPU shader compilation — subsequent runs start instantly
          </div>
        )}

        {modelStatus === 'ready' && (
          <p className="text-xs text-slate-600">
            {crossOriginIsolated
              ? `Multi-threaded inference (${navigator.hardwareConcurrency} cores)`
              : 'Single-threaded inference'}
          </p>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={onBack}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
          >
            ← Back
          </button>
          <button
            disabled={modelStatus !== 'ready'}
            onClick={() => setPhase('processing')}
            className="px-6 py-2.5 rounded-xl font-medium text-sm bg-green-500 hover:bg-green-400 text-slate-900 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{
              loading: 'Loading model…',
              warming: 'Compiling GPU shaders…',
              ready:   'Start analysis',
              error:   'Start analysis',
            }[modelStatus]}
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

        <div className="flex justify-between text-xs text-slate-500">
          <span>{Math.round(progress * 100)}%</span>
          {eta && phase !== 'done' && <span>{eta}</span>}
        </div>
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
