import { useRef, useState } from 'react'
import type { LabelRecord, VideoMeta } from '../types.ts'
import { loadLabels } from '../lib/labelStore.ts'
import { detectVersion, parseLabelsFile, type LabelVersion } from '../lib/parseLabels.ts'

interface Props {
  onLoad: (meta: VideoMeta, savedLabels?: LabelRecord[]) => void
}

export default function LoadStep({ onLoad }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [fps, setFps] = useState(30)
  const [videoDims, setVideoDims] = useState<{ width: number; height: number; duration: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [savedSession, setSavedSession] = useState<{ labels: LabelRecord[]; fps: number } | null>(null)

  const [labelsFile, setLabelsFile] = useState<File | null>(null)
  const [detectedVersion, setDetectedVersion] = useState<LabelVersion>(0)
  const [versionOverride, setVersionOverride] = useState<LabelVersion | null>(null)
  const [preloadedLabels, setPreloadedLabels] = useState<LabelRecord[] | null>(null)

  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const labelsInputRef = useRef<HTMLInputElement | null>(null)

  const processFile = (f: File) => {
    setFile(f)
    setVideoDims(null)
    setSavedSession(null)

    const saved = loadLabels(f.name)
    if (saved && saved.labels.length > 0) {
      setSavedSession(saved)
      setFps(saved.fps)
    }

    const url = URL.createObjectURL(f)
    if (!hiddenVideoRef.current) {
      hiddenVideoRef.current = document.createElement('video')
    }
    const video = hiddenVideoRef.current
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      setVideoDims({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
      })
      URL.revokeObjectURL(url)
    }
    video.src = url
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) processFile(f)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (f) processFile(f)
  }

  const handleLabelsFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const text = await f.text()
    const detected = detectVersion(text, f.name)
    setLabelsFile(f)
    setDetectedVersion(detected)
    setVersionOverride(null)
    const result = await parseLabelsFile(f, detected)
    setPreloadedLabels(result.labels)
    if (result.fps) setFps(result.fps)
  }

  const handleVersionChange = async (v: LabelVersion) => {
    setVersionOverride(v)
    if (labelsFile) {
      const result = await parseLabelsFile(labelsFile, v)
      setPreloadedLabels(result.labels)
    }
  }

  const effectiveVersion: LabelVersion = versionOverride ?? detectedVersion

  const handleStart = (labels?: LabelRecord[]) => {
    if (!file || !videoDims) return
    const frameCount = Math.floor(videoDims.duration * fps)
    const meta: VideoMeta = {
      file,
      fps,
      frameCount,
      width: videoDims.width,
      height: videoDims.height,
      duration: videoDims.duration,
    }
    onLoad(meta, labels)
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-8 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-2">Load Video</h1>
        <p className="text-slate-400 text-sm">Select a padel match video to start labelling ball positions</p>
      </div>

      {/* Drop zone */}
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
          onChange={handleFileInput}
        />
        {file ? (
          <div>
            <p className="text-slate-200 font-medium truncate">{file.name}</p>
            <p className="text-slate-400 text-sm mt-1">
              {(file.size / (1024 * 1024)).toFixed(1)} MB
            </p>
          </div>
        ) : (
          <div>
            <p className="text-slate-300 font-medium">Drop a video file here</p>
            <p className="text-slate-400 text-sm mt-1">or click to browse</p>
            <p className="text-slate-500 text-xs mt-2">.mp4 .mov .webm</p>
          </div>
        )}
      </div>

      {/* Video metadata */}
      {videoDims && (
        <div className="w-full max-w-lg bg-slate-800 rounded-xl p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-slate-400">Resolution</span>
              <p className="text-slate-100 font-medium">{videoDims.width} x {videoDims.height}</p>
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
            <span className="text-slate-500 text-sm">
              = {Math.floor(videoDims.duration * fps)} frames
            </span>
          </div>

          {/* Pre-load labels section */}
          <div className="border-t border-slate-700 pt-3 space-y-2">
            <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Pre-load labels (optional)</p>
            <input
              ref={labelsInputRef}
              type="file"
              accept=".csv,.json"
              className="hidden"
              onChange={handleLabelsFileInput}
            />
            {!labelsFile ? (
              <button
                onClick={() => labelsInputRef.current?.click()}
                className="w-full border border-dashed border-slate-600 hover:border-slate-400 text-slate-400 hover:text-slate-200 text-sm py-2 rounded-lg transition-colors"
              >
                Load existing labels CSV / JSON
              </button>
            ) : (
              <div className="bg-slate-700 rounded-lg p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-slate-200 text-sm font-medium truncate">{labelsFile.name}</p>
                    <p className="text-slate-400 text-xs mt-0.5">{preloadedLabels?.length ?? 0} labels loaded</p>
                  </div>
                  <button
                    onClick={() => {
                      setLabelsFile(null)
                      setPreloadedLabels(null)
                      setVersionOverride(null)
                      if (labelsInputRef.current) labelsInputRef.current.value = ''
                    }}
                    className="text-slate-500 hover:text-slate-300 text-xs shrink-0 mt-0.5"
                  >
                    remove
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">Version:</span>
                  <span className="text-xs text-slate-500">detected v{detectedVersion}</span>
                  <div className="flex gap-1 ml-auto">
                    {([0, 1] as LabelVersion[]).map((v) => (
                      <button
                        key={v}
                        onClick={() => handleVersionChange(v)}
                        className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                          effectiveVersion === v
                            ? 'bg-blue-600 text-white'
                            : 'bg-slate-600 text-slate-300 hover:bg-slate-500'
                        }`}
                      >
                        v{v}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Action buttons */}
          {preloadedLabels ? (
            <div className="space-y-2">
              <button
                onClick={() => handleStart(preloadedLabels)}
                className="w-full bg-green-700 hover:bg-green-600 text-white font-medium py-2.5 rounded-lg transition-colors"
              >
                Start with {preloadedLabels.length} loaded labels
              </button>
              <button
                onClick={() => handleStart(undefined)}
                className="w-full bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm font-medium py-2 rounded-lg transition-colors"
              >
                Start fresh instead
              </button>
            </div>
          ) : savedSession ? (
            <div className="bg-blue-950/50 border border-blue-800 rounded-lg p-3">
              <p className="text-blue-300 text-sm font-medium">
                Previous session found: {savedSession.labels.length} labels
              </p>
              <p className="text-blue-400 text-xs mt-0.5">
                Saved at {savedSession.fps} fps
              </p>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => handleStart(savedSession.labels)}
                  className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-3 py-2 rounded transition-colors"
                >
                  Restore {savedSession.labels.length} labels
                </button>
                <button
                  onClick={() => handleStart(undefined)}
                  className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium px-3 py-2 rounded transition-colors"
                >
                  Start fresh
                </button>
              </div>
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
