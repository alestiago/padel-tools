import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImpactSurface, LabelRecord, PlayState, VideoMeta, Visibility } from '../types.ts'
import { IMPACT_SURFACES } from '../types.ts'
import { seekToFrame } from '../lib/frameSeeker.ts'
import { saveLabels } from '../lib/labelStore.ts'
import VideoCanvas from './VideoCanvas.tsx'
import Timeline from './Timeline.tsx'
import PlayStateSelector from './PlayStateSelector.tsx'
import VisibilitySelector from './VisibilitySelector.tsx'
import ImpactSelector from './ImpactSelector.tsx'

interface Props {
  meta: VideoMeta
  labels: Map<number, LabelRecord>
  onChange: (labels: Map<number, LabelRecord>) => void
  onExport: () => void
}

interface UndoEntry {
  frame: number
  prev: LabelRecord | undefined
}

function formatTime(frame: number, fps: number): string {
  const totalSecs = frame / fps
  const mins = Math.floor(totalSecs / 60)
  const secs = (totalSecs % 60).toFixed(1).padStart(4, '0')
  return `${String(mins).padStart(2, '0')}:${secs}`
}

export default function LabelStep({ meta, labels, onChange, onExport }: Props) {
  const [currentFrame, setCurrentFrame] = useState(0)
  const [stickyPlay, setStickyPlay] = useState<PlayState>('in_play')
  const [stickyVis, setStickyVis] = useState<Visibility>('visible')
  const [isPlaying, setIsPlaying] = useState(false)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const seekingRef = useRef(false)
  const undoStack = useRef<UndoEntry[]>([])
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)

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

  // Set / clear the impact surface on the current frame's label
  const handleSetImpact = useCallback((surface: ImpactSurface | null) => {
    const existing = labels.get(currentFrame)
    if (existing) {
      applyLabel({ ...existing, impact: surface })
    } else {
      applyLabel({
        frame: currentFrame,
        play_state: stickyPlay,
        visibility: stickyVis,
        x: null,
        y: null,
        impact: surface,
      })
    }
  }, [currentFrame, labels, stickyPlay, stickyVis, applyLabel])

  const handleVideoClick = useCallback((x: number, y: number) => {
    if (stickyVis === 'out_of_frame') return
    const existing = labels.get(currentFrame)
    const record: LabelRecord = {
      frame: currentFrame,
      play_state: stickyPlay,
      visibility: stickyVis,
      x,
      y,
      impact: existing?.impact ?? null,   // preserve any existing impact annotation
    }
    applyLabel(record)
    // Auto-advance one frame when visible
    if (stickyVis === 'visible') {
      const next = Math.min(meta.frameCount - 1, currentFrame + 1)
      void seek(next)
    }
  }, [stickyVis, stickyPlay, currentFrame, applyLabel, seek, meta.frameCount])

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
      if (key === 'p' || key === 'P') { setStickyPlay('in_play'); return }
      if (key === 'd' || key === 'D') { setStickyPlay('dead'); return }

      // Visibility
      if (key === 'v' || key === 'V') { setStickyVis('visible'); return }
      if (key === 'o' || key === 'O') { setStickyVis('occluded'); return }
      if (key === 'f' || key === 'F') { setStickyVis('out_of_frame'); return }

      // Impact — cycle through surfaces with I
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
          // Auto-label non-visible frames on right arrow
          if (stickyVis !== 'visible' && !labels.has(currentFrame)) {
            applyLabel({
              frame: currentFrame,
              play_state: stickyPlay,
              visibility: stickyVis,
              x: null,
              y: null,
              impact: null,
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
  }, [currentFrame, stickyPlay, stickyVis, labels, onChange, seek, applyLabel, handleSetImpact, meta.frameCount])

  // Handle video timeupdate when playing
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onTimeUpdate = () => {
      const f = Math.round(video.currentTime * meta.fps)
      setCurrentFrame(Math.min(meta.frameCount - 1, f))
    }
    const onPause = () => setIsPlaying(false)
    const onPlay = () => setIsPlaying(true)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('pause', onPause)
    video.addEventListener('play', onPlay)
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('play', onPlay)
    }
  }, [meta.fps, meta.frameCount])

  const handleSeek = (frame: number) => {
    const video = videoRef.current
    if (video && !video.paused) {
      video.pause()
      setIsPlaying(false)
    }
    void seek(frame)
  }

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string)
        const incoming: LabelRecord[] = Array.isArray(data.labels) ? data.labels : []
        const next = new Map(labels)
        for (const r of incoming) {
          next.set(r.frame, r)
        }
        onChange(next)
      } catch {
        // Silently ignore parse errors
      }
    }
    reader.readAsText(file)
    // Reset so same file can be imported again
    e.target.value = ''
  }

  const labelledCount = labels.size
  const curLabel = labels.get(currentFrame)

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
        <div className="flex items-center gap-4">
          <span className="font-mono text-slate-200">
            Frame {currentFrame} / {meta.frameCount}
          </span>
          <span className="font-mono text-slate-400">
            {formatTime(currentFrame, meta.fps)}
          </span>
        </div>
        <div className="flex items-center gap-3 text-slate-400">
          {curLabel && (
            <span className={`text-xs px-2 py-0.5 rounded ${
              curLabel.play_state === 'in_play' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'
            }`}>
              {curLabel.play_state === 'in_play' ? 'In Play' : 'Dead'}
            </span>
          )}
          {curLabel && (
            <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300">
              {curLabel.visibility}
            </span>
          )}
          <span className="text-slate-500 text-xs">
            {labelledCount} labelled ({meta.frameCount > 0 ? Math.round(labelledCount / meta.frameCount * 100) : 0}%)
          </span>
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
              onVideoClick={handleVideoClick}
            />
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-[220px] shrink-0 flex flex-col gap-4 p-3 bg-slate-800 border-l border-slate-700 overflow-y-auto">
          <PlayStateSelector value={stickyPlay} onChange={setStickyPlay} />
          <VisibilitySelector value={stickyVis} onChange={setStickyVis} />
          <ImpactSelector
            value={curLabel?.impact ?? null}
            onChange={handleSetImpact}
          />

          {/* Stats */}
          <div className="space-y-1.5">
            <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">Stats</p>
            <div className="text-xs space-y-1 text-slate-300">
              <div className="flex justify-between">
                <span className="text-slate-400">Labelled</span>
                <span>{labelledCount} / {meta.frameCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Complete</span>
                <span>
                  {meta.frameCount > 0 ? Math.round(labelledCount / meta.frameCount * 100) : 0}%
                </span>
              </div>
            </div>
          </div>

          {/* Keyboard shortcuts hint */}
          <div className="text-xs text-slate-500 space-y-0.5">
            <p className="text-slate-400 font-medium mb-1">Shortcuts</p>
            <p>Click — place label</p>
            <p>→ / ← — next/prev frame</p>
            <p>Shift+→ — +10 frames</p>
            <p>G — next unlabelled</p>
            <p>Space — play/pause</p>
            <p>I — cycle impact surface</p>
            <p>Del — remove label</p>
            <p>Ctrl+Z — undo</p>
          </div>

          <div className="flex flex-col gap-2 mt-auto">
            {/* Import */}
            <input
              ref={importInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleImport}
            />
            <button
              onClick={() => importInputRef.current?.click()}
              className="w-full bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium py-2 rounded transition-colors"
            >
              Import JSON
            </button>
            {/* Export */}
            <button
              onClick={onExport}
              className="w-full bg-blue-700 hover:bg-blue-600 text-white text-sm font-medium py-2 rounded transition-colors"
            >
              Export
            </button>
          </div>
        </div>
      </div>

      {/* Timeline + controls */}
      <div className="shrink-0 bg-slate-800 border-t border-slate-700">
        <Timeline
          frameCount={meta.frameCount}
          labels={labels}
          currentFrame={currentFrame}
          onSeek={handleSeek}
        />
        {/* Playback controls */}
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
        </div>
      </div>
    </div>
  )
}
