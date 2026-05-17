import { useTranslation } from 'react-i18next'

export default function StepIndicator({ current }: { current: number }) {
  const { t } = useTranslation()
  const STEPS = [
    t('steps.load'),
    t('steps.pickFrame'),
    t('steps.annotate'),
    t('steps.validate'),
  ]

  return (
    <div className="flex items-center gap-0 mb-6">
      {STEPS.map((label, i) => {
        const done    = i < current
        const active  = i === current
        const last    = i === STEPS.length - 1
        return (
          <div key={i} className="flex items-center">
            <div className="flex items-center gap-2">
              <div
                className={[
                  'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0',
                  done   ? 'bg-green-500 text-white' : '',
                  active ? 'bg-green-400 text-slate-900 ring-2 ring-green-400 ring-offset-2 ring-offset-slate-900' : '',
                  !done && !active ? 'bg-slate-700 text-slate-400' : '',
                ].join(' ')}
              >
                {done ? '✓' : i + 1}
              </div>
              <span className={[
                'text-sm whitespace-nowrap',
                active ? 'text-slate-100 font-medium' : 'text-slate-500',
              ].join(' ')}>
                {label}
              </span>
            </div>
            {!last && (
              <div className={[
                'w-10 h-px mx-3 shrink-0',
                done ? 'bg-green-500' : 'bg-slate-700',
              ].join(' ')} />
            )}
          </div>
        )
      })}
    </div>
  )
}
