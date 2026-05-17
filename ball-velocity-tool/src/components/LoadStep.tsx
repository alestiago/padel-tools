import { useRef, useState } from 'react'
import type { HomographyJson } from '../types.ts'

interface Props {
  onReady: (video: File, homography: HomographyJson) => void
}

export default function LoadStep({ onReady }: Props) {
  const [videoFile, setVideoFile]       = useState<File | null>(null)
  const [homography, setHomography]     = useState<HomographyJson | null>(null)
  const [jsonError, setJsonError]       = useState<string | null>(null)

  const videoInputRef = useRef<HTMLInputElement>(null)
  const jsonInputRef  = useRef<HTMLInputElement>(null)

  function acceptVideo(file: File) {
    if (!file.type.startsWith('video/') && !file.name.match(/\.(mov|mp4|webm|avi|mkv)$/i)) return
    setVideoFile(file)
  }

  async function acceptJson(file: File) {
    setJsonError(null)
    try {
      const text = await file.text()
      const json = JSON.parse(text) as HomographyJson
      if (!json.H || !json.frame_size) throw new Error('Missing H or frame_size')
      setHomography(json)
    } catch {
      setJsonError('Invalid homography JSON — export it from the homography-tool.')
    }
  }

  return (
    <div className="mt-8 max-w-3xl mx-auto space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <DropZone
          icon="🎾"
          label="Padel video"
          hint="MP4 · MOV · WebM"
          accept="video/*,.mov"
          file={videoFile}
          fileName={videoFile?.name ?? null}
          inputRef={videoInputRef}
          onFile={acceptVideo}
        />
        <DropZone
          icon="📋"
          label="Homography JSON"
          hint="Exported from homography-tool"
          accept=".json,application/json"
          file={null}
          fileName={homography ? (homography.video_file ?? 'homography.json') : null}
          inputRef={jsonInputRef}
          onFile={acceptJson}
          error={jsonError ?? undefined}
        />
      </div>

      {homography && (
        <div className="bg-slate-800/60 rounded-xl p-4 text-xs text-slate-400 space-y-1">
          <p><span className="text-slate-300 font-medium">Calibrated for:</span> {homography.video_file}</p>
          <p>
            <span className="text-slate-300 font-medium">Resolution:</span>{' '}
            {homography.frame_size.width} × {homography.frame_size.height} px
          </p>
          <p>
            <span className="text-slate-300 font-medium">Reprojection error:</span>{' '}
            {(homography.reprojection_error_m * 100).toFixed(1)} cm
          </p>
        </div>
      )}

      <div className="flex justify-end">
        <button
          disabled={!videoFile || !homography}
          onClick={() => videoFile && homography && onReady(videoFile, homography)}
          className={[
            'px-6 py-2.5 rounded-xl font-medium text-sm transition-colors',
            videoFile && homography
              ? 'bg-green-500 hover:bg-green-400 text-slate-900 cursor-pointer'
              : 'bg-slate-700 text-slate-500 cursor-not-allowed',
          ].join(' ')}
        >
          Analyse →
        </button>
      </div>
    </div>
  )
}

// ── Internal drop-zone component ──────────────────────────────────────────────

interface DropZoneProps {
  icon: string
  label: string
  hint: string
  accept: string
  file: File | null
  fileName: string | null
  inputRef: React.RefObject<HTMLInputElement | null>
  onFile: (f: File) => void
  error?: string
}

function DropZone({ icon, label, hint, accept, fileName, inputRef, onFile, error }: DropZoneProps) {
  const [dragging, setDragging] = useState(false)
  const loaded = fileName !== null && !error

  return (
    <div
      className={[
        'flex flex-col items-center justify-center rounded-2xl border-2 border-dashed transition-colors cursor-pointer h-52',
        dragging        ? 'border-green-400 bg-green-400/10' : '',
        loaded          ? 'border-green-600 bg-green-900/20' : '',
        error           ? 'border-red-500 bg-red-900/10'    : '',
        !dragging && !loaded && !error ? 'border-slate-600 bg-slate-800/50 hover:border-slate-500' : '',
      ].join(' ')}
      onClick={() => inputRef.current?.click()}
      onDragOver={e  => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer.files[0]
        if (f) onFile(f)
      }}
    >
      <div className="text-4xl mb-3">{loaded ? '✅' : icon}</div>
      <p className="text-sm font-medium text-slate-200">{label}</p>
      {loaded
        ? <p className="text-xs text-green-400 mt-1 px-4 text-center truncate max-w-full">{fileName}</p>
        : <p className="text-xs text-slate-500 mt-1">{hint}</p>
      }
      {error && <p className="text-xs text-red-400 mt-2 px-4 text-center">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={e => e.target.files?.[0] && onFile(e.target.files[0])}
      />
    </div>
  )
}
