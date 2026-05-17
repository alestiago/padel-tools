import type { CourtKeypoint } from '../types'

// Standard padel court: 10 m wide × 20 m long
// Origin: back-left corner (camera-near side)
// x: 0–10 (width), y: 0–20 (length)
// Net at y = 10, service lines at y ≈ 3.05 and y ≈ 16.95
export const COURT_W = 10
export const COURT_L = 20
export const NET_Y = 10
export const SVC_Y_NEAR = 3.05
export const SVC_Y_FAR  = 16.95

const COLORS = [
  '#ef4444', // A – red
  '#f97316', // B – orange
  '#eab308', // C – yellow
  '#22c55e', // D – green
  '#06b6d4', // E – cyan
  '#3b82f6', // F – blue
  '#8b5cf6', // G – violet
  '#ec4899', // H – pink
]

const DEFS: Omit<CourtKeypoint, 'color'>[] = [
  { id: 'A', labelKey: 'courtKeypoints.A', real: { x: 0,  y: 0        } },
  { id: 'B', labelKey: 'courtKeypoints.B', real: { x: 10, y: 0        } },
  { id: 'C', labelKey: 'courtKeypoints.C', real: { x: 0,  y: 20       } },
  { id: 'D', labelKey: 'courtKeypoints.D', real: { x: 10, y: 20       } },
  { id: 'E', labelKey: 'courtKeypoints.E', real: { x: 0,  y: 10       } },
  { id: 'F', labelKey: 'courtKeypoints.F', real: { x: 10, y: 10       } },
  { id: 'G', labelKey: 'courtKeypoints.G', real: { x: 5,  y: SVC_Y_NEAR } },
  { id: 'H', labelKey: 'courtKeypoints.H', real: { x: 5,  y: SVC_Y_FAR  } },
]

export const COURT_KEYPOINTS: CourtKeypoint[] = DEFS.map((d, i) => ({ ...d, color: COLORS[i] }))

// Lines to project onto the frame for overlay validation (real-world coords)
export const COURT_LINES: [[number, number], [number, number]][] = [
  [[0, 0],  [10, 0]],              // back line (near)
  [[0, 20], [10, 20]],             // back line (far)
  [[0, 0],  [0,  20]],             // left side
  [[10, 0], [10, 20]],             // right side
  [[0, NET_Y], [10, NET_Y]],       // net
  [[0, SVC_Y_NEAR], [10, SVC_Y_NEAR]],  // service line near
  [[0, SVC_Y_FAR],  [10, SVC_Y_FAR ]],  // service line far
  [[5, SVC_Y_NEAR], [5,  SVC_Y_FAR ]],  // center service line
]
