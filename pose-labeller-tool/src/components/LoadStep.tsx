import { useRef, useState } from 'react'
import type { VideoMeta } from '../types.ts'

interface Props {
  onLoad: (meta: VideoMeta) => void
}

export default function LoadStep({ onLoad }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [fps, setFps] = useState(30)
  const [videoDims, setVideoDims] = useState<{ width: number; height: number; duration: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

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

  const handleStart = () => {
    if (!file || !videoDims) return
    const frameCount = Math.floor(videoDims.duration * fps)
    onLoad({ file, fps, frameCount, width: videoDims.width, height: videoDims.height, duration: videoDims.duration })
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

          <button
            onClick={handleStart}
            className="w-full bg-green-700 hover:bg-green-600 text-white font-medium py-2.5 rounded-lg transition-colors"
          >
            Start Labelling
          </button>
        </div>
      )}
    </div>
  )
}
