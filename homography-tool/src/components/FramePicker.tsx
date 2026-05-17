import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CapturedFrame } from '../types'

interface Props {
  file: File
  onCapture: (frame: CapturedFrame) => void
  onBack: () => void
}

function fmt(s: number) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export default function FramePicker({ file, onCapture, onBack }: Props) {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [duration, setDuration]       = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [ready, setReady]             = useState(false)

  useEffect(() => {
    const video = videoRef.current!
    const url = URL.createObjectURL(file)
    video.src = url
    video.load()

    const onMeta = () => { setDuration(video.duration); setReady(true) }
    const onTime = () => setCurrentTime(video.currentTime)
    video.addEventListener('loadedmetadata', onMeta)
    video.addEventListener('timeupdate', onTime)
    return () => {
      video.removeEventListener('loadedmetadata', onMeta)
      video.removeEventListener('timeupdate', onTime)
      URL.revokeObjectURL(url)
    }
  }, [file])

  const seek = (time: number) => {
    videoRef.current!.currentTime = time
  }

  const capture = () => {
    const video = videoRef.current!
    const canvas = document.createElement('canvas')
    canvas.width  = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')!.drawImage(video, 0, 0)
    onCapture({
      dataUrl: canvas.toDataURL('image/jpeg', 0.92),
      width: canvas.width,
      height: canvas.height,
      videoFileName: file.name,
      timestampS: video.currentTime,
    })
  }

  return (
    <div className="max-w-3xl mx-auto mt-6 space-y-4">
      <p className="text-slate-400 text-sm">{t('framePicker.hint')}</p>

      <div className="bg-slate-800 rounded-xl overflow-hidden">
        <video
          ref={videoRef}
          className="w-full max-h-[55vh] object-contain bg-black"
          muted
          playsInline
        />
      </div>

      <div className="space-y-2">
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.033}
          value={currentTime}
          disabled={!ready}
          onChange={e => seek(parseFloat(e.target.value))}
          className="w-full accent-green-400 cursor-pointer"
        />
        <div className="flex justify-between text-xs text-slate-500">
          <span>{fmt(currentTime)}</span>
          <span>{fmt(duration)}</span>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          onClick={onBack}
          className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm transition-colors"
        >
          {t('framePicker.back')}
        </button>
        <button
          onClick={capture}
          disabled={!ready}
          className="flex-1 py-2 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-900 font-semibold text-sm transition-colors"
        >
          {t('framePicker.capture')}
        </button>
      </div>
    </div>
  )
}
