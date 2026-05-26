import { useRef, useState } from 'react'
import type { KeypointsMap, VideoMeta } from '../types.ts'
import { parsePosesJson, detectPoseVersion, type PoseFileVersion } from '../lib/parsePoses.ts'

interface Props {
  onLoad: (meta: VideoMeta, initialLabels?: Map<number, KeypointsMap>) => void
}

export default function LoadStep({ onLoad }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [fps, setFps] = useState(30)
  const [videoDims, setVideoDims] = useState<{ width: number; height: number; duration: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const [posesFile, setPosesFile] = useState<File | null>(null)
  const [detectedVersion, setDetectedVersion] = useState<PoseFileVersion>(2)
  const [parsedLabels, setParsedLabels] = useState<Map<number, KeypointsMap> | null>(null)
  const [frameCount, setFrameCount] = useState(0)

  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const posesInputRef = useRef<HTMLInputElement | null>(null)

  const processFile = (f: File) => {
    setFile(f)
    setVideoDims(null)

    const url = URL.createObjectURL(f)
    if (!hiddenVideoRef.current) hiddenVideoRef.current = document.createElement('video')
    const video = hiddenVideoRef.current
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      setVideoDims({ width: video.videoWidth, height: video.videoHeight, duration: video.duration })
      URL.revokeObjectURL(url)
    }
    video.src = url
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (f) processFile(f)
  }

  const handlePosesFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const text = await f.text()
    const version = detectPoseVersion(text)
    setDetectedVersion(version)
    const result = parsePosesJson(text)
    setPosesFile(f)
    if (result) {
      setParsedLabels(result.frameLabels)
      setFrameCount(result.frameLabels.size)
      if (result.fps) setFps(result.fps)
    } else {
      setParsedLabels(null)
      setFrameCount(0)
    }
  }

  const clearPosesFile = () => {
    setPosesFile(null)
    setParsedLabels(null)
    setFrameCount(0)
    if (posesInputRef.current) posesInputRef.current.value = ''
  }

  const handleStart = (labels?: Map<number, KeypointsMap>) => {
    if (!file || !videoDims) return
    const frames = Math.floor(videoDims.duration * fps)
    onLoad(
      { file, fps, frameCount: frames, width: videoDims.width, height: videoDims.height, duration: videoDims.duration },
      labels,
    )
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-8 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-2">Load Video</h1>
        <p className="text-slate-400 text-sm">Select a video to annotate player body keypoints</p>
      </div>

      <div
        className={`w-full max-w-lg border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
          dragging ? 'border-blue-400 bg-blue-950/30' : 'border-slate-600 hover:border-slate-400'
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) processFile(f) }}
        />
        {file ? (
          <div>
            <p className="text-slate-200 font-medium truncate">{file.name}</p>
            <p className="text-slate-400 text-sm mt-1">{(file.size / (1024 * 1024)).toFixed(1)} MB</p>
          </div>
        ) : (
          <div>
            <p className="text-slate-300 font-medium">Drop a video file here</p>
            <p className="text-slate-400 text-sm mt-1">or click to browse</p>
            <p className="text-slate-500 text-xs mt-2">.mp4 .mov .webm</p>
          </div>
        )}
      </div>

      {videoDims && (
        <div className="w-full max-w-lg bg-slate-800 rounded-xl p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-slate-400">Resolution</span>
              <p className="text-slate-100 font-medium">{videoDims.width} × {videoDims.height}</p>
            </div>
            <div>
              <span className="text-slate-400">Duration</span>
              <p className="text-slate-100 font-medium">{videoDims.duration.toFixed(2)}s</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-400 whitespace-nowrap">FPS</label>
            <input
              type="number"
              min={1}
              max={240}
              step={0.001}
              value={fps}
              onChange={(e) => setFps(parseFloat(e.target.value) || 30)}
              className="w-28 bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-blue-400"
            />
            <span className="text-slate-500 text-sm">= {Math.floor(videoDims.duration * fps)} frames</span>
          </div>

          {/* Pre-load poses section */}
          <div className="border-t border-slate-700 pt-3 space-y-2">
            <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Pre-load poses (optional)</p>
            <input
              ref={posesInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handlePosesFileInput}
            />
            {!posesFile ? (
              <button
                onClick={() => posesInputRef.current?.click()}
                className="w-full border border-dashed border-slate-600 hover:border-slate-400 text-slate-400 hover:text-slate-200 text-sm py-2 rounded-lg transition-colors"
              >
                Load existing poses JSON
              </button>
            ) : (
              <div className="bg-slate-700 rounded-lg p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-slate-200 text-sm font-medium truncate">{posesFile.name}</p>
                    <p className="text-slate-400 text-xs mt-0.5">
                      {parsedLabels ? `${frameCount} frame${frameCount !== 1 ? 's' : ''} loaded` : 'Could not parse file'}
                      {' · '}
                      <span className="text-slate-500">v{detectedVersion}</span>
                    </p>
                  </div>
                  <button
                    onClick={clearPosesFile}
                    className="text-slate-500 hover:text-slate-300 text-xs shrink-0 mt-0.5"
                  >
                    remove
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Action buttons */}
          {parsedLabels ? (
            <div className="space-y-2">
              <button
                onClick={() => handleStart(parsedLabels)}
                className="w-full bg-green-700 hover:bg-green-600 text-white font-medium py-2.5 rounded-lg transition-colors"
              >
                Start with {frameCount} loaded frame{frameCount !== 1 ? 's' : ''}
              </button>
              <button
                onClick={() => handleStart(undefined)}
                className="w-full bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm font-medium py-2 rounded-lg transition-colors"
              >
                Start fresh instead
              </button>
            </div>
          ) : (
            <button
              onClick={() => handleStart(undefined)}
              className="w-full bg-green-700 hover:bg-green-600 text-white font-medium py-2.5 rounded-lg transition-colors"
            >
              Start Labelling
            </button>
          )}
        </div>
      )}
    </div>
  )
}
