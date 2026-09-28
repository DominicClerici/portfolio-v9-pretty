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
 * canvas glides to wherever the next logo sits on the same curve.
 *
 * Each logo is painted with its own linear gradient (a flat colour is a
 * gradient of one). Every pixel works out what each logo in the blend
 * would paint there, exactly as the SVG would, and mixes those by the same
 * weights, turning around the hue wheel (OKLCH) rather than through grey. So
 * the gradients cross-fade point by point as the shape melts, and at rest
 * the canvas matches the plain SVG.
 *
 * WebGL2 only. Without it, the caller keeps the plain inline SVGs.
 */

/** A linear gradient in the logo's 100×100 box: from → to, stops as
 *  [offset 0…1, "#rrggbb"]. Interpolated in sRGB, as SVG does. */
export type LogoPaint = {
  from: [number, number]
  to: [number, number]
  stops: [number, string][]
}

export type Logo = { path: string; paint: LogoPaint }

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
// Gradient stops per logo the shader takes; fewer are padded with the last.
const STOPS = 3

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
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)

// OKLab a, b of "#rrggbb".
const ab = (hex: string) => {
  const [r, g, b] = rgb(hex).map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  )
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

// A gradient's overall hue: the chroma-weighted mean of its stops'.
const hueOf = (paint: LogoPaint) => {
  let a = 0
  let b = 0
  for (const [, hex] of paint.stops) {
    const [x, y] = ab(hex)
    a += x
    b += y
  }
  return Math.atan2(b, a)
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
// The logos in the blend, heaviest first: how many, their weights, and
// which layer (logo) each is.
uniform int uCount;
uniform float uW[${n}];
uniform int uLayer[${n}];
// Per logo: gradient start (xy) and direction over its length² (zw), and
// its stops as (sRGB, offset), and its overall hue.
uniform vec4 uGrad[${n}];
uniform float uHue[${n}];
uniform vec4 uStop[${n * STOPS}];
uniform float uBloat;
uniform float uBlur;
uniform float uPx;
in vec2 vUv;
out vec4 o;
float field(vec2 uv) {
  float d = 0.0;
  for (int i = 0; i < ${n}; i++) {
    if (i >= uCount) break;
    d += uW[i] * texture(uField, vec3(uv, float(uLayer[i]))).r;
  }
  return d;
}
// What logo l paints at p (logo units), as OKLCH.
vec3 paint(int l, vec2 p) {
  vec4 g = uGrad[l];
  float t = clamp(dot(p - g.xy, g.zw), 0.0, 1.0);
  vec4 a = uStop[l * ${STOPS}];
  vec3 c = a.rgb;
  for (int k = 1; k < ${STOPS}; k++) {
    vec4 b = uStop[l * ${STOPS} + k];
    if (t > a.w) c = mix(a.rgb, b.rgb, clamp((t - a.w) / max(b.w - a.w, 1e-5), 0.0, 1.0));
    a = b;
  }
  vec3 lin = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  vec3 lms = pow(mat3(
    0.4122214708, 0.2119034982, 0.0883024619,
    0.5363325363, 0.6806995451, 0.2817188376,
    0.0514459929, 0.1073969566, 0.6299787005) * lin, vec3(1.0 / 3.0));
  vec3 lab = mat3(
    0.2104542553, 1.9779984951, 0.0259040371,
    0.7936177850, -2.4285922050, 0.7827717662,
    -0.0040720468, 0.4505937099, -0.8086757660) * lms;
  return vec3(lab.x, length(lab.yz), atan(lab.z, lab.y));
}
vec3 rgbOf(vec3 lch) {
  vec3 lms = mat3(
    1.0, 1.0, 1.0,
    0.3963377774, -0.1055613458, -0.0894841775,
    0.2158037573, -0.0638541728, -1.2914855480) *
    vec3(lch.x, lch.y * cos(lch.z), lch.y * sin(lch.z));
  vec3 lin = mat3(
    4.0767416621, -1.2684380046, -0.0041960863,
    -3.3077115913, 2.6097574011, -0.7034186147,
    0.2309699292, -0.3413193965, 1.7076083690) * (lms * lms * lms);
  lin = clamp(lin, 0.0, 1.0);
  return mix(12.92 * lin, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, lin));
}
float wrap(float a) { return a - 6.2831853 * floor(a / 6.2831853 + 0.5); }
// Blend round the hue wheel, the shorter way between the two logos' overall
// hues. Deciding that per pixel instead would split a gradient whose far
// ends lie either side of opposite into two halves turning opposite ways,
// with a seam between. Folded in heaviest first, so a two-way blend is exact
// and a stray third barely registers.
vec3 color(vec2 p) {
  vec3 c = paint(uLayer[0], p);
  float ref = uHue[uLayer[0]];
  float acc = uW[0];
  for (int i = 1; i < ${n}; i++) {
    if (i >= uCount) break;
    vec3 c2 = paint(uLayer[i], p);
    float t = uW[i] / (acc + uW[i]);
    float way = wrap(uHue[uLayer[i]] - ref);
    float dh = way + wrap(c2.z - c.z - way);
    c = vec3(mix(c.xy, c2.xy, t), c.z + dh * t);
    ref += way * t;
    acc += uW[i];
  }
  return rgbOf(c);
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
  if (a <= 0.0) discard;
  o = vec4(color(vUv * ${SPAN.toFixed(1)} - ${MARGIN.toFixed(1)}) * a, a);
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
  const uCount = gl.getUniformLocation(prog, "uCount")
  const uW = gl.getUniformLocation(prog, "uW")
  const uLayer = gl.getUniformLocation(prog, "uLayer")
  const uBloat = gl.getUniformLocation(prog, "uBloat")
  const uBlur = gl.getUniformLocation(prog, "uBlur")
  const uPx = gl.getUniformLocation(prog, "uPx")
  gl.uniform1i(gl.getUniformLocation(prog, "uField"), 0)
  // The paints never change: set them once.
  const grad = new Float32Array(n * 4)
  const stops = new Float32Array(n * STOPS * 4)
  logos.forEach(({ paint: { from, to, stops: st } }, i) => {
    const dx = to[0] - from[0]
    const dy = to[1] - from[1]
    const len2 = dx * dx + dy * dy || 1
    grad.set([from[0], from[1], dx / len2, dy / len2], i * 4)
    for (let k = 0; k < STOPS; k++) {
      const [at, hex] = st[Math.min(k, st.length - 1)]
      stops.set([...rgb(hex), k < st.length ? at : 1], (i * STOPS + k) * 4)
    }
  })
  gl.uniform4fv(gl.getUniformLocation(prog, "uGrad"), grad)
  gl.uniform4fv(gl.getUniformLocation(prog, "uStop"), stops)
  gl.uniform1fv(
    gl.getUniformLocation(prog, "uHue"),
    logos.map((l) => hueOf(l.paint)),
  )
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
    // Weights too small to see are dropped, and the rest renormalised and
    // passed heaviest first, so the shader only samples the fields actually
    // in the blend.
    const order = [...w.keys()]
      .filter((i) => w[i] > 1e-3 && ready[i])
      .sort((a, b) => w[b] - w[a])
    const sum = order.reduce((s, i) => s + w[i], 0)
    const ws = new Float32Array(n)
    const layers = new Int32Array(n)
    let sq = 0
    order.forEach((l, i) => {
      ws[i] = w[l] / sum
      layers[i] = l
      sq += ws[i] * ws[i]
    })
    g.viewport(0, 0, canvas.width, canvas.height)
    g.clearColor(0, 0, 0, 0)
    g.clear(g.COLOR_BUFFER_BIT)
    g.uniform1i(uCount, order.length)
    g.uniform1fv(uW, ws)
    g.uniform1iv(uLayer, layers)
    // 2(1 − Σw²) is 0 at rest and 1 halfway between two.
    const mid = 2 * (1 - sq)
    g.uniform1f(uBloat, BLOAT * mid * mid)
    g.uniform1f(uBlur, BLUR * mid)
    g.uniform1f(uPx, SPAN / canvas.width)
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
