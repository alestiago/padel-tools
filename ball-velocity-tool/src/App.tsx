import { useState } from 'react'
import type { AnalysisConfig, AppStep, FrameResult, HomographyJson } from './types.ts'
import StepIndicator from './components/StepIndicator.tsx'
import LoadStep      from './components/LoadStep.tsx'
import AnalyzeStep   from './components/AnalyzeStep.tsx'
import ResultsStep   from './components/ResultsStep.tsx'

const STEP_INDEX: Record<AppStep, number> = { load: 0, analyze: 1, results: 2 }

export default function App() {
  const [step, setStep]             = useState<AppStep>('load')
  const [videoFile, setVideoFile]   = useState<File | null>(null)
  const [homography, setHomography] = useState<HomographyJson | null>(null)
  const [results, setResults]       = useState<FrameResult[]>([])
  const [config, setConfig]         = useState<AnalysisConfig | null>(null)

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      <header className="border-b border-slate-800 px-6 py-4 flex items-center gap-3">
        <span className="text-2xl">🎾</span>
        <div>
          <h1 className="text-base font-semibold text-green-400 leading-none">PadelTools</h1>
          <p className="text-xs text-slate-500 mt-0.5">Ball velocity analyser</p>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 pt-6 pb-16">
        <StepIndicator current={STEP_INDEX[step]} />

        {step === 'load' && (
          <LoadStep
            onReady={(video, hom) => {
              setVideoFile(video)
              setHomography(hom)
              setStep('analyze')
            }}
          />
        )}

        {step === 'analyze' && videoFile && homography && (
          <AnalyzeStep
            videoFile={videoFile}
            homography={homography}
            onDone={(res, cfg) => {
              setResults(res)
              setConfig(cfg)
              setStep('results')
            }}
            onBack={() => setStep('load')}
          />
        )}

        {step === 'results' && videoFile && homography && config && (
          <ResultsStep
            videoFile={videoFile}
            homography={homography}
            results={results}
            config={config}
            onBack={() => setStep('analyze')}
          />
        )}
      </div>
    </div>
  )
}
