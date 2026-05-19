const LOUPE_RADIUS = 80   // CSS pixels
const ZOOM = 4
const MARGIN = 20         // gap between cursor bottom and loupe bottom edge
const EDGE_MARGIN = 8     // minimum distance from canvas edge

function crosshair(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number): void {
  ctx.beginPath()
  ctx.moveTo(cx - radius, cy)
  ctx.lineTo(cx + radius, cy)
  ctx.moveTo(cx, cy - radius)
  ctx.lineTo(cx, cy + radius)
  ctx.stroke()
}

export function drawLoupe(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  mouseDisplay: { x: number; y: number },
  mouseVideo: { x: number; y: number },
  videoScale: number,
  canvasW: number,
  _canvasH: number,
): void {
  if (video.readyState < 2) return

  const R = LOUPE_RADIUS
  // srcRadius in native video pixels = R / ZOOM / videoScale
  const srcRadius = R / ZOOM / videoScale
  if (srcRadius <= 0) return

  // Vertical placement: prefer above cursor, flip below if not enough room
  const lyAbove = mouseDisplay.y - R - MARGIN
  const flipped = lyAbove - R < EDGE_MARGIN
  const ly = flipped ? mouseDisplay.y + R + MARGIN : lyAbove

  // Horizontal: centre on cursor, clamped inside canvas
  const lx = Math.max(R + EDGE_MARGIN, Math.min(canvasW - R - EDGE_MARGIN, mouseDisplay.x))

  // Circular clip + magnified image
  ctx.save()
  ctx.beginPath()
  ctx.arc(lx, ly, R, 0, Math.PI * 2)
  ctx.clip()

  ctx.drawImage(
    video,
    mouseVideo.x - srcRadius,
    mouseVideo.y - srcRadius,
    srcRadius * 2,
    srcRadius * 2,
    lx - R,
    ly - R,
    R * 2,
    R * 2,
  )

  // Crosshair: dark shadow pass then bright pass for contrast
  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'
  crosshair(ctx, lx, ly, R)
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  crosshair(ctx, lx, ly, R)

  ctx.restore()

  // Outer ring
  ctx.save()
  ctx.beginPath()
  ctx.arc(lx, ly, R, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth = 2
  ctx.shadowColor = 'rgba(0,0,0,0.4)'
  ctx.shadowBlur = 6
  ctx.stroke()
  ctx.restore()

  // Coordinate label — below loupe when flipped, above when normal
  const labelY = flipped ? ly + R + 14 : ly - R - 4
  ctx.save()
  ctx.font = '10px monospace'
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  ctx.textAlign = 'center'
  ctx.textBaseline = flipped ? 'top' : 'bottom'
  ctx.shadowColor = 'rgba(0,0,0,0.8)'
  ctx.shadowBlur = 3
  ctx.fillText(`(${Math.round(mouseVideo.x)}, ${Math.round(mouseVideo.y)})`, lx, labelY)
  ctx.restore()

}
