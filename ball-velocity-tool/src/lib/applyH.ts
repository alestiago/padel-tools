export type Mat3 = number[][]

export function applyH(H: Mat3, u: number, v: number): [number, number] {
  const w = H[2][0] * u + H[2][1] * v + H[2][2]
  return [
    (H[0][0] * u + H[0][1] * v + H[0][2]) / w,
    (H[1][0] * u + H[1][1] * v + H[1][2]) / w,
  ]
}
