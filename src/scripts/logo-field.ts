/*
 * The signed distance fields logo-morph.ts blends between, split out so they
 * can be built off the main thread: logo-field.worker.ts runs this same code
 * against an OffscreenCanvas, and the morph falls back to calling it directly
 * where a worker can't (no module workers, no OffscreenCanvas 2D, no Path2D
 * in workers). Same code either way, so the fields are the same either way.
 */

// The field covers the logo's 100×100 box plus this much all round, so the
// eased-out mid-blend shape and its anti-aliased edge never hit the canvas
// edge.
export const MARGIN = 12
export const SPAN = 100 + 2 * MARGIN
// Field resolution, and the supersampling it is averaged down from. 256 over
// SPAN is a little under a texel per device pixel at the largest the logo is
// shown; the field is linear near an edge, so filtering keeps it crisp.
export const GRID = 256
const SS = 3

// ── Distance fields ──
// Felzenszwalb & Huttenlocher's exact squared Euclidean distance transform,
// one axis at a time.
const INF = 1e20
const edt1d = (
  f: Float32Array,
  n: number,
  d: Float32Array,
  v: Int32Array,
  z: Float32Array,
) => {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let r = v[k]
    let s = (f[q] + q * q - (f[r] + r * r)) / (2 * q - 2 * r)
    while (s <= z[k]) {
      k--
      r = v[k]
      s = (f[q] + q * q - (f[r] + r * r)) / (2 * q - 2 * r)
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const r = v[k]
    d[q] = (q - r) * (q - r) + f[r]
  }
}

const edt2d = (g: Float32Array, n: number) => {
  const f = new Float32Array(n)
  const d = new Float32Array(n)
  const v = new Int32Array(n)
  const z = new Float32Array(n + 1)
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) f[y] = g[y * n + x]
    edt1d(f, n, d, v, z)
    for (let y = 0; y < n; y++) g[y * n + x] = d[y]
  }
  for (let y = 0; y < n; y++) {
    const row = g.subarray(y * n, y * n + n)
    f.set(row)
    edt1d(f, n, d, v, z)
    row.set(d)
  }
}

// The signed distance field of one logo, GRID² texels over SPAN, in logo
// units. Rasterised SS× finer, measured there, and averaged down.
export const fieldOf = (
  path: string,
  canvas: (size: number) => HTMLCanvasElement | OffscreenCanvas = (size) => {
    const c = document.createElement("canvas")
    c.width = c.height = size
    return c
  },
) => {
  const R = GRID * SS
  const ctx = canvas(R).getContext("2d", { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
  const s = R / SPAN
  ctx.setTransform(s, 0, 0, s, MARGIN * s, MARGIN * s)
  ctx.fill(new Path2D(path), "evenodd")
  const a = ctx.getImageData(0, 0, R, R).data
  const toIn = new Float32Array(R * R)
  const toOut = new Float32Array(R * R)
  for (let i = 0; i < R * R; i++) {
    const inside = a[i * 4 + 3] >= 128
    toIn[i] = inside ? 0 : INF
    toOut[i] = inside ? INF : 0
  }
  edt2d(toIn, R)
  edt2d(toOut, R)
  // The outline runs between pixel centres, half a pixel from each side.
  const field = new Float32Array(GRID * GRID)
  const unit = SPAN / R / (SS * SS)
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let sum = 0
      for (let j = 0; j < SS; j++) {
        let i = (gy * SS + j) * R + gx * SS
        for (let k = 0; k < SS; k++, i++) {
          sum += toIn[i] > 0 ? Math.sqrt(toIn[i]) - 0.5 : 0.5 - Math.sqrt(toOut[i])
        }
      }
      field[gy * GRID + gx] = sum * unit
    }
  }
  return field
}
