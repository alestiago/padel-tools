export type KeypointVisibility = 'visible' | 'occluded' | 'not_in_frame'

export const KEYPOINT_IDS = [
  'head',
  'neck',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
  'left_toe',
  'right_toe',
] as const

export type KeypointId = (typeof KEYPOINT_IDS)[number]

export const KEYPOINT_LABELS: Record<KeypointId, string> = {
  head:           'Head',
  neck:           'Neck',
  left_shoulder:  'L Shoulder',
  right_shoulder: 'R Shoulder',
  left_elbow:     'L Elbow',
  right_elbow:    'R Elbow',
  left_wrist:     'L Wrist',
  right_wrist:    'R Wrist',
  left_hip:       'L Hip',
  right_hip:      'R Hip',
  left_knee:      'L Knee',
  right_knee:     'R Knee',
  left_ankle:     'L Ankle',
  right_ankle:    'R Ankle',
  left_toe:       'L Toe',
  right_toe:      'R Toe',
}

export const KEYPOINT_GROUPS: { label: string; ids: KeypointId[] }[] = [
  { label: 'Head', ids: ['head', 'neck'] },
  { label: 'Arms', ids: ['left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist'] },
  { label: 'Trunk', ids: ['left_hip', 'right_hip'] },
  { label: 'Legs', ids: ['left_knee', 'right_knee', 'left_ankle', 'right_ankle', 'left_toe', 'right_toe'] },
]

export interface Keypoint {
  x: number
  y: number
  visibility: KeypointVisibility
}

export type KeypointsMap = Partial<Record<KeypointId, Keypoint>>

export interface VideoMeta {
  file: File
  fps: number
  frameCount: number
  width: number
  height: number
  duration: number
}

export type AppStep = 'load' | 'label'
