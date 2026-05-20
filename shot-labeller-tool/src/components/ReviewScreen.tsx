import { useCallback, useEffect, useRef, useState } from 'react'
import type { Hand, LabelRecord, ReviewTarget, ShotForcing, ShotType, VideoMeta } from '../types.ts'
import { SHOT_TYPE_CONSTRAINTS, SHOT_TYPE_LABELS, SHOT_TYPE_COLORS } from '../types.ts'
import ShotTypePicker from './ShotTypePicker.tsx'
import ClipProgressBar from './ClipProgressBar.tsx'

interface Props {
  meta: VideoMeta
  queue: ReviewTarget[]
  initialLabels: Map<number, LabelRecord>
  onDone: (labels: Map<number, LabelRecord>, skipped: ReviewTarget[]) => void
}

export default function ReviewScreen({ meta, queue, initialLabels, onDone }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const [videoReady, setVideoReady] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [workingLabels, setWorkingLabels] = useState<Map<number, LabelRecord>>(new Map(initialLabels))
  const [skipSet, setSkipSet] = useState<Set<number>>(new Set())
  const [recentTypes, setRecentTypes] = useState<ShotType[]>([])
  const [currentTime, setCurrentTime] = useState(0)

  // Render refs — always reflect the latest render's values; safe to read in timers/effects
  const workingLabelsRef = useRef(workingLabels)
  workingLabelsRef.current = workingLabels
  const skipSetRef = useRef(skipSet)
  skipSetRef.current = skipSet
  const currentIndexRef = useRef(currentIndex)
  currentIndexRef.current = currentIndex

  const currentTarget: ReviewTarget | undefined = queue[currentIndex]
  const currentLabel: LabelRecord | null = currentTarget
    ? (workingLabels.get(currentTarget.frame) ?? null)
    : null

  // Set up video source once
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const url = URL.createObjectURL(meta.file)
    video.src = url
    const onReady = () => setVideoReady(true)
    video.addEventListener('loadedmetadata', onReady)
    return () => {
      video.removeEventListener('loadedmetadata', onReady)
      URL.revokeObjectURL(url)
      video.src = ''
    }
  }, [meta.file])

  // Seek to clip start whenever index changes
  useEffect(() => {
    if (!videoReady || !currentTarget || !videoRef.current) return
    const video = videoRef.current
    video.currentTime = currentTarget.clipStart / meta.fps
    video.play().catch(() => {})
    if (advanceTimerRef.current !== null) {
      clearTimeout(advanceTimerRef.current)
      advanceTimerRef.current = null
    }
  }, [currentIndex, videoReady, currentTarget, meta.fps])

  // Detect completion
  useEffect(() => {
    if (currentIndex < queue.length) return
    const skipped = queue.filter((t) => skipSetRef.current.has(t.frame))
    onDone(workingLabelsRef.current, skipped)
  }, [currentIndex, queue, onDone])

  const scheduleAdvance = useCallback(() => {
    if (advanceTimerRef.current !== null) clearTimeout(advanceTimerRef.current)
    advanceTimerRef.current = setTimeout(() => {
      advanceTimerRef.current = null
      setCurrentIndex((i) => i + 1)
    }, 400)
  }, [])

  const cancelAdvance = useCallback(() => {
    if (advanceTimerRef.current !== null) {
      clearTimeout(advanceTimerRef.current)
      advanceTimerRef.current = null
    }
  }, [])

  const handleTimeUpdate = () => {
    const video = videoRef.current
    if (!video || !currentTarget) return
    setCurrentTime(video.currentTime)
    if (video.currentTime >= currentTarget.clipEnd / meta.fps) {
      video.currentTime = currentTarget.clipStart / meta.fps
    }
  }

  const handleSetShotType = useCallback(
    (t: ShotType | null) => {
      if (!currentTarget) return
      const frame = currentTarget.frame
      cancelAdvance()
      const cur = workingLabelsRef.current.get(frame)!
      const constraints = t ? (SHOT_TYPE_CONSTRAINTS[t] ?? {}) : {}
      const newHand = constraints.hand ?? cur.hand
      const newForcing = constraints.forcing ?? cur.forcing
      setWorkingLabels((prev) => {
        const next = new Map(prev)
        next.set(frame, { ...cur, shot_type: t, hand: newHand, forcing: newForcing })
        return next
      })
      if (t) {
        setRecentTypes((prev) => [t, ...prev.filter((s) => s !== t)].slice(0, 5))
        if (newHand != null && newForcing != null) scheduleAdvance()
      }
    },
    [currentTarget, cancelAdvance, scheduleAdvance],
  )

  const handleSetHand = useCallback(
    (h: Hand) => {
      if (!currentTarget) return
      const frame = currentTarget.frame
      const cur = workingLabelsRef.current.get(frame)!
      const newHand = cur.hand === h ? null : h
      setWorkingLabels((prev) => {
        const next = new Map(prev)
        next.set(frame, { ...cur, hand: newHand })
        return next
      })
      if (newHand != null && cur.shot_type != null && cur.forcing != null) scheduleAdvance()
      else cancelAdvance()
    },
    [currentTarget, scheduleAdvance, cancelAdvance],
  )

  const handleSetForcing = useCallback(
    (f: ShotForcing) => {
      if (!currentTarget) return
      const frame = currentTarget.frame
      const cur = workingLabelsRef.current.get(frame)!
      const newForcing = cur.forcing === f ? null : f
      setWorkingLabels((prev) => {
        const next = new Map(prev)
        next.set(frame, { ...cur, forcing: newForcing })
        return next
      })
      if (newForcing != null && cur.shot_type != null && cur.hand != null) scheduleAdvance()
      else cancelAdvance()
    },
    [currentTarget, scheduleAdvance, cancelAdvance],
  )

  const handleSkip = useCallback(() => {
    if (!currentTarget) return
    cancelAdvance()
    setSkipSet((prev) => new Set([...prev, currentTarget.frame]))
    setCurrentIndex((i) => i + 1)
  }, [currentTarget, cancelAdvance])

  const handleBack = useCallback(() => {
    cancelAdvance()
    if (currentIndex <= 0) return
    const prevIndex = currentIndex - 1
    const prevTarget = queue[prevIndex]
    setWorkingLabels((prev) => {
      const next = new Map(prev)
      const cur = next.get(prevTarget.frame)!
      next.set(prevTarget.frame, { ...cur, shot_type: null, hand: null, forcing: null })
      return next
    })
    setSkipSet((prev) => {
      const next = new Set(prev)
      next.delete(prevTarget.frame)
      return next
    })
    setCurrentIndex(prevIndex)
  }, [currentIndex, queue, cancelAdvance])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!currentTarget) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
        return
      }
      const video = videoRef.current
      switch (e.key) {
        case 't':
        case 'T':
          e.preventDefault()
          searchInputRef.current?.focus()
          break
        case 'f':
        case 'F':
          handleSetHand('forehand')
          break
        case 'b':
        case 'B':
          handleSetHand('backhand')
          break
        case 'u':
        case 'U':
          handleSetForcing('unforced')
          break
        case 'r':
        case 'R':
          handleSetForcing('forced')
          break
        case 'n':
        case 'N':
        case 'Tab':
          e.preventDefault()
          if (workingLabelsRef.current.get(currentTarget.frame)?.shot_type) {
            cancelAdvance()
            setCurrentIndex((i) => i + 1)
          } else {
            handleSkip()
          }
          break
        case 'ArrowLeft':
          e.preventDefault()
          if (video) {
            video.currentTime = Math.max(
              currentTarget.clipStart / meta.fps,
              video.currentTime - 5 / meta.fps,
            )
          }
          break
        case 'ArrowRight':
          e.preventDefault()
          if (video) {
            video.currentTime = Math.min(
              currentTarget.clipEnd / meta.fps,
              video.currentTime + 5 / meta.fps,
            )
          }
          break
        case ' ':
          e.preventDefault()
          if (video) {
            if (video.paused) video.play().catch(() => {})
            else video.pause()
          }
          break
        case 'Escape':
          handleBack()
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    currentTarget,
    meta.fps,
    handleSetHand,
    handleSetForcing,
    handleSkip,
    handleBack,
    cancelAdvance,
  ])

  if (!currentTarget) return null

  const skippedCount = skipSet.size
  const shotType = currentLabel?.shot_type ?? null

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Review header */}
      <div className="flex items-center px-4 py-2 bg-slate-800 border-b border-slate-700 shrink-0 gap-3">
        <span className="text-sm font-medium text-slate-300 flex-1">
          Shot {currentIndex + 1} / {queue.length}
          {skippedCount > 0 && (
            <span className="text-slate-500 ml-1.5">({skippedCount} skipped)</span>
          )}
        </span>
        {shotType && (
          <span
            className="text-xs px-2 py-0.5 rounded font-medium text-white"
            style={{ backgroundColor: SHOT_TYPE_COLORS[shotType] }}
          >
            {SHOT_TYPE_LABELS[shotType]}
          </span>
        )}
        <span className="text-xs text-slate-500">frame {currentTarget.frame}</span>
        <button
          onClick={handleBack}
          disabled={currentIndex === 0}
          className="text-sm px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 font-medium transition-colors"
        >
          ← Back
        </button>
        <button
          onClick={handleSkip}
          className="text-sm px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium transition-colors"
        >
          Skip
        </button>
      </div>

      {/* Video */}
      <div className="flex-1 bg-black min-h-0 flex items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          onTimeUpdate={handleTimeUpdate}
          className="max-h-full max-w-full"
          muted
          playsInline
        />
      </div>

      {/* Clip progress bar */}
      <ClipProgressBar
        clipStart={currentTarget.clipStart}
        clipEnd={currentTarget.clipEnd}
        targetFrame={currentTarget.frame}
        currentTime={currentTime}
        fps={meta.fps}
        onSeek={(t) => {
          if (videoRef.current) videoRef.current.currentTime = t
        }}
      />

      {/* Controls */}
      <div className="flex border-t border-slate-700 shrink-0" style={{ minHeight: '160px' }}>
        {/* Shot type panel */}
        <div className="flex-1 p-3 border-r border-slate-700 overflow-y-auto">
          <ShotTypePicker
            value={currentLabel?.shot_type ?? null}
            recents={recentTypes}
            onSelect={handleSetShotType}
            searchInputRef={searchInputRef}
          />
        </div>

        {/* Hand + Forcing panel */}
        <div className="w-52 p-3 space-y-3 shrink-0">
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wide font-medium mb-1.5">
              Hand
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {(['forehand', 'backhand'] as const).map((h) => (
                <button
                  key={h}
                  onClick={() => handleSetHand(h)}
                  className={`text-xs py-2 px-1 rounded font-medium transition-colors ${
                    currentLabel?.hand === h
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                  }`}
                >
                  {h === 'forehand' ? 'Forehand (F)' : 'Backhand (B)'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wide font-medium mb-1.5">
              Forcing
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {(['forced', 'unforced'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => handleSetForcing(f)}
                  className={`text-xs py-2 px-1 rounded font-medium transition-colors ${
                    currentLabel?.forcing === f
                      ? 'bg-amber-600 text-white'
                      : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                  }`}
                >
                  {f === 'forced' ? 'Forced (R)' : 'Unforced (U)'}
                </button>
              ))}
            </div>
          </div>

          <div className="text-xs text-slate-600 space-y-0.5 pt-1">
            <p>Space — play/pause</p>
            <p>← → — seek 5 frames</p>
            <p>T — search shot type</p>
            <p>N / Tab — next / skip</p>
            <p>Esc — go back</p>
          </div>
        </div>
      </div>
    </div>
  )
}
