/*
 * Company logos that melt from one into the next.
 *
 * The marks share nothing to tween between: an M of two arches, an A in three
 * pieces, an S with a dot and holes through it, an R, four round lobes. Point-
 * to-point path morphing needs the same number of outlines on both sides and
 * has no answer for holes, so it tears or tangles here. Instead each logo is
 * turned into a signed distance field once (how far every point of its box
 * is from the outline; negative inside), and what is drawn is a weighted
 * blend of those fields, cut at zero. At rest one weight is 1 and the logo is
 * exact; in between, the outgoing shape thins and pulls apart while the next
 * one swells up out of it, and any number of pieces can merge or split on
 * the way. Mid-blend the field is also smoothed and eased outward a touch,
 * so the shape stays one soft, full body instead of going spiky or stringy.
 *
 * Weights move by a two-stage lag (a critically damped response): they set
 * off at zero speed and land at zero speed, and if the target changes
 * mid-flight they bend toward it from where they are instead of restarting,
 * so fast scrolling through several entries stays one continuous melt. The
 * canvas glides to wherever the next logo sits on the same curve, and the
 * colour turns around the hue wheel (OKLCH) rather than through grey.
 *
 * WebGL2 only. Without it, the caller keeps the plain inline SVGs.
 */

export type Logo = { path: string; color: string }

export type LogoMorph = {
  canvas: HTMLCanvasElement
  /** Head for logo i. */
  show: (i: number, instant?: boolean) => void
  /** Put the logo's box (size × size, CSS px) at x, y in the offset parent,
   *  setting off after `delay` ms. */
  place: (
    x: number,
    y: number,
    size: number,
    instant?: boolean,
    delay?: number,
  ) => void
}

// The field covers the logo's 100×100 box plus this much all round, so the
// eased-out mid-blend shape and its anti-aliased edge never hit the canvas
// edge.
const MARGIN = 12
const SPAN = 100 + 2 * MARGIN
// Field resolution, and the supersampling it is averaged down from. 256 over
// SPAN is a little under a texel per device pixel at the largest the logo is
// shown; the field is linear near an edge, so filtering keeps it crisp.
const GRID = 256
const SS = 3
// Lag rate, per second, of each of the two stages: about 0.95s to 95%. The
// shape itself changes mostly while the weights cross the middle, so this
// is what gives that stretch a third of a second rather than a blink; the
// tail is too slight to see.
const RATE = 5
// The glide from slot to slot is quicker, about 0.47s, so a logo headed
// right stays clear of the next name's letters as they rise in behind it.
const GLIDE_RATE = 10
// At the midpoint of a two-way morph, how far the field is eased out and
// the radius it is smoothed over, in logo units (the box is 100). Both fall
// away toward either end, the easing faster, so it is gone at rest.
const BLOAT = 2.6
const BLUR = 5

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
const fieldOf = (path: string) => {
  const R = GRID * SS
  const c = document.createElement("canvas")
  c.width = c.height = R
  const ctx = c.getContext("2d", { willReadFrequently: true })!
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

// ── Colour ──
const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
const toGamma = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055

// "#rrggbb" -> [L, C, h] (OKLCH, h in radians)
const oklch = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) =>
    toLinear(parseInt(hex.slice(i, i + 2), 16) / 255),
  )
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(A, B), Math.atan2(B, A)]
}

const rgbOf = ([L, C, h]: number[]) => {
  const A = C * Math.cos(h)
  const B = C * Math.sin(h)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707608369 * s,
  ].map((c) => Math.min(1, Math.max(0, toGamma(c))))
}

// Blend along the shorter way round the hue wheel. Folded in heaviest
// first, so a two-way blend is exact and a stray third barely registers.
const mixColor = (lch: number[][], w: Float32Array) => {
  const order = [...w.keys()].filter((i) => w[i] > 0).sort((a, b) => w[b] - w[a])
  let [L, C, h] = lch[order[0]]
  let acc = w[order[0]]
  for (const i of order.slice(1)) {
    const t = w[i] / (acc + w[i])
    const [L2, C2, h2] = lch[i]
    let dh = h2 - h
    dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI
    L += (L2 - L) * t
    C += (C2 - C) * t
    h += dh * t
    acc += w[i]
  }
  return rgbOf([L, C, h])
}

// ── GL ──
const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`

const fragFor = (n: number) => `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uField;
uniform float uW[${n}];
uniform float uBloat;
uniform float uBlur;
uniform float uPx;
uniform vec3 uColor;
in vec2 vUv;
out vec4 o;
float field(vec2 uv) {
  float d = 0.0;
  for (int i = 0; i < ${n}; i++) {
    if (uW[i] > 0.0) d += uW[i] * texture(uField, vec3(uv, float(i))).r;
  }
  return d;
}
void main() {
  float d = field(vUv);
  if (uBlur > 0.0) {
    // Averaging the field over a disc rounds off spikes and slivers.
    for (int k = 0; k < 8; k++) {
      float t = float(k) * 0.7853982;
      d += field(vUv + uBlur / ${SPAN.toFixed(1)} * vec2(cos(t), sin(t)));
    }
    d /= 9.0;
  }
  d -= uBloat;
  float a = clamp(0.5 - d / uPx, 0.0, 1.0);
  o = vec4(uColor * a, a);
}`

export const logoMorph = (
  logos: Logo[],
  start: number,
  onLost: () => void,
): LogoMorph | null => {
  const n = logos.length
  const canvas = document.createElement("canvas")
  let gl: WebGL2RenderingContext | null = null
  try {
    gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    })
  } catch {
    gl = null
  }
  if (!gl) return null

  const compile = (type: number, src: string) => {
    const sh = gl!.createShader(type)!
    gl!.shaderSource(sh, src)
    gl!.compileShader(sh)
    return sh
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragFor(n)))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)
  const uW = gl.getUniformLocation(prog, "uW")
  const uBloat = gl.getUniformLocation(prog, "uBloat")
  const uBlur = gl.getUniformLocation(prog, "uBlur")
  const uPx = gl.getUniformLocation(prog, "uPx")
  const uColor = gl.getUniformLocation(prog, "uColor")
  gl.uniform1i(gl.getUniformLocation(prog, "uField"), 0)
  gl.bindVertexArray(gl.createVertexArray())

  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex)
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R16F, GRID, GRID, n)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  // Fields are built on demand (the one on show at once, the rest when the
  // page is idle), about 20ms apiece.
  const ready = new Array<boolean>(n).fill(false)
  const ensure = (i: number) => {
    if (ready[i] || lost) return
    ready[i] = true
    gl!.texSubImage3D(
      gl!.TEXTURE_2D_ARRAY, 0, 0, 0, i, GRID, GRID, 1,
      gl!.RED, gl!.FLOAT, fieldOf(logos[i].path),
    )
  }
  const idle = (cb: () => void) =>
    "requestIdleCallback" in window
      ? requestIdleCallback(() => cb())
      : setTimeout(cb, 50)
  const warm = () => {
    // Nearest the one on show first: those are what a scroll reaches next.
    const next = [...ready.keys()]
      .filter((i) => !ready[i])
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0]
    if (next === undefined || lost) return
    ensure(next)
    idle(warm)
  }

  const lch = logos.map((l) => oklch(l.color))
  // Two lag stages per weight: u chases the target, w chases u.
  const u = new Float32Array(n)
  const w = new Float32Array(n)
  let target = start
  u[start] = w[start] = 1
  // Position: [x, y] of each stage, and where it is headed.
  const pu = [0, 0]
  const pw = [0, 0]
  const pt = [0, 0]
  let pending: { x: number; y: number; at: number } | null = null
  let size = 0
  let lost = false

  canvas.setAttribute("aria-hidden", "true")
  Object.assign(canvas.style, {
    position: "absolute",
    left: "0",
    top: "0",
    pointerEvents: "none",
  })
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault()
    lost = true
    onLost()
  })

  const draw = () => {
    if (lost || !size) return
    const g = gl!
    const px = size * (SPAN / 100)
    canvas.style.transform = `translate3d(${(pw[0] - (px - size) / 2).toFixed(2)}px, ${(pw[1] - (px - size) / 2).toFixed(2)}px, 0)`
    // Weights too small to see are dropped, and the rest renormalised, so
    // the shader only samples the fields actually in the blend.
    const ws = new Float32Array(n)
    let sum = 0
    for (let i = 0; i < n; i++) {
      if (w[i] > 1e-3 && ready[i]) {
        ws[i] = w[i]
        sum += w[i]
      }
    }
    let sq = 0
    for (let i = 0; i < n; i++) {
      ws[i] /= sum
      sq += ws[i] * ws[i]
    }
    g.viewport(0, 0, canvas.width, canvas.height)
    g.clearColor(0, 0, 0, 0)
    g.clear(g.COLOR_BUFFER_BIT)
    g.uniform1fv(uW, ws)
    // 2(1 − Σw²) is 0 at rest and 1 halfway between two.
    const mid = 2 * (1 - sq)
    g.uniform1f(uBloat, BLOAT * mid * mid)
    g.uniform1f(uBlur, BLUR * mid)
    g.uniform1f(uPx, SPAN / canvas.width)
    g.uniform3fv(uColor, mixColor(lch, ws))
    g.drawArrays(g.TRIANGLES, 0, 3)
  }

  let running = false
  let last = 0
  const tick = (t: number) => {
    const total = Math.min(t - last, 64) / 1000
    last = t
    const steps = Math.max(1, Math.ceil(total / 0.004))
    const k = 1 - Math.exp((-RATE * total) / steps)
    const kp = 1 - Math.exp((-GLIDE_RATE * total) / steps)
    let busy = false
    if (pending && t >= pending.at) {
      pt[0] = pending.x
      pt[1] = pending.y
      pending = null
    }
    if (pending) busy = true
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < n; i++) {
        u[i] += ((i === target ? 1 : 0) - u[i]) * k
        w[i] += (u[i] - w[i]) * k
      }
      for (let j = 0; j < 2; j++) {
        pu[j] += (pt[j] - pu[j]) * kp
        pw[j] += (pu[j] - pw[j]) * kp
      }
    }
    for (let i = 0; i < n; i++) {
      if (Math.abs(w[i] - (i === target ? 1 : 0)) > 5e-4) busy = true
    }
    for (let j = 0; j < 2; j++) if (Math.abs(pw[j] - pt[j]) > 0.05) busy = true
    if (!busy) settle()
    draw()
    if (busy) requestAnimationFrame(tick)
    else running = false
  }
  const settle = () => {
    for (let i = 0; i < n; i++) u[i] = w[i] = i === target ? 1 : 0
    pu[0] = pw[0] = pt[0]
    pu[1] = pw[1] = pt[1]
  }
  const kick = () => {
    if (running) return
    running = true
    last = performance.now()
    requestAnimationFrame(tick)
  }

  ensure(start)
  idle(warm)

  return {
    canvas,
    show: (i, instant = false) => {
      ensure(i)
      target = i
      if (instant) {
        settle()
        draw()
      } else kick()
    },
    place: (x, y, s, instant = false, delay = 0) => {
      pending = null
      if (delay > 0 && !instant) pending = { x, y, at: performance.now() + delay }
      else {
        pt[0] = x
        pt[1] = y
      }
      if (s !== size) {
        size = s
        const px = s * (SPAN / 100)
        const dpr = Math.min(window.devicePixelRatio || 1, 3)
        canvas.style.width = canvas.style.height = `${px}px`
        canvas.width = canvas.height = Math.round(px * dpr)
      }
      if (instant) {
        pt[0] = x
        pt[1] = y
        pu[0] = pw[0] = x
        pu[1] = pw[1] = y
        draw()
      } else kick()
    },
  }
}
