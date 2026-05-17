import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { COURT_KEYPOINTS } from '../lib/courtKeypoints'
import { computeHomography, reprojectionError } from '../lib/homographyDLT'
import type { CapturedFrame, HomographyResult, ImaginarySegments, ImgPoint, MarkedPoint } from '../types'
import AnnotationCanvas from './AnnotationCanvas'
import CourtDiagram from './CourtDiagram'

interface Props {
  frame: CapturedFrame
  points: MarkedPoint[]
  onChange: (pts: MarkedPoint[]) => void
  onCompute: (result: HomographyResult) => void
  onBack: () => void
}

function errorBadgeCls(errM: number) {
  if (errM < 0.05) return 'bg-green-500/20 text-green-300 border-green-500/30'
  if (errM < 0.15) return 'bg-amber-500/20 text-amber-300 border-amber-500/30'
  return 'bg-red-500/20 text-red-300 border-red-500/30'
}

export default function AnnotationTool({ frame, points, onChange, onCompute, onBack }: Props) {
  const { t } = useTranslation()
  const [imaginaryMode, setImaginaryMode] = useState(false)

  const currentKeypoint = points.length < COURT_KEYPOINTS.length
    ? COURT_KEYPOINTS[points.length]
    : null

  const liveResult = useMemo(() => {
    if (points.length < 4) return null
    const imgPts  = points.map(p => [p.img.u, p.img.v] as [number, number])
    const realPts = points.map(p => {
      const kp = COURT_KEYPOINTS.find(k => k.id === p.keypointId)!
      return [kp.real.x, kp.real.y] as [number, number]
    })
    const H = computeHomography(imgPts, realPts)
    if (!H) return null
    return { H, reprojectionErrorM: reprojectionError(H, imgPts, realPts) }
  }, [points])

  const undo = () => {
    onChange(points.slice(0, -1))
    setImaginaryMode(false)
  }

  const placePoint = (img: ImgPoint, imaginary?: ImaginarySegments) => {
    if (!currentKeypoint) return
    onChange([...points, { keypointId: currentKeypoint.id, img, imaginary }])
    setImaginaryMode(false)
  }

  const movePoint = (keypointId: string, img: ImgPoint) => {
    onChange(points.map(p => p.keypointId === keypointId ? { ...p, img } : p))
  }

  const handleCompute = () => {
    if (liveResult) onCompute(liveResult)
  }

  const errM = liveResult?.reprojectionErrorM
  const badgeLabel = errM !== undefined ? `${(errM * 100).toFixed(1)} cm` : null
  const badgeCls   = errM !== undefined ? errorBadgeCls(errM) : null

  return (
    <div className="mt-4 space-y-3">
      {/* Info bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          {currentKeypoint ? (
            <span className="text-sm">
              <span className="text-slate-400">{t('annotationTool.marking')}</span>{' '}
              <span className="font-mono font-bold" style={{ color: currentKeypoint.color }}>
                {currentKeypoint.id}
              </span>{' '}
              <span className="text-slate-300">{t(currentKeypoint.labelKey)}</span>
              <span className="text-slate-500 ml-2">
                {t('annotationTool.markedCount', { done: points.length, total: COURT_KEYPOINTS.length })}
              </span>
              {imaginaryMode && (
                <span className="ml-2 text-amber-400 text-xs">{t('annotationTool.outOfFrameMode')}</span>
              )}
            </span>
          ) : (
            <span className="text-sm text-green-400 font-medium">
              {t('annotationTool.allMarked', { done: points.length, total: COURT_KEYPOINTS.length })}
            </span>
          )}
        </div>

        {badgeLabel && badgeCls && (
          <div className={`text-xs px-2 py-1 rounded-md border font-mono ${badgeCls}`}>
            {t('annotationTool.reprojError')} {badgeLabel}
          </div>
        )}

        {currentKeypoint && !imaginaryMode && (
          <button
            onClick={() => setImaginaryMode(true)}
            title={t('annotationTool.outOfFrameTip')}
            className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm transition-colors"
          >
            {t('annotationTool.outOfFrameBtn')}
          </button>
        )}

        {imaginaryMode && (
          <button
            onClick={() => setImaginaryMode(false)}
            className="px-3 py-1.5 rounded-lg bg-amber-800 hover:bg-amber-700 text-white text-sm transition-colors"
          >
            {t('annotationTool.cancel')}
          </button>
        )}

        <button
          onClick={undo}
          disabled={points.length === 0}
          className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-30 text-slate-200 text-sm transition-colors"
        >
          {t('annotationTool.undo')}
        </button>
        <button
          onClick={handleCompute}
          disabled={!liveResult}
          className="px-4 py-1.5 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-30 disabled:cursor-not-allowed text-slate-900 font-semibold text-sm transition-colors"
        >
          {t('annotationTool.validate')}
        </button>
      </div>

      {/* Main layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-4">
        <CourtDiagram
          points={points}
          currentKeypointId={currentKeypoint?.id ?? null}
        />

        <div className="space-y-2">
          <AnnotationCanvas
            frame={frame}
            points={points}
            currentKeypoint={currentKeypoint}
            imaginaryMode={imaginaryMode}
            onPointPlaced={placePoint}
            onPointMoved={movePoint}
            liveH={liveResult?.H ?? null}
          />
          <p className="text-xs text-slate-500">
            {t('annotationTool.hint')}
            {currentKeypoint && (
              <span>
                {' · '}
                {t('annotationTool.hintOutOfFrame')}{' '}
                <strong>{t('annotationTool.outOfFrameBtn')}</strong>
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="pt-1">
        <button
          onClick={onBack}
          className="text-sm text-slate-500 hover:text-slate-300 transition-colors"
        >
          {t('annotationTool.back')}
        </button>
      </div>
    </div>
  )
}
