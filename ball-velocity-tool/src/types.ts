export type AppStep = 'load' | 'analyze' | 'results'

export interface HomographyJson {
  version: number
  H: number[][]
  frame_size: { width: number; height: number }
  video_file: string
  reprojection_error_m: number
}

export interface BallDetection {
  /** Pixel coordinates in the original video resolution */
  u: number
  v: number
  /** Real-world court coordinates in meters */
  x: number
  y: number
}

export interface FrameResult {
  frameIndex: number
  timeS: number
  ball: BallDetection | null
  rawVelocityKmh: number | null
  velocityKmh: number | null
}

export interface AnalysisConfig {
  videoFps: number
  frameStep: number
}
