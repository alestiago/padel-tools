import type { ImgPoint } from '../types'

const RADIUS_DISPLAY = 70  // px on screen
const ZOOM = 3
const MARGIN_DISPLAY = 20  // px on screen — gap between cursor and loupe bottom edge
const EDGE_MARGIN = 8      // px on screen — minimum distance from canvas edge

export function drawLoupe(
  ctx: CanvasRenderingContext2D,
  mouse: ImgPoint,
  source: HTMLImageElement,
  canvasW: number,
  _canvasH: number,
  scale: number,
): void {
  const R = RADIUS_DISPLAY * scale
  const gap = MARGIN_DISPLAY * scale
  const edge = EDGE_MARGIN * scale

  const srcRadius = R / ZOOM
  const srcSize = srcRadius * 2

  // Vertical: prefer above the cursor, flip below if not enough room
  const lyAbove = mouse.v - R - gap
  const flipped = lyAbove - R < edge
  const ly = flipped ? mouse.v + R + gap : lyAbove

  // Horizontal: centre on cursor, clamped so the circle stays inside the canvas
  const lx = Math.max(R + edge, Math.min(canvasW - R - edge, mouse.u))

  // Circular clip + magnified image
  ctx.save()
  ctx.beginPath()
  ctx.arc(lx, ly, R, 0, Math.PI * 2)
  ctx.clip()
  ctx.drawImage(source, mouse.u - srcRadius, mouse.v - srcRadius, srcSize, srcSize, lx - R, ly - R, R * 2, R * 2)

  // Crosshair: dark shadow pass then bright pass for contrast on any background
  ctx.lineWidth = 2 * scale
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'
  crosshair(ctx, lx, ly, R)
  ctx.lineWidth = scale
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  crosshair(ctx, lx, ly, R)

  ctx.restore()

  // Outer ring
  ctx.save()
  ctx.beginPath()
  ctx.arc(lx, ly, R, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth = 2 * scale
  ctx.shadowColor = 'rgba(0,0,0,0.4)'
  ctx.shadowBlur = 6 * scale
  ctx.stroke()
  ctx.restore()

  // Pixel-coordinate label — above the loupe when it sits over the cursor, below when flipped
  const labelY = flipped ? ly + R + 14 * scale : ly - R - 4 * scale
  ctx.save()
  ctx.font = `${Math.round(10 * scale)}px monospace`
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  ctx.textAlign = 'center'
  ctx.textBaseline = flipped ? 'top' : 'bottom'
  ctx.shadowColor = 'rgba(0,0,0,0.8)'
  ctx.shadowBlur = 3 * scale
  ctx.fillText(`(${Math.round(mouse.u)}, ${Math.round(mouse.v)})`, lx, labelY)
  ctx.restore()
}

function crosshair(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number): void {
  ctx.beginPath()
  ctx.moveTo(cx - radius, cy)
  ctx.lineTo(cx + radius, cy)
  ctx.moveTo(cx, cy - radius)
  ctx.lineTo(cx, cy + radius)
  ctx.stroke()
}
