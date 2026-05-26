import { useState } from 'react'
import type { AppStep, KeypointsMap, VideoMeta } from './types.ts'
import LoadStep from './components/LoadStep.tsx'
import LabelStep from './components/LabelStep.tsx'

export default function App() {
  const [step, setStep] = useState<AppStep>('load')
  const [meta, setMeta] = useState<VideoMeta | null>(null)
  const [initialLabels, setInitialLabels] = useState<Map<number, KeypointsMap> | undefined>(undefined)

  const handleLoad = (newMeta: VideoMeta, labels?: Map<number, KeypointsMap>) => {
    setMeta(newMeta)
    setInitialLabels(labels)
    setStep('label')
  }

  return (
    <div className="h-screen bg-slate-900 text-slate-100 flex flex-col overflow-hidden">
      <header className="flex items-center px-4 py-3 bg-slate-800 border-b border-slate-700 shrink-0">
        <span className="text-lg font-semibold tracking-tight">Pose Labeller</span>
        {step === 'label' && meta && (
          <span className="ml-3 text-sm text-slate-400 truncate">{meta.file.name}</span>
        )}
      </header>

      <main className="flex-1 flex flex-col min-h-0">
        {step === 'load' && <LoadStep onLoad={handleLoad} />}
        {step === 'label' && meta && <LabelStep meta={meta} initialLabels={initialLabels} />}
      </main>
    </div>
  )
}
