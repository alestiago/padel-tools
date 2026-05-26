import { useCallback, useEffect, useRef, useState } from 'react'
import type { Hand, ImpactSurface, LabelRecord, PlayState, ShotForcing, ShotType, VideoMeta, Visibility } from '../types.ts'
import { IMPACT_SHORTCUTS, IMPACT_SURFACES, SHOT_TYPE_CONSTRAINTS } from '../types.ts'
import { seekToFrame } from '../lib/frameSeeker.ts'
import { saveLabels } from '../lib/labelStore.ts'
import VideoCanvas from './VideoCanvas.tsx'
import Timeline from './Timeline.tsx'
import PlayStateSelector from './PlayStateSelector.tsx'
import VisibilitySelector from './VisibilitySelector.tsx'
import ImpactSelector from './ImpactSelector.tsx'
import ShotTypePicker from './ShotTypePicker.tsx'

interface Props {
  meta: VideoMeta
  labels: Map<number, LabelRecord>
  onChange: (labels: Map<number, LabelRecord>) => void
}

interface UndoEntry {
  frame: number
  prev: LabelRecord | undefined
}

function findLastRacketFrame(labels: Map<number, LabelRecord>, upToFrame: number): number | null {
  let result: number | null = null
  for (const [f, rec] of labels) {
    if (f <= upToFrame && rec.impact === 'racket') {
      if (result === null || f > result) result = f
    }
  }
  return result
}

function formatTime(frame: number, fps: number): string {
  const totalSecs = frame / fps
  const mins = Math.floor(totalSecs / 60)
  const secs = (totalSecs % 60).toFixed(1).padStart(4, '0')
  return `${String(mins).padStart(2, '0')}:${secs}`
}

const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2]

export default function LabelStep({ meta, labels, onChange }: Props) {
  const [currentFrame, setCurrentFrame] = useState(0)
  const [stickyPlay, setStickyPlay] = useState<PlayState>('unspecified')
  const [stickyVis, setStickyVis] = useState<Visibility>('visible')
  const [stickyShot, setStickyShot] = useState<ShotType | null>(null)
  const [recentShots, setRecentShots] = useState<ShotType[]>([])
  const [stickyHand, setStickyHand] = useState<Hand | null>(null)
  const [stickyForcing, setStickyForcing] = useState<ShotForcing | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const seekingRef = useRef(false)
  const undoStack = useRef<UndoEntry[]>([])
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shotSearchRef = useRef<HTMLInputElement | null>(null)

  // Set up video src from meta.file
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const url = URL.createObjectURL(meta.file)
    video.src = url
    video.preload = 'auto'
    video.load()
    return () => {
      URL.revokeObjectURL(url)
      video.src = ''
    }
  }, [meta.file])

  const seek = useCallback(async (frame: number) => {
    if (seekingRef.current) return
    const video = videoRef.current
    if (!video) return
    seekingRef.current = true
    try {
      await seekToFrame(video, frame, meta.fps)
      setCurrentFrame(frame)
    } finally {
      seekingRef.current = false
    }
  }, [meta.fps])

  const applyLabel = useCallback((record: LabelRecord) => {
    const prev = labels.get(record.frame)
    undoStack.current.push({ frame: record.frame, prev })
    const next = new Map(labels)
    next.set(record.frame, record)
    onChange(next)
  }, [labels, onChange])

  const changePlay = useCallback((play: PlayState) => {
    setStickyPlay(play)
    const existing = labels.get(currentFrame)
    if (existing) applyLabel({ ...existing, play_state: play })
  }, [labels, currentFrame, applyLabel])

  const changeVis = useCallback((vis: Visibility) => {
    setStickyVis(vis)
    const existing = labels.get(currentFrame)
    if (existing) applyLabel({ ...existing, visibility: vis })
  }, [labels, currentFrame, applyLabel])

  const applyRate = useCallback((rate: number) => {
    setPlaybackRate(rate)
    if (videoRef.current) videoRef.current.playbackRate = rate
  }, [])

  // Set / clear the impact surface on the current frame's label
  const handleSetImpact = useCallback((surface: ImpactSurface | null) => {
    const existing = labels.get(currentFrame)
    const shot_type = surface === 'racket' ? stickyShot : null
    const hand = surface === 'racket' ? stickyHand : null
    const forcing = surface === 'racket' ? stickyForcing : null
    if (existing) {
      applyLabel({ ...existing, impact: surface, shot_type, hand, forcing })
    } else {
      applyLabel({
        frame: currentFrame,
        play_state: stickyPlay,
        visibility: stickyVis,
        x: null,
        y: null,
        impact: surface,
        shot_type,
        hand,
        forcing,
      })
    }
  }, [currentFrame, labels, stickyPlay, stickyVis, stickyShot, stickyHand, stickyForcing, applyLabel])

  const handleSetHand = useCallback((h: Hand | null) => {
    const target = findLastRacketFrame(labels, currentFrame)
    if (target === null) return
    applyLabel({ ...labels.get(target)!, hand: h })
    setStickyHand(h)
  }, [currentFrame, labels, applyLabel])

  const handleSetForcing = useCallback((f: ShotForcing | null) => {
    const target = findLastRacketFrame(labels, currentFrame)
    if (target === null) return
    applyLabel({ ...labels.get(target)!, forcing: f })
    setStickyForcing(f)
  }, [currentFrame, labels, applyLabel])

  const handleSetShotType = useCallback((t: ShotType | null) => {
    const target = findLastRacketFrame(labels, currentFrame)
    if (target === null) return
    const constraints = t !== null ? (SHOT_TYPE_CONSTRAINTS[t] ?? {}) : {}
    const existing = labels.get(target)!
    applyLabel({
      ...existing,
      shot_type: t,
      ...(constraints.hand !== undefined ? { hand: constraints.hand } : {}),
      ...(constraints.forcing !== undefined ? { forcing: constraints.forcing } : {}),
    })
    setStickyShot(t)
    if (constraints.hand !== undefined) setStickyHand(constraints.hand)
    if (constraints.forcing !== undefined) setStickyForcing(constraints.forcing)
    if (t !== null) {
      setRecentShots((prev) => {
        const filtered = prev.filter((s) => s !== t)
        return [t, ...filtered].slice(0, 8)
      })
    }
  }, [currentFrame, labels, applyLabel])

  const handleVideoClick = useCallback((x: number, y: number) => {
    if (stickyVis === 'out_of_frame') return
    const vis = stickyVis === 'unspecified' ? 'visible' : stickyVis
    if (vis !== stickyVis) setStickyVis(vis)
    const existing = labels.get(currentFrame)
    const record: LabelRecord = {
      frame: currentFrame,
      play_state: stickyPlay,
      visibility: vis,
      x,
      y,
      impact: existing?.impact ?? null,
      shot_type: existing?.shot_type ?? null,
      hand: existing?.hand ?? null,
      forcing: existing?.forcing ?? null,
    }
    applyLabel(record)
    // Auto-advance one frame when ball is visible (including motion blur)
    if (vis === 'visible' || vis === 'motion_blur') {
      const next = Math.min(meta.frameCount - 1, currentFrame + 1)
      void seek(next)
    }
  }, [stickyVis, stickyPlay, currentFrame, labels, applyLabel, seek, meta.frameCount])

  // Sync sticky selectors to the label of the newly navigated-to frame
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const rec = labels.get(currentFrame)
    setStickyPlay(rec?.play_state ?? 'unspecified')
    setStickyVis(rec?.visibility ?? 'unspecified')
  }, [currentFrame])

  // Auto-save with 2s debounce
  useEffect(() => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      const arr = [...labels.values()]
      saveLabels(meta.file.name, arr, meta.fps)
    }, 2000)
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    }
  }, [labels, meta.file.name, meta.fps])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setShowShortcuts(false); return }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      const key = e.key

      // Play/Pause
      if (key === ' ') {
        e.preventDefault()
        const video = videoRef.current
        if (!video) return
        if (video.paused) {
          void video.play()
          setIsPlaying(true)
        } else {
          video.pause()
          setIsPlaying(false)
        }
        return
      }

      // Play state
      if (key === 'p' || key === 'P') { changePlay('in_play'); return }
      if (key === 'd' || key === 'D') { changePlay('dead'); return }
      if (key === 'u' || key === 'U') { changePlay('unspecified'); return }

      // Visibility
      if (key === 'v' || key === 'V') { changeVis('visible'); return }
      if (key === 'm' || key === 'M') { changeVis('motion_blur'); return }
      if (key === 'o' || key === 'O') { changeVis('occluded'); return }
      if (key === 'k' || key === 'K') { changeVis('out_of_frame'); return }

      // Shot type search focus
      if (key === 't' || key === 'T') {
        shotSearchRef.current?.focus()
        return
      }

      // Impact — direct shortcuts or cycle with I
      {
        const upperKey = key.toUpperCase()
        const directSurface = IMPACT_SURFACES.find(
          (s) => IMPACT_SHORTCUTS[s] === upperKey
        )
        if (directSurface) {
          const cur = labels.get(currentFrame)?.impact ?? null
          handleSetImpact(cur === directSurface ? null : directSurface)
          return
        }
      }
      if (key === 'i' || key === 'I') {
        const cur = labels.get(currentFrame)?.impact ?? null
        const idx = cur === null ? 0 : IMPACT_SURFACES.indexOf(cur) + 1
        const next = idx >= IMPACT_SURFACES.length ? null : IMPACT_SURFACES[idx]
        handleSetImpact(next)
        return
      }

      // Delete label
      if (key === 'Backspace' || key === 'Delete') {
        const next = new Map(labels)
        next.delete(currentFrame)
        onChange(next)
        return
      }

      // Undo
      if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault()
        const entry = undoStack.current.pop()
        if (!entry) return
        const next = new Map(labels)
        if (entry.prev === undefined) {
          next.delete(entry.frame)
        } else {
          next.set(entry.frame, entry.prev)
        }
        onChange(next)
        return
      }

      // Playback speed
      if (key === '[' || key === '{') {
        const idx = PLAYBACK_SPEEDS.indexOf(playbackRate)
        if (idx > 0) applyRate(PLAYBACK_SPEEDS[idx - 1])
        return
      }
      if (key === ']' || key === '}') {
        const idx = PLAYBACK_SPEEDS.indexOf(playbackRate)
        if (idx < PLAYBACK_SPEEDS.length - 1) applyRate(PLAYBACK_SPEEDS[idx + 1])
        return
      }

      // Go to next unlabelled frame
      if (key === 'g' || key === 'G') {
        let f = currentFrame + 1
        while (f < meta.frameCount && labels.has(f)) f++
        if (f < meta.frameCount) void seek(f)
        return
      }

      // Arrow navigation
      if (key === 'ArrowRight' || key === 'ArrowLeft') {
        e.preventDefault()
        const delta = e.shiftKey ? 10 : 1
        if (key === 'ArrowRight') {
          // Auto-label on right arrow when play state is pinned, or visibility is explicitly non-visible
          const isExplicitNonVisible = stickyVis === 'occluded' || stickyVis === 'out_of_frame'
          if ((stickyPlay !== 'unspecified' || isExplicitNonVisible) && !labels.has(currentFrame)) {
            applyLabel({
              frame: currentFrame,
              play_state: stickyPlay,
              visibility: stickyVis,
              x: null,
              y: null,
              impact: null,
              shot_type: null,
              hand: null,
              forcing: null,
            })
          }
          const next = Math.min(meta.frameCount - 1, currentFrame + delta)
          void seek(next)
        } else {
          const prev = Math.max(0, currentFrame - delta)
          void seek(prev)
        }
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [currentFrame, stickyPlay, stickyVis, labels, onChange, seek, applyLabel, handleSetImpact, meta.frameCount, shotSearchRef, playbackRate, applyRate, changePlay, changeVis])

  // Track play/pause state from the video element
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onPause = () => setIsPlaying(false)
    const onPlay = () => setIsPlaying(true)
    video.addEventListener('pause', onPause)
    video.addEventListener('play', onPlay)
    return () => {
      video.removeEventListener('pause', onPause)
      video.removeEventListener('play', onPlay)
    }
  }, [])

  // RAF loop — keeps currentFrame in sync with the video at display refresh rate
  useEffect(() => {
    if (!isPlaying) return
    let rafId: number
    const tick = () => {
      const video = videoRef.current
      if (video && !video.paused) {
        const f = Math.round(video.currentTime * meta.fps)
        setCurrentFrame(Math.min(meta.frameCount - 1, f))
        rafId = requestAnimationFrame(tick)
      }
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [isPlaying, meta.fps, meta.frameCount])

  const handleSeek = (frame: number) => {
    const video = videoRef.current
    if (video && !video.paused) {
      video.pause()
      setIsPlaying(false)
    }
    void seek(frame)
  }

  const labelledCount = labels.size
  const curLabel = labels.get(currentFrame)
  const lastRacketFrame = findLastRacketFrame(labels, currentFrame)
  const lastRacketLabel = lastRacketFrame !== null ? labels.get(lastRacketFrame) : undefined

  const stepBack = () => handleSeek(Math.max(0, currentFrame - 1))
  const stepForward = () => handleSeek(Math.min(meta.frameCount - 1, currentFrame + 1))
  const skipBack = () => handleSeek(Math.max(0, currentFrame - 10))
  const skipForward = () => handleSeek(Math.min(meta.frameCount - 1, currentFrame + 10))

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      void video.play()
    } else {
      video.pause()
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700 text-sm shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-mono text-slate-200">
            Frame {currentFrame} / {meta.frameCount}
          </span>
          <span className="font-mono text-slate-400">
            {formatTime(currentFrame, meta.fps)}
          </span>
          <span className="w-px h-3.5 bg-slate-600 shrink-0" />
          <span className="text-slate-400 text-xs">{labelledCount} / {meta.frameCount} labelled</span>
          <span className="text-slate-500 text-xs">{meta.frameCount > 0 ? Math.round(labelledCount / meta.frameCount * 100) : 0}%</span>
        </div>
        <div className="flex items-center gap-3 text-slate-400">
          {curLabel && (
            <span className={`text-xs px-2 py-0.5 rounded ${
              curLabel.play_state === 'in_play' ? 'bg-green-900 text-green-300'
              : curLabel.play_state === 'dead' ? 'bg-red-900 text-red-300'
              : 'bg-slate-700 text-slate-400'
            }`}>
              {curLabel.play_state === 'in_play' ? 'In Play' : curLabel.play_state === 'dead' ? 'Dead' : 'Unspecified'}
            </span>
          )}
          {curLabel && (
            <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300">
              {curLabel.visibility}
            </span>
          )}
          <button
            onClick={() => setShowShortcuts(true)}
            className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-400 hover:bg-slate-600 hover:text-slate-200 transition-colors"
          >
            Shortcuts
          </button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex min-h-0">
        {/* Video canvas area */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          <div className="flex-1 min-h-0">
            <VideoCanvas
              videoRef={videoRef}
              videoWidth={meta.width}
              videoHeight={meta.height}
              labels={labels}
              currentFrame={currentFrame}
              stickyVis={stickyVis}
              isPlaying={isPlaying}
              onVideoClick={handleVideoClick}
            />
          </div>
          {/* Timeline + controls */}
          <div className="shrink-0 bg-slate-800 border-t border-slate-700">
            <Timeline
              frameCount={meta.frameCount}
              labels={labels}
              currentFrame={currentFrame}
              onSeek={handleSeek}
            />
            <div className="flex items-center justify-center gap-2 pb-2">
              <button
                onClick={skipBack}
                title="Back 10 frames"
                className="px-3 py-1.5 text-sm rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
              >
                &#9664;&#9664;
              </button>
              <button
                onClick={stepBack}
                title="Previous frame"
                className="px-3 py-1.5 text-sm rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
              >
                &#9664;
              </button>
              <button
                onClick={togglePlay}
                title={isPlaying ? 'Pause' : 'Play'}
                className="px-4 py-1.5 text-sm rounded bg-slate-600 hover:bg-slate-500 text-white font-medium transition-colors min-w-[52px]"
              >
                {isPlaying ? 'Pause' : 'Play'}
              </button>
              <button
                onClick={stepForward}
                title="Next frame"
                className="px-3 py-1.5 text-sm rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
              >
                &#9654;
              </button>
              <button
                onClick={skipForward}
                title="Forward 10 frames"
                className="px-3 py-1.5 text-sm rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
              >
                &#9654;&#9654;
              </button>
              <span className="w-px h-5 bg-slate-600 mx-1 shrink-0" />
              {PLAYBACK_SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => applyRate(s)}
                  title={`${s}× speed`}
                  className={`px-2 py-1.5 text-xs rounded font-mono transition-colors ${
                    playbackRate === s
                      ? 'bg-slate-500 text-white'
                      : 'bg-slate-700 text-slate-400 hover:bg-slate-600 hover:text-slate-200'
                  }`}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-[260px] shrink-0 flex flex-col gap-4 p-3 bg-slate-800 border-l border-slate-700 overflow-y-auto">
          <PlayStateSelector value={stickyPlay} onChange={changePlay} />
          <VisibilitySelector value={stickyVis} onChange={changeVis} />
          <ImpactSelector
            value={curLabel?.impact ?? null}
            onChange={handleSetImpact}
          />

          {/* Stroke — hand + shot type, always visible, targets last racket frame */}
          <div className="space-y-1.5">
            <p className="text-xs text-slate-400 uppercase tracking-wide font-medium flex items-center justify-between">
              <span>Stroke</span>
              {lastRacketFrame !== null && lastRacketFrame !== currentFrame && (
                <span className="text-slate-600 normal-case font-normal">→ {lastRacketFrame}</span>
              )}
            </p>
            {lastRacketFrame === null ? (
              <p className="text-xs text-slate-600 italic">No racket contact yet</p>
            ) : (
              <>
                <div className="flex gap-1">
                  {(['forehand', 'backhand'] as Hand[]).map((h) => (
                    <button
                      key={h}
                      onClick={() => handleSetHand(lastRacketLabel?.hand === h ? null : h)}
                      className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors capitalize ${
                        lastRacketLabel?.hand === h
                          ? 'bg-violet-700 text-white'
                          : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                      }`}
                    >
                      {h}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1">
                  {(['forced', 'unforced'] as ShotForcing[]).map((f) => (
                    <button
                      key={f}
                      onClick={() => handleSetForcing(lastRacketLabel?.forcing === f ? null : f)}
                      className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors capitalize ${
                        lastRacketLabel?.forcing === f
                          ? f === 'forced'
                            ? 'bg-amber-700 text-white'
                            : 'bg-emerald-700 text-white'
                          : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
                <ShotTypePicker
                  value={lastRacketLabel?.shot_type ?? null}
                  recents={recentShots}
                  onSelect={handleSetShotType}
                  searchInputRef={shotSearchRef}
                />
              </>
            )}
          </div>

        </div>
      </div>

      {/* Shortcuts modal */}
      {showShortcuts && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowShortcuts(false)}
        >
          <div
            className="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl w-72 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-slate-100">Keyboard Shortcuts</h2>
              <button
                onClick={() => setShowShortcuts(false)}
                className="text-slate-400 hover:text-slate-200 text-lg leading-none"
              >
                ×
              </button>
            </div>
            <div className="space-y-3 text-xs text-slate-300">
              {([
                ['Playback', [
                  ['Space', 'Play / pause'],
                  ['→ / ←', 'Next / prev frame'],
                  ['Shift + →/←', '+10 / −10 frames'],
                  ['[ / ]', 'Slower / faster'],
                ]],
                ['Labels', [
                  ['Click', 'Place ball position'],
                  ['G', 'Jump to next unlabelled'],
                  ['Del', 'Remove current label'],
                  ['Ctrl Z', 'Undo'],
                ]],
                ['Play state', [
                  ['P', 'In play'],
                  ['D', 'Dead'],
                  ['U', 'Unspecified'],
                ]],
                ['Visibility', [
                  ['V', 'Visible'],
                  ['M', 'Motion blur'],
                  ['O', 'Occluded'],
                  ['K', 'Out of frame'],
                ]],
                ['Impact & stroke', [
                  ['R', 'Racket'],
                  ['F', 'Floor'],
                  ['W', 'Wall'],
                  ['E', 'Fence'],
                  ['N', 'Net'],
                  ['I', 'Cycle surface'],
                  ['T', 'Search shot types'],
                ]],
              ] as [string, [string, string][]][]).map(([group, items]) => (
                <div key={group}>
                  <p className="text-slate-500 uppercase tracking-wide font-medium mb-1">{group}</p>
                  {items.map(([key, desc]) => (
                    <div key={key} className="flex items-center justify-between py-0.5">
                      <kbd className="font-mono bg-slate-700 text-slate-200 px-1.5 py-0.5 rounded text-xs">{key}</kbd>
                      <span className="text-slate-400 ml-3 text-right">{desc}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-600 mt-4 text-center">Press Esc to close</p>
          </div>
        </div>
      )}

    </div>
  )
}
