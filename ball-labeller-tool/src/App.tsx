import { useRef, useState } from 'react'
import type { AppStep, LabelRecord, VideoMeta } from './types.ts'
import LoadStep from './components/LoadStep.tsx'
import LabelStep from './components/LabelStep.tsx'
import ExportStep from './components/ExportStep.tsx'

export default function App() {
  const [step, setStep] = useState<AppStep>('load')
  const [meta, setMeta] = useState<VideoMeta | null>(null)
  const [labels, setLabels] = useState<Map<number, LabelRecord>>(new Map())

  const importInputRef = useRef<HTMLInputElement | null>(null)

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

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string)
        const incoming: LabelRecord[] = Array.isArray(data.labels) ? data.labels : []
        const next = new Map(labels)
        for (const r of incoming) next.set(r.frame, r)
        setLabels(next)
      } catch {
        // ignore parse errors
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleExport = () => setStep('export')
  const handleBack = () => setStep('label')

  return (
    <div className="h-screen bg-slate-900 text-slate-100 flex flex-col overflow-hidden">
      <header className="flex items-center px-4 py-3 bg-slate-800 border-b border-slate-700 shrink-0">
        <span className="text-lg font-semibold tracking-tight flex-1">Ball Labeller</span>

        {step === 'label' && (
          <div className="flex items-center gap-2">
            <input
              ref={importInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleImport}
            />
            <button
              onClick={() => importInputRef.current?.click()}
              className="text-sm px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium transition-colors"
            >
              Import JSON
            </button>
            <button
              onClick={handleExport}
              className="text-sm px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white font-medium transition-colors"
            >
              Export
            </button>
          </div>
        )}
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
