export type PlayState = 'in_play' | 'dead'
export type Visibility = 'visible' | 'occluded' | 'out_of_frame'
export type ImpactSurface = 'floor' | 'racket' | 'wall' | 'fence' | 'net'

export const IMPACT_SURFACES: ImpactSurface[] = ['floor', 'racket', 'wall', 'fence', 'net']

export type ShotType =
  | 'serve' | 'groundstroke' | 'high_volley' | 'medium_volley' | 'low_volley'
  | 'volley_chiquita' | 'lob' | 'volley_lob' | 'salida_lob' | 'smash'
  | 'gancho' | 'kick_smash' | 'rulo' | 'bandeja' | 'vibora'
  | 'bajada' | 'salida' | 'salida_chiquita' | 'chiquita'
  | 'contrapared' | 'contrapared_lateral'

export const SHOT_TYPES: ShotType[] = [
  'serve', 'groundstroke', 'high_volley', 'medium_volley', 'low_volley',
  'volley_chiquita', 'lob', 'volley_lob', 'salida_lob', 'smash',
  'gancho', 'kick_smash', 'rulo', 'bandeja', 'vibora',
  'bajada', 'salida', 'salida_chiquita', 'chiquita',
  'contrapared', 'contrapared_lateral',
]

export const SHOT_TYPE_GROUPS: Record<string, ShotType[]> = {
  Overhead: ['smash', 'gancho', 'kick_smash', 'rulo', 'bandeja', 'vibora'],
  Volley:   ['high_volley', 'medium_volley', 'low_volley', 'volley_lob', 'volley_chiquita'],
  Ground:   ['groundstroke', 'lob', 'chiquita', 'serve'],
  Wall:     ['salida', 'salida_lob', 'salida_chiquita', 'bajada', 'contrapared', 'contrapared_lateral'],
}

export const SHOT_TYPE_LABELS: Record<ShotType, string> = {
  serve:               'Serve',
  groundstroke:        'Groundstroke',
  high_volley:         'High Volley',
  medium_volley:       'Medium Volley',
  low_volley:          'Low Volley',
  volley_chiquita:     'Volley Chiquita',
  lob:                 'Lob',
  volley_lob:          'Volley Lob',
  salida_lob:          'Salida Lob',
  smash:               'Smash',
  gancho:              'Gancho',
  kick_smash:          'Kick Smash',
  rulo:                'Rulo',
  bandeja:             'Bandeja',
  vibora:              'Víbora',
  bajada:              'Bajada',
  salida:              'Salida',
  salida_chiquita:     'Salida Chiquita',
  chiquita:            'Chiquita',
  contrapared:         'Contrapared',
  contrapared_lateral: 'Contrapared Lat.',
}

export const SHOT_TYPE_ABBR: Record<ShotType, string> = {
  serve:               'SRV',
  groundstroke:        'GRS',
  high_volley:         'HVL',
  medium_volley:       'MVL',
  low_volley:          'LVL',
  volley_chiquita:     'VCH',
  lob:                 'LOB',
  volley_lob:          'VLB',
  salida_lob:          'SLB',
  smash:               'SMH',
  gancho:              'GNC',
  kick_smash:          'KSM',
  rulo:                'RUL',
  bandeja:             'BDJ',
  vibora:              'VBR',
  bajada:              'BAJ',
  salida:              'SAL',
  salida_chiquita:     'SCH',
  chiquita:            'CHQ',
  contrapared:         'CPR',
  contrapared_lateral: 'CPL',
}

export const SHOT_TYPE_COLORS: Record<ShotType, string> = {
  smash:               '#dc2626',
  gancho:              '#c2410c',
  kick_smash:          '#991b1b',
  rulo:                '#b45309',
  bandeja:             '#d97706',
  vibora:              '#db2777',
  high_volley:         '#0369a1',
  medium_volley:       '#1d4ed8',
  low_volley:          '#4338ca',
  volley_lob:          '#0d9488',
  volley_chiquita:     '#059669',
  groundstroke:        '#16a34a',
  lob:                 '#0f766e',
  chiquita:            '#6d28d9',
  serve:               '#7c3aed',
  salida:              '#65a30d',
  salida_lob:          '#15803d',
  salida_chiquita:     '#166534',
  bajada:              '#4d7c0f',
  contrapared:         '#7c2d12',
  contrapared_lateral: '#92400e',
}

export type Hand = 'forehand' | 'backhand'
export const HANDS: Hand[] = ['forehand', 'backhand']

export interface LabelRecord {
  frame: number
  play_state: PlayState
  visibility: Visibility
  x: number | null
  y: number | null
  impact: ImpactSurface | null
  shot_type: ShotType | null
  hand: Hand | null
}

export interface VideoMeta {
  file: File
  fps: number
  frameCount: number
  width: number
  height: number
  duration: number
}

export type AppStep = 'load' | 'label' | 'export'
