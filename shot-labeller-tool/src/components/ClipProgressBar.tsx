interface Props {
  clipStart: number
  clipEnd: number
  targetFrame: number
  currentTime: number
  fps: number
  onSeek: (timeSec: number) => void
}

export default function ClipProgressBar({
  clipStart,
  clipEnd,
  targetFrame,
  currentTime,
  fps,
  onSeek,
}: Props) {
  const clipDuration = Math.max(1, clipEnd - clipStart)
  const progressFrac = Math.min(1, Math.max(0, (currentTime * fps - clipStart) / clipDuration))
  const targetFrac = Math.min(1, Math.max(0, (targetFrame - clipStart) / clipDuration))

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const frame = clipStart + frac * clipDuration
    onSeek(frame / fps)
  }

  return (
    <div
      className="h-3 bg-slate-700 cursor-pointer relative shrink-0"
      onClick={handleClick}
      title="Click to seek within clip"
    >
      {/* Filled progress */}
      <div
        className="h-full bg-blue-600 absolute top-0 left-0"
        style={{ width: `${progressFrac * 100}%` }}
      />
      {/* Target frame marker */}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-orange-400"
        style={{ left: `${targetFrac * 100}%` }}
        title={`Target frame ${targetFrame}`}
      />
    </div>
  )
}
