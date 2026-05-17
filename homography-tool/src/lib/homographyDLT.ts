// Normalized DLT homography estimation (pure TypeScript, no external deps).
// Convention: H maps image pixels [u,v] → real-world coords [x,y].
//   [x,y,1]ᵀ ≈ H · [u,v,1]ᵀ

type Pt2 = [number, number]
export type Mat3 = number[][]

// ── Normalization ─────────────────────────────────────────────────────────────

function normMatrix(pts: Pt2[]): { T: Mat3; normed: Pt2[] } {
  const n = pts.length
  const cx = pts.reduce((s, p) => s + p[0], 0) / n
  const cy = pts.reduce((s, p) => s + p[1], 0) / n
  const avgDist = pts.reduce((s, p) => {
    const dx = p[0] - cx, dy = p[1] - cy
    return s + Math.sqrt(dx * dx + dy * dy)
  }, 0) / n || 1
  const sc = Math.SQRT2 / avgDist
  const T: Mat3 = [
    [sc, 0,  -sc * cx],
    [0,  sc, -sc * cy],
    [0,  0,  1       ],
  ]
  return { T, normed: pts.map(([x, y]) => [sc * (x - cx), sc * (y - cy)]) }
}

// ── Linear algebra helpers ────────────────────────────────────────────────────

function mmul(A: number[][], B: number[][]): number[][] {
  const m = A.length, p = B[0].length, k = B.length
  return Array.from({ length: m }, (_, i) =>
    Array.from({ length: p }, (_, j) =>
      Array.from({ length: k }, (_, r) => A[i][r] * B[r][j]).reduce((a, b) => a + b, 0)
    )
  )
}

function transpose(A: number[][]): number[][] {
  return A[0].map((_, j) => A.map(r => r[j]))
}

// Gauss-Jordan elimination with partial pivoting. Solves Ax = b.
function solve(A: number[][], b: number[]): number[] | null {
  const n = A.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let maxRow = col
    for (let row = col + 1; row < n; row++)
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    [M[col], M[maxRow]] = [M[maxRow], M[col]]
    const pivot = M[col][col]
    if (Math.abs(pivot) < 1e-12) return null
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const f = M[row][col] / pivot
      for (let j = col; j <= n; j++) M[row][j] -= f * M[col][j]
    }
  }
  return M.map((row, i) => row[n] / row[i])
}

function cross3(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

export function lineIntersect(
  a1: [number, number], a2: [number, number],
  b1: [number, number], b2: [number, number],
): [number, number] | null {
  const la = cross3([a1[0], a1[1], 1], [a2[0], a2[1], 1])
  const lb = cross3([b1[0], b1[1], 1], [b2[0], b2[1], 1])
  const pt = cross3(la, lb)
  if (Math.abs(pt[2]) < 1e-8) return null
  return [pt[0] / pt[2], pt[1] / pt[2]]
}

export function angleBetweenLines(
  a1: [number, number], a2: [number, number],
  b1: [number, number], b2: [number, number],
): number {
  const da = [a2[0] - a1[0], a2[1] - a1[1]]
  const db = [b2[0] - b1[0], b2[1] - b1[1]]
  const dot = da[0] * db[0] + da[1] * db[1]
  const magA = Math.hypot(da[0], da[1])
  const magB = Math.hypot(db[0], db[1])
  if (magA < 1e-8 || magB < 1e-8) return 0
  return Math.acos(Math.min(1, Math.abs(dot) / (magA * magB))) * (180 / Math.PI)
}

// Inverse of a 3×3 similarity matrix [[s,0,tx],[0,s,ty],[0,0,1]]
function invertSimilarity(T: Mat3): Mat3 {
  const s = T[0][0], tx = T[0][2], ty = T[1][2]
  return [[1 / s, 0, -tx / s], [0, 1 / s, -ty / s], [0, 0, 1]]
}

// General 3×3 inverse via cofactors
export function invert3(m: Mat3): Mat3 | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-12) return null
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ]
}

// ── DLT core ─────────────────────────────────────────────────────────────────

// Builds the linear system Ah = b where h = [h11…h32] (h33 fixed to 1).
// For srcPts = image [u,v], dstPts = real [x,y].
function buildSystem(src: Pt2[], dst: Pt2[]): { A: number[][]; b: number[] } {
  const rows: number[][] = []
  const rhs: number[] = []
  for (let i = 0; i < src.length; i++) {
    const [u, v] = src[i]
    const [x, y] = dst[i]
    rows.push([u, v, 1, 0, 0, 0, -u * x, -v * x])
    rhs.push(x)
    rows.push([0, 0, 0, u, v, 1, -u * y, -v * y])
    rhs.push(y)
  }
  // Overdetermined (n > 4): normal equations AᵀA h = Aᵀb
  if (rows.length > 8) {
    const At = transpose(rows)
    return {
      A: mmul(At, rows),
      b: At.map(row => row.reduce((s, v, j) => s + v * rhs[j], 0)),
    }
  }
  return { A: rows, b: rhs }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function computeHomography(imgPts: Pt2[], realPts: Pt2[]): Mat3 | null {
  if (imgPts.length < 4 || imgPts.length !== realPts.length) return null

  const { T: Tsrc, normed: nSrc } = normMatrix(imgPts)
  const { T: Tdst, normed: nDst } = normMatrix(realPts)

  const { A, b } = buildSystem(nSrc, nDst)
  const h = solve(A, b)
  if (!h) return null

  const Hn: Mat3 = [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1   ],
  ]

  // Denormalize: H = Tdst⁻¹ · Hn · Tsrc
  const H = mmul(mmul(invertSimilarity(Tdst), Hn), Tsrc)
  const s = H[2][2]
  return H.map(row => row.map(v => v / s))
}

export function applyH(H: Mat3, u: number, v: number): [number, number] {
  const w = H[2][0] * u + H[2][1] * v + H[2][2]
  return [
    (H[0][0] * u + H[0][1] * v + H[0][2]) / w,
    (H[1][0] * u + H[1][1] * v + H[1][2]) / w,
  ]
}

export function reprojectionError(H: Mat3, imgPts: Pt2[], realPts: Pt2[]): number {
  return (
    imgPts.reduce((sum, p, i) => {
      const [px, py] = applyH(H, p[0], p[1])
      const dx = px - realPts[i][0], dy = py - realPts[i][1]
      return sum + Math.sqrt(dx * dx + dy * dy)
    }, 0) / imgPts.length
  )
}
