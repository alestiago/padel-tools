import { useState } from 'react'
import type { AppStep, LabelRecord, ReviewTarget, VideoMeta } from './types.ts'
import LoadScreen from './components/LoadScreen.tsx'
import ReviewScreen from './components/ReviewScreen.tsx'
import DoneScreen from './components/DoneScreen.tsx'

interface Session {
  meta: VideoMeta
  labels: Map<number, LabelRecord>
  queue: ReviewTarget[]
  skipped: ReviewTarget[]
}

export default function App() {
  const [step, setStep] = useState<AppStep>('load')
  const [session, setSession] = useState<Session | null>(null)

  const handleStart = (
    meta: VideoMeta,
    labels: Map<number, LabelRecord>,
    queue: ReviewTarget[],
  ) => {
    setSession({ meta, labels, queue, skipped: [] })
    setStep('review')
  }

  const handleReviewDone = (labels: Map<number, LabelRecord>, skipped: ReviewTarget[]) => {
    setSession((prev) => prev ? { ...prev, labels, skipped } : prev)
    setStep('done')
  }

  const handleReviewSkipped = (skippedQueue: ReviewTarget[]) => {
    setSession((prev) => prev ? { ...prev, queue: skippedQueue, skipped: [] } : prev)
    setStep('review')
  }

  return (
    <div className="h-screen bg-slate-900 text-slate-100 flex flex-col overflow-hidden">
      <header className="flex items-center px-4 py-3 bg-slate-800 border-b border-slate-700 shrink-0">
        <button
          onClick={() => setStep('load')}
          className="text-lg font-semibold tracking-tight hover:text-slate-300 transition-colors"
        >
          Shot Labeller
        </button>
        {step !== 'load' && session && (
          <span className="ml-3 text-sm text-slate-500 truncate">{session.meta.file.name}</span>
        )}
      </header>

      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {step === 'load' && <LoadScreen onStart={handleStart} />}

        {step === 'review' && session && (
          <ReviewScreen
            key={session.queue[0]?.frame ?? 'review'}
            meta={session.meta}
            queue={session.queue}
            initialLabels={session.labels}
            onDone={handleReviewDone}
          />
        )}

        {step === 'done' && session && (
          <DoneScreen
            meta={session.meta}
            labels={session.labels}
            queue={session.queue}
            skipped={session.skipped}
            onReviewSkipped={handleReviewSkipped}
          />
        )}
      </main>
    </div>
  )
}
