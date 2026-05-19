export type PlayState = 'in_play' | 'dead'
export type Visibility = 'visible' | 'occluded' | 'out_of_frame'
export type ImpactSurface = 'floor' | 'racket' | 'wall' | 'fence' | 'net'

export const IMPACT_SURFACES: ImpactSurface[] = ['floor', 'racket', 'wall', 'fence', 'net']

export interface LabelRecord {
  frame: number
  play_state: PlayState
  visibility: Visibility
  x: number | null
  y: number | null
  impact: ImpactSurface | null
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
