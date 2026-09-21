/*
 * Shared glassmorphic scene engine — the dual-backend (WebGL2 + Canvas2D
 * fallback) renderer extracted from Hero.astro so the hero and the footer can
 * mount the same code with their own object layouts. One bundled copy, one
 * matcap fetch, independent canvases; callers own scroll wiring, visibility
 * observers, and any chrome (GPU warning, iris reveal).
 *
 * The Spline reference is a plane of touching glass cylinders between the
 * camera and blurred colored objects. Pass 1 draws the backdrop + object
 * impostors (the Spline material layers composited in-shader) into a mipmapped
 * FBO; pass 2 treats the whole frame as packed diagonal cylinders — per pixel
 * it derives the cylinder normal analytically, refracts the view ray in 2D,
 * and samples the blurred scene (mip LOD = the material's 45px blur) at the
 * displaced point, then adds the fresnel seam and film grain. When WebGL is
 * unavailable the same math runs per-pixel on the CPU against an analytic
 * already-blurred scene, at reduced resolution.
 *
 * ── The turn to dark ──
 * The backdrop is not a fixed colour. Callers scrub it from bone to near-black
 * with setDarkness(), and on the front page that is driven by scroll progress
 * across the hand-off from About to Career — so the page changes mood without
 * the glass ending at the seam. The whole backdrop turns at once: it is the
 * flat colour *behind* the cylinders, so what reaches the screen is the turn
 * seen through them, carried by the refracted ribs rather than washing flatly
 * over the frame.
 *
 * Objects declare which side of that turn they belong to (`zone`), and the
 * engine cross-fades each set across it — the hero's orbs dissolve into the
 * dark, a second set fades up out of it.
 */

/* ── Scene & material config ──
   Numbers lifted from the Spline material panels; the few *_TUNE knobs
   translate Spline's world-space units into screen-space fractions. These are
   the shared material — per-scene placement/colors come in via `objects`. */
// Cylinder plane
const AXIS_DEG = 42 // cylinder axis angle, y-up screen space
const PERIOD_FRAC = 0.078 // cylinder diameter, fraction of min(w, h)
const IOR = 1.14 // Spline: refraction 1.16
const THICK_FRAC = 0.7 // Spline: thickness 565 — screen-space equivalent
const BLUR_PX = 52 // Spline: blur 45 (CSS px)
// Glass fresnel — Spline: 80%, #fff, bias .24, scale 2.08, int 5.81, factor 1.17
const G_FRES = { bias: 0.3, scale: 2.08, pow: 2.0, mix: 1.1 }
const SEAM_DARK = 0.08 // subtle dark seam so packed cylinders read on white
// Sphere fresnel — Spline: 100%, #fff, bias .4, scale 1.5, int 8, factor .8
const S_FRES = { bias: 0.9, scale: 3.5, pow: 5.5, gain: 1.0 }
// Film grain, scaled by how much color the glass is carrying
const GRAIN_SAT = 0.12
const GRAIN_LUM = 0.22
const BG = [0.957, 0.953, 0.945] // backdrop behind the glass, light side
const BG_DARK = [0.063, 0.063, 0.063] // …and dark side (--color-n-900)

/* ── Dark-side material adaptation ──
   The material above was tuned against bone. Carried onto near-black as-is it
   comes apart in three specific ways, so three numbers scale with how far the
   backdrop has turned (0 = bone, 1 = near-black):

   · the white fresnel seam at mix 1.1 turns the cylinder plane into a white
     grid on black and lifts the flats out of true black — so on the dark side
     the seam is *inverted* rather than dimmed: the white lift rolls off to
     nothing and a matching sink toward black takes its place, which puts a
     thin dark gap between the bars where the light side puts a bright one.
     The two hand over across the back half of the turn (SINK_IN), by which
     point a white rib would be the brightest thing on the screen;
   · the dark seam has nothing left to darken;
   · the grain term is scaled by (1 − luminance), which peaks on black — left
     alone the dark half would be visibly noisier than the light half. */
const DARK_SEAM_SINK = 0.9 // how far the gap sinks toward black, fully turned
const SINK_IN = [0.45, 0.95] // darkness span the hand-over happens across
const DARK_SEAM = 0.35
const DARK_GRAIN = 0.2

/** The backdrop the scene paints at a given darkness, as a CSS colour — so
    anything that has to agree with it off-canvas (the scope's own background,
    for the case where no canvas paints at all) is driven by these numbers
    rather than by a second copy of them in a stylesheet. */
export function backdropColor(t: number): string {
  const c = (i: number) =>
    Math.round(
      255 * (BG[i] + (BG_DARK[i] - BG[i]) * Math.min(1, Math.max(0, t))),
    )
  return `rgb(${c(0)}, ${c(1)}, ${c(2)})`
}

// Base sphere radius (fraction of min(w, h)); per-object scale multiplies it
export const SPHERE_R_FRAC = 0.28

export type GlassObject = {
  /** 0 sphere, 1 cube */
  shape: 0 | 1
  /** matcap intensity (sphere image layer) */
  mat: number
  /** radius, fraction of min(w, h) */
  rFrac: number
  /** center, fraction of viewport (x from left, y-up from bottom) */
  cx: number
  cy: number
  /** shifts the center right by this many radii (edge-touch placement) */
  edgeR: number
  /** gradient A: bottom + mid stops, gradient B: base */
  ga0: number[]
  ga1: number[]
  gb0: number[]
  gaMix: number
  gbMix: number
  /** Overall brightness of the finished object, 1 = as composed above. The
      material is lit for bone, where the fresnel rim and the white end of
      gradient A read as sheen; on near-black the same object is the brightest
      thing on screen and will fight anything set over it. Turning this down
      keeps the hue and lets it sink back into the dark. */
  dim?: number
  /** idle float */
  driftAmp: number
  driftYScale: number
  spdX: number
  spdY: number
  phX: number
  phY: number
  /** which scroll channel supplies this object's lift (see setScrollTarget) */
  lift?: number
  /** Which side of the turn to dark this object belongs to: 0 the light side
      (the default — it dissolves as the backdrop darkens), 1 the dark side (it
      fades up out of the dark instead). Inert until a caller scrubs the
      backdrop with setDarkness(). */
  zone?: 0 | 1
}

export type GlassSceneOptions = {
  canvas: HTMLCanvasElement
  /** sizing element the canvas fills */
  wrap: HTMLElement
  /** composited back-to-front (smaller/farther first) */
  objects: GlassObject[]
  /** parallax shift per unit pointer travel */
  pointerSensitivity?: number
  /** per-frame catch-up; lower = slower, more fluid/laggy */
  pointerEase?: number
  scrollEase?: number
  /** global multipliers on each object's idle float */
  driftSpeed?: number
  driftAmount?: number
  /** render framerate cap for the glass pass; 0 = display rate */
  fpsCap?: number
  /** refresh rate for the (expensive) scene/blur pass; 0 = every frame */
  sceneFpsCap?: number
  /** Width of each object set's cross-fade, as a span of the 0…1 darkness.
      The light set fades out over the turn's first `crossfade`, the dark set in
      over its last, so the two overlap by however much this exceeds 0.5 —
      enough that the frame is never empty, little enough that they are not both
      half-there at once. */
  crossfade?: number
  forceCPU?: boolean
  /** fires when the CPU backend takes over (no WebGL, or context lost) */
  onCPUFallback?: () => void
}

export type GlassScene = {
  start(): void
  stop(): void
  resize(): void
  render(tSec: number): void
  /** Scroll parallax target in CSS px; positive lifts the objects. `channel`
      selects which lift the objects reading it move with — a scene can run
      several (the hero's orbs climb with the page, the career orbs with the
      pinned section's progress). */
  setScrollTarget(px: number, channel?: number): void
  /** How far the backdrop has turned from bone (0) to near-black (1), flat
      across the whole canvas. Also drives the object cross-fade and the
      material's dark-side adaptation. Stays at 0 until a caller moves it, so a
      scene that never calls this is bone throughout. */
  setDarkness(t: number): void
}

/* Sphere texture layer (Spline: Image 100%) — the reference photo of a dark
   glossy ball, projected matcap-style from the impostor normal. Loaded once
   for every scene on the page; each instance re-renders when it arrives. */
const matcap = new Image()
let matcapReady = false
const matcapSubs = new Set<() => void>()
matcap.onload = () => {
  matcapReady = true
  matcapSubs.forEach((cb) => cb())
}
matcap.src = "/glass-matcap.avif"

const v3 = (c: number[]) => `vec3(${c.map((x) => x.toFixed(3)).join(", ")})`
const f1 = (x: number) => x.toFixed(3)

export function createGlassScene(opts: GlassSceneOptions): GlassScene {
  const {
    wrap,
    objects: OBJECTS,
    pointerSensitivity: POINTER_SENSITIVITY = -0.5,
    pointerEase: POINTER_EASE = 0.04,
    scrollEase: SCROLL_EASE = 0.14,
    driftSpeed: DRIFT_SPEED = 1.5,
    driftAmount: DRIFT_AMOUNT = 2.0,
    fpsCap: FPS_CAP = 60,
    sceneFpsCap: SCENE_FPS_CAP = 30,
    crossfade: CROSSFADE = 0.62,
    forceCPU = false,
    onCPUFallback,
  } = opts
  let canvas = opts.canvas
  const NOBJ = OBJECTS.length
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches

  /* ── Scroll parallax ──
     The caller feeds one lift target (px) per channel from its own scroll
     wiring; the eased lift the objects actually use catches up once per
     rendered frame so the parallax glides instead of snapping to the raw
     scroll position. Channels are independent so one scene can carry two
     unrelated climbs at once — objects pick theirs with `lift`. */
  const CHANNELS = 1 + OBJECTS.reduce((n, o) => Math.max(n, o.lift ?? 0), 0)
  const scrollTargets = new Float64Array(CHANNELS)
  const scrollLifts = new Float64Array(CHANNELS) // eased, CSS px
  function stepScroll() {
    for (let i = 0; i < CHANNELS; i++) {
      scrollLifts[i] += (scrollTargets[i] - scrollLifts[i]) * SCROLL_EASE
    }
  }

  /* ── The turn to dark ──
     0 until a caller scrubs it, so an untouched scene renders bone end to end
     (the footer's does). Unlike the scroll lifts this is not eased: the page's
     own smooth-scroll already supplies the smoothing, and a second lag here
     would let the backdrop drift out of step with the section it is handing
     over to. */
  let darkness = 0

  /* Pointer parallax + idle drift, shared by both backends */
  let px = 0
  let py = 0 // smoothed pointer, −0.5…0.5
  let tpx = 0
  let tpy = 0
  window.addEventListener(
    "pointermove",
    (e) => {
      tpx = e.clientX / window.innerWidth - 0.5
      tpy = 0.5 - e.clientY / window.innerHeight
    },
    { passive: true },
  )
  // Ease the shared pointer toward its target once per rendered frame.
  function smoothPointer() {
    px += (tpx - px) * POINTER_EASE
    py += (tpy - py) * POINTER_EASE
  }
  const smoothstep = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)
  }

  /* Per-frame object layout, shared by both backends: centers in y-up pixels
     (cxBuf/cyBuf) plus each object's visibility across the light→dark front
     (alphaBuf). `liftScale` converts the caller's CSS-px scroll lift into the
     target's own pixel scale — dpr for the GL canvas, H/cssH for the CPU
     fallback's small buffer.

     All objects share the pointer response; only their drift phase, their lift
     channel and their side of the turn differ. The two sets cross-fade on the
     darkness itself, so an orb dissolves as the ground it sits on goes out
     from under it. */
  const cxBuf = new Float64Array(NOBJ)
  const cyBuf = new Float64Array(NOBJ)
  const alphaBuf = new Float32Array(NOBJ).fill(1)
  function layoutObjects(
    tSec: number,
    w: number,
    h: number,
    liftScale: number,
  ) {
    const m = Math.min(w, h)
    // Visibility of each set across the turn — one pair for all of them.
    const aLight = 1 - smoothstep(0, CROSSFADE, darkness)
    const aDark = smoothstep(1 - CROSSFADE, 1, darkness)
    for (let i = 0; i < NOBJ; i++) {
      const o = OBJECTS[i]
      const dx =
        o.driftAmp *
        DRIFT_AMOUNT *
        Math.sin(tSec * o.spdX * DRIFT_SPEED + o.phX)
      const dy =
        o.driftAmp *
        o.driftYScale *
        DRIFT_AMOUNT *
        Math.sin(tSec * o.spdY * DRIFT_SPEED + o.phY)
      const cy =
        h * o.cy +
        m * (dy + POINTER_SENSITIVITY * py) +
        scrollLifts[o.lift ?? 0] * liftScale
      cxBuf[i] =
        w * o.cx + m * (o.rFrac * o.edgeR + dx + POINTER_SENSITIVITY * px)
      cyBuf[i] = cy
      alphaBuf[i] = o.zone === 1 ? aDark : aLight
    }
  }

  type Impl = {
    render: (tSec: number, sceneDirty?: boolean) => void
    resize: () => void
  }
  let impl: Impl

  /* ── Shared render-loop harness (raf, resize, visibility) ── */
  // rAF always fires at the display's refresh rate; when FPS_CAP is set we
  // skip the render on frames that arrive before the next slot is due (time
  // still comes from the real timestamp, so the motion stays correct).
  const FRAME_MS = FPS_CAP > 0 ? 1000 / FPS_CAP : 0
  // Frames on which the scene/blur is refreshed. The glass pass draws every
  // capped frame; the scene pass only when this slot is due (see render()).
  const SCENE_MS = SCENE_FPS_CAP > 0 ? 1000 / SCENE_FPS_CAP : 0
  let rafId: number | null = null
  let running = false
  let lastT = 0
  let lastFrameMs = -Infinity
  let lastSceneMs = -Infinity
  function loop(ms: number) {
    if (!running) return
    rafId = requestAnimationFrame(loop)
    if (FRAME_MS && ms - lastFrameMs < FRAME_MS - 1) return
    lastFrameMs = ms
    lastT = ms / 1000
    const sceneDirty = !SCENE_MS || ms - lastSceneMs >= SCENE_MS - 1
    if (sceneDirty) lastSceneMs = ms
    impl.render(lastT, sceneDirty)
  }
  function start() {
    if (running || reducedMotion) return
    running = true
    rafId = requestAnimationFrame(loop)
  }
  function stop() {
    running = false
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null
  }

  /* Under reduced motion there is no loop, so every scroll-driven setter has
     to repaint the single static frame itself. A frame carries several of
     them (two lifts and the darkness), and on the CPU backend a repaint is the
     whole per-pixel pass — so they coalesce onto one rAF instead of each
     paying for it. No-op when the loop is running. */
  let staticPending = false
  function repaintStatic() {
    if (!reducedMotion || staticPending) return
    staticPending = true
    requestAnimationFrame(() => {
      staticPending = false
      impl.render(40)
    })
  }

  // GL backend swaps this in so the matcap upload happens on arrival; the CPU
  // backend leaves it null (its analytic scene has no image layer).
  let onMatcap: (() => void) | null = null
  matcapSubs.add(() => {
    onMatcap?.()
    if (!running) impl.render(lastT)
  })

  /* ── Raw WebGL2 backend ── */
  let glTouched = false

  function startGL(): Impl | null {
    if (forceCPU) return null
    // Hardened browsers can throw from getContext instead of returning null;
    // either way this must resolve to the CPU fallback, not an escaped
    // exception (the callers register scroll/observer wiring around scene
    // creation and an escaped throw would strand it).
    let gl: WebGL2RenderingContext | null = null
    try {
      gl = canvas.getContext("webgl2", {
        antialias: false, // both passes are fullscreen quads — nothing to MSAA
        alpha: false,
        powerPreference: "low-power",
      })
    } catch {
      gl = null
    }
    if (!gl) return null
    glTouched = true

    const VS = `#version 300 es
      layout(location = 0) in vec2 aPos;
      void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

    // Pass 1 — backdrop + sphere impostor, Spline layers bottom-to-top:
    // image → fresnel → gradient B (40%) → gradient A (60%) → phong (60%)
    const SCENE_FS = `#version 300 es
      precision highp float;
      #define NOBJ ${NOBJ}
      uniform vec3 uObj[NOBJ];    // center (px, y-up), radius (px)
      uniform float uShape[NOBJ]; // 0 sphere, 1 cube
      uniform float uMat[NOBJ];   // matcap intensity
      uniform vec3 uGA0[NOBJ];    // gradient A: bottom stop
      uniform vec3 uGA1[NOBJ];    // gradient A: mid stop
      uniform vec3 uGB0[NOBJ];    // gradient B: base
      uniform float uGAmix[NOBJ];
      uniform float uGBmix[NOBJ];
      uniform float uDim[NOBJ];   // overall brightness
      uniform float uAlpha[NOBJ]; // visibility across the turn to dark
      uniform float uDark;        // backdrop: 0 bone → 1 near-black
      uniform sampler2D uMatcap;
      uniform float uMatcapOn;
      out vec4 outColor;

      vec3 gradA(float t, vec3 c0, vec3 c1) {
        vec3 c = mix(c0, c1, smoothstep(0.0, 0.8, t));
        return mix(c, vec3(1.0), smoothstep(0.8, 1.0, t));
      }
      vec3 gradB(float t, vec3 c0) {
        return mix(c0, vec3(1.0), smoothstep(0.8, 1.0, t));
      }

      void main() {
        vec3 col = mix(${v3(BG)}, ${v3(BG_DARK)}, uDark);
        // Composite each object over the last, back-to-front (array order).
        for (int i = 0; i < NOBJ; i++) {
          if (uAlpha[i] < 0.002) continue;
          vec3 o = uObj[i];
          vec2 p = (gl_FragCoord.xy - o.xy) / o.z;
          vec3 n;
          vec3 base;
          float cov;
          if (uShape[i] < 0.5) {
            float r2 = dot(p, p);
            if (r2 >= 1.0) continue;
            n = vec3(p, sqrt(1.0 - r2));
            base = mix(vec3(0.16), texture(uMatcap, vec2(n.x, -n.y) * 0.5 + 0.5).rgb, uMat[i] * uMatcapOn);
            cov = smoothstep(0.0, 2.5 / o.z, 1.0 - sqrt(r2));
          } else {
            // Rounded-box silhouette with a domed normal — after the glass
            // blur + refraction it reads as a soft cube. The fresnel rim
            // traces the square edge (n.z → 0 as the box distance → 0).
            vec2 d2 = abs(p) - vec2(0.82) + 0.16;
            float sd = length(max(d2, 0.0)) + min(max(d2.x, d2.y), 0.0) - 0.16;
            if (sd >= 0.0) continue;
            float e = clamp(-sd / 0.55, 0.0, 1.0);
            float nz = sqrt(clamp(1.0 - (1.0 - e) * (1.0 - e), 0.0, 1.0));
            n = vec3(0.0, clamp(p.y, -1.0, 1.0), nz);
            base = vec3(0.16);
            cov = smoothstep(0.0, 2.5 / o.z, -sd);
          }
          float fr = clamp(${f1(S_FRES.bias)} + ${f1(S_FRES.scale)} * pow(1.0 - n.z, ${f1(S_FRES.pow)}), 0.0, 1.0);
          vec3 c = base + vec3(1.0) * fr * fr * ${f1(S_FRES.gain)};
          float t = 0.5 - n.y * 0.5;                  // 0 top → 1 bottom
          c = mix(c, gradB(t, uGB0[i]), uGBmix[i]);
          c = mix(c, gradA(t, uGA0[i], uGA1[i]), uGAmix[i]);
          col = mix(col, c * uDim[i], cov * uAlpha[i]);
        }
        outColor = vec4(col, 1.0);
      }`

    // Pass 2 — the glass plane. Per pixel: cylinder normal from the packed
    // circle profile, 2D refraction (entry interface; the steep growth
    // toward the edges is what shears the sphere into blades), blurred
    // scene sample at the displaced point, fresnel seam, grain.
    const GLASS_FS = `#version 300 es
      precision highp float;
      uniform vec2 uRes;
      uniform sampler2D uScene;
      uniform float uLod;
      uniform float uPeriod;   // cylinder diameter, px
      uniform vec2 uAxis;      // unit axis direction
      uniform float uThick;    // displacement scale, px
      uniform float uTime;
      uniform float uDark;     // backdrop: 0 bone → 1 near-black
      out vec4 outColor;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      void main() {
        vec2 perp = vec2(-uAxis.y, uAxis.x);
        float x = fract(dot(gl_FragCoord.xy, perp) / uPeriod) * 2.0 - 1.0;
        float ny = sqrt(max(1.0 - x * x, 1e-5));
        vec2 T = refract(vec2(0.0, -1.0), vec2(x, ny), 1.0 / ${f1(IOR)});
        float shift = T.x / max(abs(T.y), 0.05) * uThick;
        vec2 uv = (gl_FragCoord.xy + perp * shift) / uRes;

        // 4 rotated jitter taps hide mip-blur blockiness. uScene is
        // CLAMP_TO_EDGE, so out-of-range taps resolve to the edge texel
        // on their own — no per-tap clamp() needed.
        float a = hash(gl_FragCoord.xy) * 6.2832;
        vec2 j = vec2(cos(a), sin(a)) * uPeriod * 0.05 / uRes;
        vec3 c = textureLod(uScene, uv + j, uLod).rgb
               + textureLod(uScene, uv - j, uLod).rgb
               + textureLod(uScene, uv + vec2(-j.y, j.x), uLod).rgb
               + textureLod(uScene, uv - vec2(-j.y, j.x), uLod).rgb;
        c *= 0.25;

        // displaced samples that land off-screen read as the backdrop
        // rather than as a smeared clamp of the frame edge
        vec2 ouv = max(vec2(0.0), max(-uv, uv - 1.0));
        vec3 bg = mix(${v3(BG)}, ${v3(BG_DARK)}, uDark);
        c = mix(c, bg, smoothstep(0.0, 0.04, max(ouv.x, ouv.y)));

        // Seam, and the grain below it, scale with how far the backdrop has
        // turned (see the DARK_* notes up top). The two seam terms are the gap
        // between one bar and the next: a white lift over bone, a sink to
        // black over near-black, handing over mid-turn. The sink runs on the
        // square of the lift's profile so it is the tighter line of the two —
        // through the hand-over they shape a bright shoulder around a dark
        // core rather than cancelling each other into a flat plane.
        float fr = clamp(${f1(G_FRES.bias)} + ${f1(G_FRES.scale)} * pow(1.0 - ny, ${f1(G_FRES.pow)}), 0.0, 1.0);
        float seam = fr * fr;
        c *= 1.0 - fr * ${f1(SEAM_DARK)} * mix(1.0, ${f1(DARK_SEAM)}, uDark);
        c = mix(c, vec3(1.0), seam * ${f1(G_FRES.mix)} * (1.0 - uDark));
        c = mix(c, vec3(0.0), seam * seam * ${f1(DARK_SEAM_SINK)} * smoothstep(${f1(SINK_IN[0])}, ${f1(SINK_IN[1])}, uDark));

        float lum = dot(c, vec3(0.299, 0.587, 0.114));
        float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
        float g = hash(gl_FragCoord.xy + fract(uTime) * 61.7) - 0.5;
        c += g * (sat * ${f1(GRAIN_SAT)}
                + (1.0 - lum) * ${f1(GRAIN_LUM)} * mix(1.0, ${f1(DARK_GRAIN)}, uDark));

        outColor = vec4(c, 1.0);
      }`

    function compile(type: number, src: string) {
      const s = gl!.createShader(type)!
      gl!.shaderSource(s, src)
      gl!.compileShader(s)
      if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) {
        console.error(gl!.getShaderInfoLog(s))
        return null
      }
      return s
    }
    function link(fs: string) {
      const p = gl!.createProgram()!
      const v = compile(gl!.VERTEX_SHADER, VS)
      const f = compile(gl!.FRAGMENT_SHADER, fs)
      if (!v || !f) return null
      gl!.attachShader(p, v)
      gl!.attachShader(p, f)
      gl!.linkProgram(p)
      if (!gl!.getProgramParameter(p, gl!.LINK_STATUS)) {
        console.error(gl!.getProgramInfoLog(p))
        return null
      }
      return p
    }
    const sceneProg = link(SCENE_FS)
    const glassProg = link(GLASS_FS)
    if (!sceneProg || !glassProg) return null

    const quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    )
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    const uObj = gl.getUniformLocation(sceneProg, "uObj")
    const uAlpha = gl.getUniformLocation(sceneProg, "uAlpha")
    const uDarkScene = gl.getUniformLocation(sceneProg, "uDark")
    const uMatcapOn = gl.getUniformLocation(sceneProg, "uMatcapOn")
    gl.useProgram(sceneProg)
    gl.uniform1i(gl.getUniformLocation(sceneProg, "uMatcap"), 0)
    // Matcap toggle is set once here and flipped on in uploadMatcap() — it's
    // constant thereafter, so the per-frame path never touches it.
    gl.uniform1f(uMatcapOn, matcapReady ? 1 : 0)
    // Static per-object material uniforms (color/shape never change).
    const sceneLoc = (name: string) => gl.getUniformLocation(sceneProg, name)
    gl.uniform1fv(
      sceneLoc("uShape"),
      new Float32Array(OBJECTS.map((o) => o.shape)),
    )
    gl.uniform1fv(sceneLoc("uMat"), new Float32Array(OBJECTS.map((o) => o.mat)))
    gl.uniform1fv(
      sceneLoc("uGAmix"),
      new Float32Array(OBJECTS.map((o) => o.gaMix)),
    )
    gl.uniform1fv(
      sceneLoc("uGBmix"),
      new Float32Array(OBJECTS.map((o) => o.gbMix)),
    )
    gl.uniform1fv(
      sceneLoc("uDim"),
      new Float32Array(OBJECTS.map((o) => o.dim ?? 1)),
    )
    gl.uniform3fv(
      sceneLoc("uGA0"),
      new Float32Array(OBJECTS.flatMap((o) => o.ga0)),
    )
    gl.uniform3fv(
      sceneLoc("uGA1"),
      new Float32Array(OBJECTS.flatMap((o) => o.ga1)),
    )
    gl.uniform3fv(
      sceneLoc("uGB0"),
      new Float32Array(OBJECTS.flatMap((o) => o.gb0)),
    )
    const uRes = gl.getUniformLocation(glassProg, "uRes")
    const uLod = gl.getUniformLocation(glassProg, "uLod")
    const uPeriod = gl.getUniformLocation(glassProg, "uPeriod")
    const uAxis = gl.getUniformLocation(glassProg, "uAxis")
    const uThick = gl.getUniformLocation(glassProg, "uThick")
    const uTime = gl.getUniformLocation(glassProg, "uTime")
    const uDarkGlass = gl.getUniformLocation(glassProg, "uDark")
    gl.useProgram(glassProg)
    gl.uniform1i(gl.getUniformLocation(glassProg, "uScene"), 1)

    // Matcap texture (unit 0)
    const matTex = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, matTex)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([40, 40, 40, 255]),
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    function uploadMatcap() {
      gl!.activeTexture(gl!.TEXTURE0)
      gl!.bindTexture(gl!.TEXTURE_2D, matTex)
      gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, true)
      gl!.texImage2D(
        gl!.TEXTURE_2D,
        0,
        gl!.RGBA,
        gl!.RGBA,
        gl!.UNSIGNED_BYTE,
        matcap,
      )
      gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, false)
      gl!.useProgram(sceneProg)
      gl!.uniform1f(uMatcapOn, 1)
    }
    onMatcap = uploadMatcap
    if (matcapReady) uploadMatcap()

    // Scene FBO (unit 1) — quarter resolution; it only ever gets sampled
    // through a deep blur, and the downscale buys free extra mip levels.
    const FBO_SCALE = 0.25
    const sceneTex = gl.createTexture()
    const fbo = gl.createFramebuffer()
    let fw = 1
    let fh = 1
    function allocFBO(w: number, h: number) {
      fw = Math.max(1, Math.round(w * FBO_SCALE))
      fh = Math.max(1, Math.round(h * FBO_SCALE))
      gl!.activeTexture(gl!.TEXTURE1)
      gl!.bindTexture(gl!.TEXTURE_2D, sceneTex)
      gl!.texImage2D(
        gl!.TEXTURE_2D,
        0,
        gl!.RGBA,
        fw,
        fh,
        0,
        gl!.RGBA,
        gl!.UNSIGNED_BYTE,
        null,
      )
      gl!.texParameteri(
        gl!.TEXTURE_2D,
        gl!.TEXTURE_MIN_FILTER,
        gl!.LINEAR_MIPMAP_LINEAR,
      )
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE)
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo)
      gl!.framebufferTexture2D(
        gl!.FRAMEBUFFER,
        gl!.COLOR_ATTACHMENT0,
        gl!.TEXTURE_2D,
        sceneTex,
        0,
      )
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, null)
    }

    canvas.addEventListener(
      "webglcontextlost",
      (e) => {
        e.preventDefault()
        stop()
        impl = startCPU()
        onCPUFallback?.()
        impl.resize()
        start()
      },
      { once: true },
    )

    let dpr = 1
    const objBuf = new Float32Array(NOBJ * 3)
    function render(tSec: number, sceneDirty = true) {
      // Pass 1 — scene into the FBO, then mip it down for the glass blur.
      // Object placement and pointer/scroll easing all live in here, so the
      // whole block is gated on sceneDirty: it refreshes at SCENE_FPS_CAP
      // while the glass pass below still draws every frame. The FBO + its
      // mip chain persist between refreshes for the glass pass to sample.
      if (sceneDirty) {
        smoothPointer()
        stepScroll()
        const m = Math.min(canvas.width, canvas.height)
        layoutObjects(tSec, canvas.width, canvas.height, dpr)
        for (let i = 0; i < NOBJ; i++) {
          objBuf[i * 3] = cxBuf[i] * FBO_SCALE
          objBuf[i * 3 + 1] = cyBuf[i] * FBO_SCALE
          objBuf[i * 3 + 2] = m * OBJECTS[i].rFrac * FBO_SCALE
        }
        gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo)
        gl!.viewport(0, 0, fw, fh)
        gl!.useProgram(sceneProg)
        gl!.uniform3fv(uObj, objBuf)
        gl!.uniform1fv(uAlpha, alphaBuf)
        gl!.uniform1f(uDarkScene, darkness)
        gl!.drawArrays(gl!.TRIANGLES, 0, 3)
        gl!.activeTexture(gl!.TEXTURE1)
        gl!.bindTexture(gl!.TEXTURE_2D, sceneTex)
        gl!.generateMipmap(gl!.TEXTURE_2D)
      }

      // Pass 2 — glass to the screen. Everything but the clock and the
      // darkness is resize-invariant and uploaded once in uploadGlassStatics().
      // The darkness goes up every frame, not only the scene-refresh ones, so
      // the seam and grain track the scroll at the full frame rate even while
      // the backdrop behind them is a frame stale.
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, null)
      gl!.viewport(0, 0, canvas.width, canvas.height)
      gl!.useProgram(glassProg)
      gl!.uniform1f(uTime, tSec)
      gl!.uniform1f(uDarkGlass, darkness)
      gl!.drawArrays(gl!.TRIANGLES, 0, 3)
    }

    // Glass-pass uniforms that depend only on canvas size / dpr, not time.
    // Uploaded once per resize; uniform state persists on the program until
    // it's next changed, so the per-frame path only has to touch uTime.
    function uploadGlassStatics() {
      const m = Math.min(canvas.width, canvas.height)
      const a = (AXIS_DEG * Math.PI) / 180
      gl!.useProgram(glassProg)
      gl!.uniform2f(uRes, canvas.width, canvas.height)
      gl!.uniform1f(uLod, Math.log2(Math.max(BLUR_PX * dpr * FBO_SCALE, 1)))
      gl!.uniform1f(uPeriod, m * PERIOD_FRAC)
      gl!.uniform2f(uAxis, Math.cos(a), Math.sin(a))
      gl!.uniform1f(uThick, m * THICK_FRAC)
    }

    function resize() {
      const rect = wrap.getBoundingClientRect()
      dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      allocFBO(canvas.width, canvas.height)
      uploadGlassStatics()
      if (reducedMotion || !running) render(reducedMotion ? 40 : lastT)
    }

    return { render, resize }
  }

  /* ── Canvas2D fallback backend ──
     Same per-pixel glass math, but the blurred scene behind the glass is
     sampled analytically — a soft-edged gradient blob is what a 45px blur
     of the sphere looks like, so no actual blur pass is needed. Runs at a
     small fixed resolution into ImageData, upscaled by the browser. */
  function startCPU(): Impl {
    if (glTouched) {
      const fresh = document.createElement("canvas")
      fresh.id = canvas.id
      fresh.className = canvas.className
      canvas.replaceWith(fresh)
      canvas = fresh
      glTouched = false
    }
    // Same guard as the GL path: a throwing/null getContext must not escape
    // createGlassScene. With no 2D context there's nothing to draw into, so
    // the scene degrades to inert no-ops over the blank canvas.
    let ctx2d: CanvasRenderingContext2D | null = null
    try {
      ctx2d = canvas.getContext("2d")
    } catch {
      ctx2d = null
    }
    if (!ctx2d) return { render: () => {}, resize: () => {} }
    const ctx = ctx2d
    const W = 520
    let H = 300
    let cssH = 1 // wrap height in CSS px, for scroll-lift conversion
    let img: ImageData
    let buf: Uint8ClampedArray

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t
    const sstep = smoothstep

    // One object's ramp ≈ the GL gradient layers after the 45px blur:
    // a top→bottom ramp with a bright lower rim, in the object's colors.
    // Writes into objCol (runs per covered pixel — must not allocate).
    const objCol = [0, 0, 0]
    function objColor(
      t: number,
      ga0: number[],
      ga1: number[],
      gbMix: number,
      dim: number,
    ) {
      const s = sstep(0, 0.8, t)
      const w = sstep(0.8, 1, t)
      const dark = (1 - gbMix * (1 - w) * 0.5) * dim // gradient B darkening
      objCol[0] =
        255 * Math.min(1, lerp(lerp(ga0[0], ga1[0], s) * dark, dim, w))
      objCol[1] =
        255 * Math.min(1, lerp(lerp(ga0[1], ga1[1], s) * dark, dim, w))
      objCol[2] =
        255 * Math.min(1, lerp(lerp(ga0[2], ga1[2], s) * dark, dim, w))
    }

    // Reusable per-object scratch — the static fields (color, shape) are set
    // once here; render() only rewrites cx/cyd/R/a each frame, so the hot path
    // does no per-frame array/object allocation. `RB` is the bounding half-
    // extent including the blur skirt: two compares against it reject the vast
    // majority of (pixel, object) pairs before the sqrt.
    const objs = OBJECTS.map((o) => ({
      cx: 0,
      cyd: 0,
      R: 0,
      RB: 0,
      a: 1,
      cube: o.shape === 1,
      ga0: o.ga0,
      ga1: o.ga1,
      gbMix: o.gbMix,
      dim: o.dim ?? 1,
    }))
    // Objects worth testing this frame (on screen and not faded out), refilled
    // per frame. Scenes can carry more objects than are ever visible at once —
    // the hero's three plus a whole second set for the dark half — and the
    // per-pixel loop should only pay for the ones actually in frame.
    const active: (typeof objs)[number][] = []

    function render(tSec: number, sceneDirty = true) {
      // Unlike the GL backend there's no cheap glass-only pass here — the
      // whole frame is the expensive scene recompute — so the SCENE_FPS_CAP
      // gate skips the entire frame and the canvas keeps its last image.
      if (!sceneDirty) return
      smoothPointer()
      stepScroll()
      const m = Math.min(W, H)
      const blur = m * 0.06 // the baked-in "45px" softness
      const period = m * PERIOD_FRAC
      const thick = m * THICK_FRAC
      const a = (AXIS_DEG * Math.PI) / 180
      // y-down perp of the y-up axis direction
      const pxv = -Math.sin(a)
      const pyv = -Math.cos(a)
      const eta = 1 / IOR
      let seed = (tSec * 61.7) % 1

      // The backdrop is one flat colour, and so are the three numbers the
      // material adapts with it — all four resolve once per frame.
      const bgR = lerp(BG[0], BG_DARK[0], darkness) * 255
      const bgG = lerp(BG[1], BG_DARK[1], darkness) * 255
      const bgB = lerp(BG[2], BG_DARK[2], darkness) * 255
      const seamDark = SEAM_DARK * lerp(1, DARK_SEAM, darkness)
      const seamLift = G_FRES.mix * (1 - darkness)
      const seamSink = DARK_SEAM_SINK * sstep(SINK_IN[0], SINK_IN[1], darkness)
      const grainLum = GRAIN_LUM * lerp(1, DARK_GRAIN, darkness)

      // Per-frame object centers (y-down) — computed once, not per pixel —
      // then narrowed to the ones that can actually touch a pixel this frame.
      layoutObjects(tSec, W, H, H / Math.max(cssH, 1))
      active.length = 0
      for (let o = 0; o < OBJECTS.length; o++) {
        const ob = objs[o]
        ob.a = alphaBuf[o]
        if (ob.a < 0.002) continue
        ob.cx = cxBuf[o]
        ob.cyd = H - cyBuf[o] // ImageData is y-down
        ob.R = m * OBJECTS[o].rFrac
        ob.RB = ob.R + blur
        // Off-screen by more than the displacement the glass can reach.
        if (
          ob.cx < -ob.RB - thick ||
          ob.cx > W + ob.RB + thick ||
          ob.cyd < -ob.RB - thick ||
          ob.cyd > H + ob.RB + thick
        )
          continue
        active.push(ob)
      }

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const nx = fractCell(x * pxv + y * pyv, period)
          const ny = Math.sqrt(Math.max(1 - nx * nx, 1e-5))
          // 2D refract of (0,−1) about (nx, ny)
          const cosi = ny
          const k = 1 - eta * eta * (1 - cosi * cosi)
          const tx = -eta * 0 + (eta * cosi - Math.sqrt(Math.max(k, 0))) * nx
          const ty = -eta * 1 + (eta * cosi - Math.sqrt(Math.max(k, 0))) * ny
          const shift = (tx / Math.max(Math.abs(ty), 0.05)) * thick
          const sx = x + pxv * shift
          const sy = y + pyv * shift

          // analytic blurred scene — objects composited back-to-front over
          // the flat backdrop
          let r = bgR
          let g = bgG
          let b = bgB
          for (let o = 0; o < active.length; o++) {
            const ob = active[o]
            const dx = sx - ob.cx
            const dy = sy - ob.cyd
            if (dx < -ob.RB || dx > ob.RB || dy < -ob.RB || dy > ob.RB) continue
            let cov: number
            if (ob.cube) {
              // rounded-box distance ≈ the GL cube silhouette
              const qx = Math.abs(dx) - ob.R * 0.82
              const qy = Math.abs(dy) - ob.R * 0.82
              const sd =
                Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
                Math.min(Math.max(qx, qy), 0)
              cov = 1 - sstep(-blur, blur, sd)
            } else {
              const d = Math.sqrt(dx * dx + dy * dy)
              cov = 1 - sstep(ob.R - blur, ob.R + blur, d)
            }
            cov *= ob.a
            if (cov > 0) {
              const t = Math.min(1, Math.max(0, (dy + ob.R) / (2 * ob.R)))
              objColor(t, ob.ga0, ob.ga1, ob.gbMix, ob.dim)
              r = lerp(r, objCol[0], cov)
              g = lerp(g, objCol[1], cov)
              b = lerp(b, objCol[2], cov)
            }
          }

          // fresnel seam + dark line, both scaled by the backdrop's darkness
          let fr = G_FRES.bias + G_FRES.scale * Math.pow(1 - ny, G_FRES.pow)
          fr = Math.min(1, Math.max(0, fr))
          const seam = fr * fr
          const wht = seam * seamLift
          const drk = 1 - fr * seamDark
          const snk = 1 - seam * seam * seamSink
          r = lerp(r * drk, 255, wht) * snk
          g = lerp(g * drk, 255, wht) * snk
          b = lerp(b * drk, 255, wht) * snk

          // grain
          const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
          const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255
          seed = (seed * 16807 + 0.123456789) % 1
          const gr =
            (seed - 0.5) * 255 * (sat * GRAIN_SAT + (1 - lum) * grainLum)

          const i = (y * W + x) * 4
          buf[i] = r + gr
          buf[i + 1] = g + gr
          buf[i + 2] = b + gr
          buf[i + 3] = 255
        }
      }
      ctx.putImageData(img, 0, 0)
    }

    function fractCell(d: number, period: number) {
      const f = d / period
      return (f - Math.floor(f)) * 2 - 1
    }

    function resize() {
      const rect = wrap.getBoundingClientRect()
      cssH = rect.height
      H = Math.max(1, Math.round((W * rect.height) / Math.max(rect.width, 1)))
      canvas.width = W
      canvas.height = H
      img = ctx.createImageData(W, H)
      buf = img.data
      if (reducedMotion || !running) render(reducedMotion ? 40 : lastT)
    }

    return { render, resize }
  }

  const glImpl = startGL()
  if (glImpl) {
    impl = glImpl
  } else {
    impl = startCPU()
    onCPUFallback?.()
  }

  return {
    start,
    stop,
    resize: () => impl.resize(),
    render: (tSec: number) => impl.render(tSec),
    setScrollTarget(pxLift: number, channel = 0) {
      if (channel < 0 || channel >= CHANNELS) return
      if (scrollTargets[channel] === pxLift) return
      scrollTargets[channel] = pxLift
      // No raf loop under reduced motion — snap and repaint the static frame
      // so any scroll-linked parallax still tracks the page.
      if (reducedMotion) {
        scrollLifts[channel] = pxLift
        repaintStatic()
      }
    },
    setDarkness(t: number) {
      const v = t < 0 ? 0 : t > 1 ? 1 : t
      if (v === darkness) return
      darkness = v
      repaintStatic()
    },
  }
}
