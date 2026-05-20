import { useRef, useState } from 'react'
import type { LabelRecord, ReviewTarget, VideoMeta } from '../types.ts'
import { buildReviewQueue } from '../lib/buildReviewQueue.ts'
import { detectVersion, parseLabelsFile, type LabelVersion } from '../lib/parseLabels.ts'

interface Props {
  onStart: (meta: VideoMeta, labels: Map<number, LabelRecord>, queue: ReviewTarget[]) => void
}

export default function LoadScreen({ onStart }: Props) {
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [videoDims, setVideoDims] = useState<{ width: number; height: number; duration: number } | null>(null)
  const [videoDragging, setVideoDragging] = useState(false)
  const [fps, setFps] = useState(30)

  const [labelsFile, setLabelsFile] = useState<File | null>(null)
  const [parsedLabels, setParsedLabels] = useState<LabelRecord[] | null>(null)
  const [detectedVersion, setDetectedVersion] = useState<LabelVersion>(0)
  const [versionOverride, setVersionOverride] = useState<LabelVersion | null>(null)
  const [labelsDragging, setLabelsDragging] = useState(false)

  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null)
  const videoInputRef = useRef<HTMLInputElement | null>(null)
  const labelsInputRef = useRef<HTMLInputElement | null>(null)

  const loadVideo = (f: File) => {
    setVideoFile(f)
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

  const loadLabels = async (f: File, version?: LabelVersion) => {
    const text = await f.text()
    const detected = version ?? detectVersion(text, f.name)
    if (version === undefined) {
      setDetectedVersion(detected)
      setVersionOverride(null)
    }
    const result = await parseLabelsFile(f, detected)
    setParsedLabels(result.labels)
    if (result.fps) setFps(result.fps)
  }

  const handleVideoDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setVideoDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (f) loadVideo(f)
  }

  const handleLabelsDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setLabelsDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (!f) return
    setLabelsFile(f)
    await loadLabels(f)
  }

  const handleVersionChange = async (v: LabelVersion) => {
    setVersionOverride(v)
    if (labelsFile) await loadLabels(labelsFile, v)
  }

  const effectiveVersion: LabelVersion = versionOverride ?? detectedVersion

  const unlabelledCount = parsedLabels
    ? parsedLabels.filter((r) => r.impact === 'racket' && r.shot_type === null).length
    : 0

  const canStart = videoFile !== null && videoDims !== null && parsedLabels !== null && unlabelledCount > 0

  const handleStart = () => {
    if (!videoFile || !videoDims || !parsedLabels) return
    const frameCount = Math.floor(videoDims.duration * fps)
    const meta: VideoMeta = {
      file: videoFile,
      fps,
      frameCount,
      width: videoDims.width,
      height: videoDims.height,
      duration: videoDims.duration,
    }
    const labelsMap = new Map<number, LabelRecord>()
    for (const r of parsedLabels) labelsMap.set(r.frame, r)
    const queue = buildReviewQueue(labelsMap, frameCount)
    onStart(meta, labelsMap, queue)
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-2">Shot Labeller</h1>
        <p className="text-slate-400 text-sm">Load a video and a labels file to review unlabelled racket contacts</p>
      </div>

      <div className="w-full max-w-lg space-y-4">
        {/* Video drop zone */}
        <div>
          <p className="text-xs text-slate-400 uppercase tracking-wide font-medium mb-2">Video</p>
          <div
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
              videoDragging ? 'border-blue-400 bg-blue-950/30' : 'border-slate-600 hover:border-slate-400'
            }`}
            onDragOver={(e) => { e.preventDefault(); setVideoDragging(true) }}
            onDragLeave={() => setVideoDragging(false)}
            onDrop={handleVideoDrop}
            onClick={() => videoInputRef.current?.click()}
          >
            <input
              ref={videoInputRef}
              type="file"
              accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) loadVideo(f) }}
            />
            {videoFile ? (
              <div>
                <p className="text-slate-200 font-medium truncate">{videoFile.name}</p>
                {videoDims && (
                  <p className="text-slate-400 text-sm mt-1">
                    {videoDims.width}×{videoDims.height} · {videoDims.duration.toFixed(1)}s
                  </p>
                )}
              </div>
            ) : (
              <div>
                <p className="text-slate-300 font-medium">Drop a video file here</p>
                <p className="text-slate-400 text-sm mt-1">or click to browse</p>
                <p className="text-slate-500 text-xs mt-2">.mp4 .mov .webm</p>
              </div>
            )}
          </div>
        </div>

        {/* FPS input (shown once video is loaded) */}
        {videoDims && (
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
        )}

        {/* Labels drop zone */}
        <div>
          <p className="text-xs text-slate-400 uppercase tracking-wide font-medium mb-2">Labels file</p>
          {!labelsFile ? (
            <div
              className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                labelsDragging ? 'border-green-400 bg-green-950/30' : 'border-slate-600 hover:border-slate-400'
              }`}
              onDragOver={(e) => { e.preventDefault(); setLabelsDragging(true) }}
              onDragLeave={() => setLabelsDragging(false)}
              onDrop={handleLabelsDrop}
              onClick={() => labelsInputRef.current?.click()}
            >
              <input
                ref={labelsInputRef}
                type="file"
                accept=".csv,.json"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  setLabelsFile(f)
                  await loadLabels(f)
                }}
              />
              <p className="text-slate-300 font-medium">Drop a labels CSV or JSON here</p>
              <p className="text-slate-400 text-sm mt-1">or click to browse</p>
              <p className="text-slate-500 text-xs mt-2">.csv .json (ball-labeller export)</p>
            </div>
          ) : (
            <div className="bg-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-slate-200 font-medium truncate">{labelsFile.name}</p>
                  {parsedLabels !== null && (
                    <p className="text-slate-400 text-sm mt-0.5">
                      {parsedLabels.length} labels · {unlabelledCount} unlabelled racket contacts
                    </p>
                  )}
                </div>
                <button
                  onClick={() => {
                    setLabelsFile(null)
                    setParsedLabels(null)
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
                  {([0, 1, 2, 3] as LabelVersion[]).map((v) => (
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
              {unlabelledCount === 0 && parsedLabels !== null && (
                <p className="text-amber-400 text-xs">
                  No unlabelled racket contacts found. All shots may already be labelled.
                </p>
              )}
            </div>
          )}
        </div>

        <button
          onClick={handleStart}
          disabled={!canStart}
          className="w-full bg-green-700 hover:bg-green-600 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-medium py-3 rounded-xl transition-colors"
        >
          {canStart
            ? `Review ${unlabelledCount} unlabelled shot${unlabelledCount === 1 ? '' : 's'}`
            : 'Load video and labels to continue'}
        </button>
      </div>
    </div>
  )
}
