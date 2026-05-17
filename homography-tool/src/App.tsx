import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppStep, CapturedFrame, HomographyResult, MarkedPoint } from './types'
import StepIndicator from './components/StepIndicator'
import VideoLoader from './components/VideoLoader'
import FramePicker from './components/FramePicker'
import AnnotationTool from './components/AnnotationTool'
import ValidationView from './components/ValidationView'

const STEPS: AppStep[] = ['load', 'pick-frame', 'annotate', 'validate']

export default function App() {
  const { t, i18n } = useTranslation()
  const [step, setStep]     = useState<AppStep>('load')
  const [videoFile, setVideoFile]   = useState<File | null>(null)
  const [frame, setFrame]           = useState<CapturedFrame | null>(null)
  const [points, setPoints]         = useState<MarkedPoint[]>([])
  const [result, setResult]         = useState<HomographyResult | null>(null)

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      <header className="border-b border-slate-800 px-6 py-4 flex items-center gap-3">
        <span className="text-2xl">🎾</span>
        <div className="flex-1">
          <h1 className="text-base font-semibold text-green-400 leading-none">{t('app.title')}</h1>
          <p className="text-xs text-slate-500 mt-0.5">{t('app.subtitle')}</p>
        </div>
        <button
          onClick={() => i18n.changeLanguage(i18n.language.startsWith('en') ? 'es' : 'en')}
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors px-2 py-1 rounded border border-slate-700 hover:border-slate-500"
        >
          {i18n.language.startsWith('en') ? 'ES' : 'EN'}
        </button>
      </header>

      <div className="max-w-6xl mx-auto px-6 pt-6">
        <StepIndicator current={STEPS.indexOf(step)} />

        {step === 'load' && (
          <VideoLoader
            onFile={f => { setVideoFile(f); setStep('pick-frame') }}
          />
        )}

        {step === 'pick-frame' && videoFile && (
          <FramePicker
            file={videoFile}
            onCapture={f => { setFrame(f); setPoints([]); setStep('annotate') }}
            onBack={() => setStep('load')}
          />
        )}

        {step === 'annotate' && frame && (
          <AnnotationTool
            frame={frame}
            points={points}
            onChange={setPoints}
            onCompute={r => { setResult(r); setStep('validate') }}
            onBack={() => setStep('pick-frame')}
          />
        )}

        {step === 'validate' && frame && result && (
          <ValidationView
            frame={frame}
            points={points}
            result={result}
            onBack={() => setStep('annotate')}
          />
        )}
      </div>
    </div>
  )
}
