import type { KeypointId } from '../types.ts'

export const CONNECTIONS: [KeypointId, KeypointId][] = [
  ['head', 'neck'],
  ['neck', 'left_shoulder'],
  ['neck', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_shoulder', 'right_shoulder'],
  ['left_hip', 'left_knee'],
  ['right_hip', 'right_knee'],
  ['left_knee', 'left_ankle'],
  ['right_knee', 'right_ankle'],
  ['left_ankle', 'left_toe'],
  ['right_ankle', 'right_toe'],
]

export interface AngleDef {
  id: string
  label: string
  proximal: KeypointId
  vertex: KeypointId
  distal: KeypointId
  safeMin: number
  safeMax: number
}

export const ANGLE_DEFS: AngleDef[] = [
  {
    id: 'left_elbow',
    label: 'L Elbow',
    proximal: 'left_shoulder',
    vertex: 'left_elbow',
    distal: 'left_wrist',
    safeMin: 30,
    safeMax: 170,
  },
  {
    id: 'right_elbow',
    label: 'R Elbow',
    proximal: 'right_shoulder',
    vertex: 'right_elbow',
    distal: 'right_wrist',
    safeMin: 30,
    safeMax: 170,
  },
  {
    id: 'left_knee',
    label: 'L Knee',
    proximal: 'left_hip',
    vertex: 'left_knee',
    distal: 'left_ankle',
    safeMin: 80,
    safeMax: 175,
  },
  {
    id: 'right_knee',
    label: 'R Knee',
    proximal: 'right_hip',
    vertex: 'right_knee',
    distal: 'right_ankle',
    safeMin: 80,
    safeMax: 175,
  },
  {
    id: 'left_shoulder_abduction',
    label: 'L Shoulder',
    proximal: 'neck',
    vertex: 'left_shoulder',
    distal: 'left_elbow',
    safeMin: 10,
    safeMax: 170,
  },
  {
    id: 'right_shoulder_abduction',
    label: 'R Shoulder',
    proximal: 'neck',
    vertex: 'right_shoulder',
    distal: 'right_elbow',
    safeMin: 10,
    safeMax: 170,
  },
  {
    id: 'left_hip_flexion',
    label: 'L Hip',
    proximal: 'left_shoulder',
    vertex: 'left_hip',
    distal: 'left_knee',
    safeMin: 80,
    safeMax: 175,
  },
  {
    id: 'right_hip_flexion',
    label: 'R Hip',
    proximal: 'right_shoulder',
    vertex: 'right_hip',
    distal: 'right_knee',
    safeMin: 80,
    safeMax: 175,
  },
]
