export type AppStep = 'load' | 'pick-frame' | 'annotate' | 'validate'

export interface RealPoint { x: number; y: number }
export interface ImgPoint  { u: number; v: number }

export type CourtKeypointLabelKey =
  | 'courtKeypoints.A' | 'courtKeypoints.B' | 'courtKeypoints.C' | 'courtKeypoints.D'
  | 'courtKeypoints.E' | 'courtKeypoints.F' | 'courtKeypoints.G' | 'courtKeypoints.H'

export interface CourtKeypoint {
  id: string
  labelKey: CourtKeypointLabelKey
  real: RealPoint
  color: string
}

export interface ImaginarySegments {
  segmentA: [ImgPoint, ImgPoint]
  segmentB: [ImgPoint, ImgPoint]
}

export interface MarkedPoint {
  keypointId: string
  img: ImgPoint
  imaginary?: ImaginarySegments
}

export interface HomographyResult {
  H: number[][]
  reprojectionErrorM: number
}

export interface CapturedFrame {
  dataUrl: string
  width: number
  height: number
  videoFileName: string
  timestampS: number
}
