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

import { GRID, MARGIN, SPAN, fieldOf } from "./logo-field"
import { buildProgram, whenLinked } from "../lib/gl-program"

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
  /** The same box, found again after a layout change (a resize, a font
   *  load, the mobile address bar coming or going). Whatever is under way
   *  carries on, only shifted so it lands on the new spot: it never cuts
   *  to the end of a glide or drops one that is still waiting to set off. */
  reflow: (x: number, y: number, size: number) => void
}

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

/** `onReady` fires once the field for `start` is in and the canvas can take
 *  over from the SVGs: until then it draws nothing, so the caller should keep
 *  them up and hold off on show/place. */
export const logoMorph = (
  logos: Logo[],
  start: number,
  onLost: () => void,
  onReady: () => void,
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

  // Linked without waiting on it (src/lib/gl-program.ts). The uniforms are
  // looked up and the paints set once whenLinked() says it is done; the
  // fields can go into their texture meanwhile, and onReady waits for both.
  const prog = buildProgram(gl, VERT, fragFor(n))
  let linked = false
  let uCount: WebGLUniformLocation | null = null
  let uW: WebGLUniformLocation | null = null
  let uLayer: WebGLUniformLocation | null = null
  let uBloat: WebGLUniformLocation | null = null
  let uBlur: WebGLUniformLocation | null = null
  let uPx: WebGLUniformLocation | null = null
  const setup = (g: WebGL2RenderingContext) => {
    g.useProgram(prog)
    uCount = g.getUniformLocation(prog, "uCount")
    uW = g.getUniformLocation(prog, "uW")
    uLayer = g.getUniformLocation(prog, "uLayer")
    uBloat = g.getUniformLocation(prog, "uBloat")
    uBlur = g.getUniformLocation(prog, "uBlur")
    uPx = g.getUniformLocation(prog, "uPx")
    g.uniform1i(g.getUniformLocation(prog, "uField"), 0)
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
    g.uniform4fv(g.getUniformLocation(prog, "uGrad"), grad)
    g.uniform4fv(g.getUniformLocation(prog, "uStop"), stops)
    g.uniform1fv(
      g.getUniformLocation(prog, "uHue"),
      logos.map((l) => hueOf(l.paint)),
    )
  }
  gl.bindVertexArray(gl.createVertexArray())

  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex)
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R16F, GRID, GRID, n)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  // Fields are built in a worker, one at a time and always the one nearest
  // the logo on show (the one to start on first), since those are what a
  // scroll reaches next. Each is tens of milliseconds on a laptop and several
  // times that on a phone, so on the main thread they would land as long
  // tasks mid-scroll. show() for one that hasn't arrived yet (a scroll
  // straight past several entries before the worker has caught up) builds it
  // on the spot, as all of them used to be, so a morph never heads for a
  // logo it can't draw; the worker's copy is then dropped.
  const ready = new Array<boolean>(n).fill(false)
  // The logo on show, or headed for
  let target = start
  const upload = (i: number, field: Float32Array) => {
    if (ready[i] || lost) return
    ready[i] = true
    gl!.texSubImage3D(
      gl!.TEXTURE_2D_ARRAY, 0, 0, 0, i, GRID, GRID, 1,
      gl!.RED, gl!.FLOAT, field,
    )
    if (i === start) {
      if (linked) onReady()
    }
    // A field arriving mid-morph joins the blend it was missing from.
    else if (w[i] > 1e-3) draw()
  }
  whenLinked(gl, [prog], (ok) => {
    if (lost) return
    if (!ok) {
      // As a lost context: the caller keeps its SVGs
      lost = true
      worker?.terminate()
      worker = null
      return onLost()
    }
    setup(gl!)
    linked = true
    if (ready[start]) onReady()
  })
  const ensure = (i: number) => {
    if (!ready[i] && !lost) upload(i, fieldOf(logos[i].path))
  }
  // The unbuilt field nearest the one on show.
  const nearest = () => {
    let best = -1
    for (let i = 0; i < n; i++) {
      if (ready[i]) continue
      if (best < 0 || Math.abs(i - target) < Math.abs(best - target)) best = i
    }
    return best
  }
  // Without a usable worker, the old path: one field per idle callback.
  const idle = (cb: () => void) =>
    "requestIdleCallback" in window
      ? requestIdleCallback(() => cb())
      : setTimeout(cb, 50)
  const warmHere = () => {
    const next = nearest()
    if (next < 0 || lost) return
    ensure(next)
    idle(warmHere)
  }
  let worker: Worker | null = null
  let fellBack = false
  const noWorker = () => {
    worker?.terminate()
    worker = null
    if (fellBack) return
    fellBack = true
    idle(warmHere)
  }
  try {
    if (typeof OffscreenCanvas === "undefined") throw 0
    worker = new Worker(new URL("./logo-field.worker.ts", import.meta.url), {
      type: "module",
    })
    const ask = () => {
      const i = nearest()
      if (i < 0 || !worker) {
        worker?.terminate()
        worker = null
        return
      }
      worker.postMessage({ i, path: logos[i].path })
    }
    worker.onmessage = (e: MessageEvent<{ i: number; field: Float32Array | null }>) => {
      const { i, field } = e.data
      if (!field) return noWorker()
      upload(i, field)
      ask()
    }
    worker.onerror = noWorker
    ask()
  } catch {
    noWorker()
  }

  // Two lag stages per weight: u chases the target, w chases u.
  const u = new Float32Array(n)
  const w = new Float32Array(n)
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
    worker?.terminate()
    worker = null
    onLost()
  })

  // Scratch for draw(), which runs every frame of a morph.
  const inBlend = new Int32Array(n)
  const ws = new Float32Array(n)
  const layers = new Int32Array(n)
  const draw = () => {
    if (lost || !linked || !size) return
    const g = gl!
    const px = size * (SPAN / 100)
    canvas.style.transform = `translate3d(${(pw[0] - (px - size) / 2).toFixed(2)}px, ${(pw[1] - (px - size) / 2).toFixed(2)}px, 0)`
    // Weights too small to see are dropped, and the rest renormalised and
    // passed heaviest first, so the shader only samples the fields actually
    // in the blend.
    let count = 0
    let sum = 0
    for (let i = 0; i < n; i++) {
      if (w[i] > 1e-3 && ready[i]) {
        inBlend[count++] = i
        sum += w[i]
      }
    }
    // Insertion sort, heaviest first: there are at most a handful.
    for (let a = 1; a < count; a++) {
      const l = inBlend[a]
      let b = a - 1
      for (; b >= 0 && w[inBlend[b]] < w[l]; b--) inBlend[b + 1] = inBlend[b]
      inBlend[b + 1] = l
    }
    ws.fill(0)
    layers.fill(0)
    let sq = 0
    for (let i = 0; i < count; i++) {
      const l = inBlend[i]
      ws[i] = w[l] / sum
      layers[i] = l
      sq += ws[i] * ws[i]
    }
    g.viewport(0, 0, canvas.width, canvas.height)
    g.clearColor(0, 0, 0, 0)
    g.clear(g.COLOR_BUFFER_BIT)
    g.uniform1i(uCount, count)
    g.uniform1fv(uW, ws)
    g.uniform1iv(uLayer, layers)
    // 2(1 − Σw²) is 0 at rest and 1 halfway between two.
    const mid = 2 * (1 - sq)
    g.uniform1f(uBloat, BLOAT * mid * mid)
    g.uniform1f(uBlur, BLUR * mid)
    g.uniform1f(uPx, SPAN / canvas.width)
    g.drawArrays(g.TRIANGLES, 0, 3)
  }

  const resize = (s: number) => {
    if (s === size) return false
    size = s
    const px = s * (SPAN / 100)
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    canvas.style.width = canvas.style.height = `${px}px`
    canvas.width = canvas.height = Math.round(px * dpr)
    return true
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
    // With the blend and the glide both at rest and only a held move still
    // waiting to set off, the frame would be the last one again: skip it,
    // but keep ticking until the move is due.
    if (!busy && !pending) settle()
    if (busy || !pending) draw()
    if (busy || pending) requestAnimationFrame(tick)
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
      resize(s)
      if (instant) {
        pt[0] = x
        pt[1] = y
        pu[0] = pw[0] = x
        pu[1] = pw[1] = y
        draw()
      } else kick()
    },
    reflow: (x, y, s) => {
      // Where things were headed: the held move if there is one, otherwise
      // the current target. Everything in flight shifts by the same amount.
      const dx = x - (pending ? pending.x : pt[0])
      const dy = y - (pending ? pending.y : pt[1])
      const resized = resize(s)
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
        // Setting the canvas size clears it; repaint in this frame.
        if (resized) draw()
        return
      }
      // A held move now lands on the new spot; until it sets off, the logo
      // keeps to its old slot, which has moved by the same amount.
      if (pending) {
        pending.x = x
        pending.y = y
      }
      for (const p of [pt, pu, pw]) {
        p[0] += dx
        p[1] += dy
      }
      // The running loop picks the shift up next frame; otherwise, or if
      // the resize just cleared the canvas, paint it now.
      if (resized || !running) draw()
    },
  }
}
