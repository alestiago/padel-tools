import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeypointId, KeypointsMap, VideoMeta } from '../types.ts'
import { KEYPOINT_IDS } from '../types.ts'
import { buildExport, buildMultiExport, downloadJson, downloadAllJson } from '../lib/exportJson.ts'
import PoseCanvas from './PoseCanvas.tsx'
import KeypointPanel from './KeypointPanel.tsx'

interface Props {
  meta: VideoMeta
  initialLabels?: Map<number, KeypointsMap>
}

function nextUnplacedKeypoint(current: KeypointId, keypoints: KeypointsMap): KeypointId {
  const idx = KEYPOINT_IDS.indexOf(current)
  for (let i = 1; i < KEYPOINT_IDS.length; i++) {
    const candidate = KEYPOINT_IDS[(idx + i) % KEYPOINT_IDS.length]
    if (!keypoints[candidate]) return candidate
  }
  return KEYPOINT_IDS[(idx + 1) % KEYPOINT_IDS.length]
}

function frameToTime(frame: number, fps: number): string {
  const secs = frame / fps
  const m = Math.floor(secs / 60)
  const s = (secs % 60).toFixed(1).padStart(4, '0')
  return `${String(m).padStart(2, '0')}:${s}`
}

export default function LabelStep({ meta, initialLabels }: Props) {
  const [currentFrame, setCurrentFrame] = useState(0)
  const [frameLabels, setFrameLabels] = useState<Map<number, KeypointsMap>>(initialLabels ?? new Map())
  const [activeKeypoint, setActiveKeypoint] = useState<KeypointId>('head')
  const [pinned, setPinned] = useState(false)
  const undoStack = useRef<KeypointId[]>([])

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const seekingRef = useRef(false)

  // Derived: keypoints for the current frame
  const keypoints: KeypointsMap = frameLabels.get(currentFrame) ?? {}

  // Sorted list of frames that have at least one keypoint placed
  const labelledFrames = Array.from(frameLabels.entries())
    .filter(([, kps]) => Object.keys(kps).length > 0)
    .map(([f]) => f)
    .sort((a, b) => a - b)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const url = URL.createObjectURL(meta.file)
    video.src = url
    video.preload = 'auto'
    video.load()
    return () => { URL.revokeObjectURL(url); video.src = '' }
  }, [meta.file])

  const seekToFrame = useCallback(async (frame: number) => {
    if (seekingRef.current) return
    const video = videoRef.current
    if (!video) return
    const clamped = Math.max(0, Math.min(meta.frameCount - 1, frame))
    seekingRef.current = true
    video.currentTime = clamped / meta.fps
    await new Promise<void>((resolve) => {
      const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve() }
      video.addEventListener('seeked', onSeeked)
    })
    setCurrentFrame(clamped)
    undoStack.current = []
    seekingRef.current = false
  }, [meta.fps, meta.frameCount])

  // Mutate the keypoints map for the current frame
  const updateKeypoints = useCallback((updater: (prev: KeypointsMap) => KeypointsMap) => {
    setFrameLabels(prev => {
      const updated = updater(prev.get(currentFrame) ?? {})
      const next = new Map(prev)
      next.set(currentFrame, updated)
      return next
    })
  }, [currentFrame])

  const handlePlace = useCallback((id: KeypointId, x: number, y: number) => {
    updateKeypoints(prev => {
      undoStack.current.push(id)
      return { ...prev, [id]: { x, y, visibility: 'visible' as const } }
    })
    if (!pinned) {
      setActiveKeypoint(prev => nextUnplacedKeypoint(prev, { ...keypoints, [id]: { x, y, visibility: 'visible' } }))
    }
  }, [keypoints, pinned, updateKeypoints])

  const handleRemove = useCallback((id: KeypointId) => {
    updateKeypoints(prev => { const n = { ...prev }; delete n[id]; return n })
  }, [updateKeypoints])

  const handleSetVisibility = useCallback((id: KeypointId, vis: 'occluded' | 'not_in_frame') => {
    updateKeypoints(prev => {
      const existing = prev[id]
      if (!existing) return prev
      return { ...prev, [id]: { ...existing, visibility: vis } }
    })
  }, [updateKeypoints])

  const handleExportFrame = () => {
    downloadJson(buildExport(meta.file.name, currentFrame, meta.fps, keypoints))
  }

  const handleExportAll = () => {
    downloadAllJson(buildMultiExport(meta.file.name, meta.fps, frameLabels))
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return

      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        const delta = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowRight' ? 1 : -1)
        void seekToFrame(currentFrame + delta)
        return
      }

      // Jump between labelled frames
      if (e.key === ']' || e.key === '[') {
        e.preventDefault()
        const sorted = labelledFrames
        if (sorted.length === 0) return
        if (e.key === ']') {
          const next = sorted.find(f => f > currentFrame)
          if (next !== undefined) void seekToFrame(next)
        } else {
          const prev = [...sorted].reverse().find(f => f < currentFrame)
          if (prev !== undefined) void seekToFrame(prev)
        }
        return
      }

      if (e.key === 'Tab') {
        e.preventDefault()
        const idx = KEYPOINT_IDS.indexOf(activeKeypoint)
        setActiveKeypoint(KEYPOINT_IDS[(idx + (e.shiftKey ? -1 + KEYPOINT_IDS.length : 1)) % KEYPOINT_IDS.length])
        return
      }

      if (e.key === 'p') {
        e.preventDefault()
        setPinned(prev => !prev)
        return
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && keypoints[activeKeypoint]) {
        e.preventDefault()
        handleRemove(activeKeypoint)
        return
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        const last = undoStack.current.pop()
        if (last) {
          updateKeypoints(prev => { const n = { ...prev }; delete n[last]; return n })
          setActiveKeypoint(last)
        }
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [currentFrame, activeKeypoint, labelledFrames, seekToFrame, updateKeypoints])

  const placedCount = Object.keys(keypoints).length
  const progressPct = meta.frameCount > 1 ? (currentFrame / (meta.frameCount - 1)) * 100 : 0

  const handleScrubClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    void seekToFrame(Math.round(ratio * (meta.frameCount - 1)))
  }

  const handleFrameInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const val = parseInt((e.target as HTMLInputElement).value, 10)
      if (!isNaN(val)) void seekToFrame(val)
      ;(e.target as HTMLInputElement).blur()
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700 text-sm shrink-0">
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={0}
            max={meta.frameCount - 1}
            defaultValue={0}
            key={currentFrame}
            onKeyDown={handleFrameInputKey}
            className="w-20 font-mono bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-slate-200 text-sm focus:outline-none focus:border-blue-400"
          />
          <span className="text-slate-500 font-mono">/ {meta.frameCount - 1}</span>
          <span className="text-slate-400 font-mono text-xs">{frameToTime(currentFrame, meta.fps)}</span>
          <span className="text-slate-600 text-xs">{placedCount} / {KEYPOINT_IDS.length} kp</span>
          {labelledFrames.length > 0 && (
            <span className="text-blue-400 text-xs">
              {labelledFrames.length} frame{labelledFrames.length !== 1 ? 's' : ''} labelled
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportFrame}
            disabled={placedCount === 0}
            className="text-sm px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 font-medium transition-colors"
          >
            Export frame
          </button>
          {labelledFrames.length > 0 && (
            <button
              onClick={handleExportAll}
              className="text-sm px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white font-medium transition-colors"
            >
              Export all ({labelledFrames.length})
            </button>
          )}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-h-0 min-w-0">
          <PoseCanvas
            videoRef={videoRef}
            videoWidth={meta.width}
            videoHeight={meta.height}
            keypoints={keypoints}
            activeKeypoint={activeKeypoint}
            onPlace={handlePlace}
            onRemove={handleRemove}
            onSetVisibility={handleSetVisibility}
          />
        </div>
        <div className="w-56 shrink-0 p-3 bg-slate-800 border-l border-slate-700 overflow-y-auto">
          <KeypointPanel
            keypoints={keypoints}
            activeKeypoint={activeKeypoint}
            onSelect={setActiveKeypoint}
            onRemove={handleRemove}
            pinned={pinned}
            onTogglePin={() => setPinned(prev => !prev)}
          />
        </div>
      </div>

      {/* Timeline + controls */}
      <div className="shrink-0 bg-slate-800 border-t border-slate-700 px-4 py-2 space-y-1.5">

        {/* Labelled-frame marker strip */}
        <div className="h-3 relative">
          {labelledFrames.map(f => {
            const pct = meta.frameCount > 1 ? (f / (meta.frameCount - 1)) * 100 : 0
            const isCurrent = f === currentFrame
            return (
              <button
                key={f}
                onClick={() => void seekToFrame(f)}
                title={`Frame ${f} · ${frameToTime(f, meta.fps)}`}
                className="absolute top-0 h-full w-1 -translate-x-1/2 rounded-full transition-opacity hover:opacity-100"
                style={{
                  left: `${pct}%`,
                  background: isCurrent ? '#ffffff' : '#3b82f6',
                  opacity: isCurrent ? 1 : 0.7,
                }}
              />
            )
          })}
        </div>

        {/* Scrub bar */}
        <div
          className="h-2 bg-slate-700 rounded cursor-pointer relative"
          onClick={handleScrubClick}
        >
          <div
            className="absolute inset-y-0 left-0 bg-blue-600 rounded"
            style={{ width: `${progressPct}%` }}
          />
          <div
            className="absolute top-1/2 w-3 h-3 bg-white rounded-full shadow"
            style={{ left: `${progressPct}%`, transform: 'translate(-50%, -50%)' }}
          />
        </div>

        {/* Buttons */}
        <div className="flex items-center justify-center gap-2 pt-0.5">
          <button onClick={() => void seekToFrame(currentFrame - 10)} title="Back 10 frames (Shift+←)"
            className="px-3 py-1.5 text-sm rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
            &#9664;&#9664;
          </button>
          <button onClick={() => void seekToFrame(currentFrame - 1)} title="Previous frame (←)"
            className="px-3 py-1.5 text-sm rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
            &#9664;
          </button>
          <button onClick={() => void seekToFrame(currentFrame + 1)} title="Next frame (→)"
            className="px-3 py-1.5 text-sm rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
            &#9654;
          </button>
          <button onClick={() => void seekToFrame(currentFrame + 10)} title="Forward 10 frames (Shift+→)"
            className="px-3 py-1.5 text-sm rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
            &#9654;&#9654;
          </button>
          <span className="w-px h-5 bg-slate-600 mx-1 shrink-0" />
          <span className="text-xs text-slate-500">
            [ / ] — prev/next label · Tab — cycle kp · P — pin · Del — remove kp · Cmd+Z — undo · right-click — options
          </span>
        </div>
      </div>
    </div>
  )
}
