import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  onFile: (file: File) => void
}

export default function VideoLoader({ onFile }: Props) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const accept = (file: File) => {
    if (!file.type.startsWith('video/') && !file.name.match(/\.(mov|mp4|webm|avi|mkv)$/i)) return
    onFile(file)
  }

  return (
    <div
      className={[
        'flex flex-col items-center justify-center rounded-2xl border-2 border-dashed transition-colors cursor-pointer',
        'h-72 max-w-xl mx-auto mt-10',
        dragging
          ? 'border-green-400 bg-green-400/10'
          : 'border-slate-600 bg-slate-800/50 hover:border-slate-500',
      ].join(' ')}
      onClick={() => inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        e.preventDefault()
        setDragging(false)
        const file = e.dataTransfer.files[0]
        if (file) accept(file)
      }}
    >
      <div className="text-5xl mb-4">🎾</div>
      <p className="text-slate-200 font-medium text-lg">{t('videoLoader.dragPrompt')}</p>
      <p className="text-slate-500 text-sm mt-1">{t('videoLoader.clickPrompt')}</p>
      <p className="text-slate-600 text-xs mt-3">{t('videoLoader.formats')}</p>
      <input
        ref={inputRef}
        type="file"
        accept="video/*,.mov"
        className="hidden"
        onChange={e => e.target.files?.[0] && accept(e.target.files[0])}
      />
    </div>
  )
}
