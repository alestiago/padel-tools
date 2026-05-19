import { useState } from 'react'
import type { AppStep, LabelRecord, VideoMeta } from './types.ts'
import LoadStep from './components/LoadStep.tsx'
import LabelStep from './components/LabelStep.tsx'
import ExportStep from './components/ExportStep.tsx'

export default function App() {
  const [step, setStep] = useState<AppStep>('load')
  const [meta, setMeta] = useState<VideoMeta | null>(null)
  const [labels, setLabels] = useState<Map<number, LabelRecord>>(new Map())

  const handleLoad = (newMeta: VideoMeta, savedLabels?: LabelRecord[]) => {
    setMeta(newMeta)
    if (savedLabels && savedLabels.length > 0) {
      const map = new Map<number, LabelRecord>()
      for (const r of savedLabels) map.set(r.frame, r)
      setLabels(map)
    } else {
      setLabels(new Map())
    }
    setStep('label')
  }

  const handleLabelsChange = (next: Map<number, LabelRecord>) => {
    setLabels(next)
  }

  const handleExport = () => {
    setStep('export')
  }

  const handleBack = () => {
    setStep('label')
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
      <header className="flex items-center gap-3 px-4 py-3 bg-slate-800 border-b border-slate-700 shrink-0">
        <span className="text-lg font-semibold tracking-tight">Ball Labeller</span>
      </header>

      <main className="flex-1 flex flex-col min-h-0">
        {step === 'load' && (
          <LoadStep onLoad={handleLoad} />
        )}
        {step === 'label' && meta && (
          <LabelStep
            meta={meta}
            labels={labels}
            onChange={handleLabelsChange}
            onExport={handleExport}
          />
        )}
        {step === 'export' && meta && (
          <ExportStep
            meta={meta}
            labels={labels}
            onBack={handleBack}
          />
        )}
      </main>
    </div>
  )
}
