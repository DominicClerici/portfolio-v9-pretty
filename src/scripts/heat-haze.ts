/*
 * Heat haze over the footer's desert road.
 *
 * Modelled on the hero at hermeus.com, where "Building Fast Planes. Fast."
 * shimmers as if seen through a jet's exhaust. Theirs is not live: it is 90
 * pre-rendered After Effects frames (440×60, 30fps, a 3s loop) played back as a
 * Lottie image sequence. Stepping through them, the look is two things layered:
 *
 *   · a slow, low-frequency warp that bends whole letterforms, and
 *   · soft blurred patches that drift through it, as if some pockets of air
 *     are hotter than others.
 *
 * A baked loop only works for a fixed-size strip of copy. The footer photo is
 * full-bleed and cropped differently at every viewport, so here the same two
 * layers are generated per pixel in a fragment shader instead, along with a
 * fine ripple climbing through them and a faint inferior mirage (the far
 * asphalt picking up a wobbling reflection of what is above it).
 *
 * Unlike Hermeus's, this one has to pass for the real thing, so it behaves
 * the way road shimmer does:
 *
 *   · it lives over the asphalt only, inside the road's own wedge, and spills
 *     just a few pixels into the air above the road's far edge;
 *   · it grows with distance. Looking down the road, the sightline skims ever
 *     more hot air, so the near road is barely touched and the effect peaks
 *     where the road goes over the crest;
 *   · its texture is laid out on the ground plane rather than the screen, so
 *     the ripples crowd together and tighten toward the horizon exactly as
 *     the road does.
 *
 * All of it is measured in *image* space, so it stays glued to the road
 * however `object-fit: cover` crops the photo. The <img> underneath is the
 * real background — this canvas only draws over it once the texture is up,
 * and simply never appears without WebGL2 or under reduced motion.
 */

/* ── Where the road is ──
   Measured off the source photo (2000×1333), in image UV: x from the left,
   y down from the top. */
// The road's top visible edge, where it drops over the crest…
const CREST_Y = 0.4411
// …and its left/right ends there. It is ~70px wide, a little right of centre.
const CREST_X = [0.494, 0.529]
// How fast each edge spreads outward (UV x per UV y) below the crest. The
// camera sits a touch left of the road's centre, so the two differ.
const EDGE_SLOPE = [1.533, 1.366]
// Where the two edges would meet if the road ran on flat: the vanishing
// point's height. Distance down the road goes as 1 / (y − HORIZON_Y).
const HORIZON_Y = 0.43

/* ── Extent ──
   Intensity follows distance, normalised to 1 at the crest and shaped by
   FALLOFF — higher leaves more of the near road alone. It is then faded out
   entirely across FADE (UV y below the crest), and above the crest it only
   rises RISE into the air before stopping. */
const FALLOFF = 1.3
const FADE = [0.025, 0.075]
const RISE = 0.006 // ≈8px of the source photo
// Feather past the road's edges: a fixed margin plus a share of the width
const EDGE_FEATHER = [0.003, 0.12]
// Scales the shape above without retuning it. WIDEN widens the mask about the
// road's centre line (1.25 = 12.5% more on each side, feather included).
// REACH stretches everything below the crest (the distance falloff and FADE
// together) further down the road; the top cutoff stays where it is. At
// REACH 1 the shape spans RISE + FADE[1] = 0.081 of the image height; at
// 2.3392 it spans 0.1814, i.e. 1.4 × 1.6 of that.
const WIDEN = 3.125 // 1.25 × 2.5
const REACH = 2.3392

/* ── Distortion ──
   Amplitudes are fractions of the image height at full intensity, so the
   effect scales with the photo rather than with device pixels. INTENSITY
   scales all four together: the warp and ripple amplitudes, the blur, and
   the mirage. The noise scale is separate, so it stays just as tight. */
const INTENSITY = 1.3
// Density of the noise pattern: higher means smaller, tighter ripples. The
// finest ripple rows at the crest are ~1.6px of the source photo here, so
// much past this they break up into per-pixel flicker.
const TIGHTEN = 1.5
const WARP_AMP = [0.0016, 0.0013] // slow boiling warp (x, y)
const RIPPLE_AMP = [0.0005, 0.0012] // fine rising shimmer (x, y)
const BLUR_BIAS = 1.3 // peak mip bias of the drifting blur patches
const MIRAGE = 0.35 // peak mix of the reflection just past the crest

export type HeatHaze = {
  start(): void
  stop(): void
  resize(): void
}

export type HeatHazeOptions = {
  canvas: HTMLCanvasElement
  /** the decoded background photo; its natural size drives the cover fit */
  img: HTMLImageElement
  /** fires once the first distorted frame is on the canvas */
  onReady?: () => void
  /** fires if the GL context is lost; the caller should hide the canvas */
  onLost?: () => void
}

/** Returns null when WebGL2 is unavailable — the photo alone is the fallback. */
export function createHeatHaze(opts: HeatHazeOptions): HeatHaze | null {
  const { canvas, img, onReady, onLost } = opts

  let gl: WebGL2RenderingContext | null = null
  try {
    gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      powerPreference: "low-power",
    })
  } catch {
    gl = null
  }
  if (!gl) return null

  const f1 = (x: number) => x.toFixed(5)

  const VS = `#version 300 es
    layout(location = 0) in vec2 aPos;
    void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

  const FS = `#version 300 es
    precision highp float;
    uniform sampler2D uImg;
    uniform vec2 uRes;     // canvas size, device px
    uniform vec2 uScale;   // device px -> image UV (the cover fit)
    uniform float uAspect; // image width / height
    uniform float uTime;
    uniform float uLod;    // mip level matching the cover fit's minification
    out vec4 outColor;

    const float CREST_Y = ${f1(CREST_Y)};
    const vec2 CREST_X = vec2(${f1(CREST_X[0])}, ${f1(CREST_X[1])});
    const vec2 EDGE_SLOPE = vec2(${f1(EDGE_SLOPE[0])}, ${f1(EDGE_SLOPE[1])});
    const float HORIZON_Y = ${f1(HORIZON_Y)};

    // Cheap 3D value noise — the third axis is time, so the pattern boils in
    // place instead of just scrolling past.
    float hash(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float noise(vec3 x) {
      vec3 i = floor(x);
      vec3 f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
            mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
        mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
            mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
        f.z);
    }
    // Three octaves, centred on zero (range about ±0.44)
    float fbm(vec3 p) {
      float s = 0.0;
      float a = 0.5;
      for (int i = 0; i < 3; i++) {
        s += a * noise(p);
        p = p * 2.03 + vec3(17.1, 3.7, 0.0);
        a *= 0.5;
      }
      return s - 0.4375;
    }

    void main() {
      // gl_FragCoord is y-up; the image is y-down
      vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
      vec2 uv = (px - 0.5 * uRes) * uScale + 0.5;

      // dy: how far below the crest (negative above it)
      float dy = uv.y - CREST_Y;
      float below = max(dy, 0.0);

      // The road's wedge at this height — above the crest it is the crest's
      // own width, so the spill into the air sits squarely over the road
      vec2 edge = CREST_X + vec2(-EDGE_SLOPE.x, EDGE_SLOPE.y) * below;
      float center = 0.5 * (edge.x + edge.y);
      float halfW = 0.5 * (edge.y - edge.x);
      float feather = ${f1(EDGE_FEATHER[0])} + halfW * ${f1(EDGE_FEATHER[1])};
      float off = abs(uv.x - center);
      // The asphalt itself (the mirage keeps to this)…
      float onRoad = 1.0 - smoothstep(halfW, halfW + feather, off);
      // …and the haze, which reaches WIDEN times as far out
      float inBand = 1.0 - smoothstep(halfW, halfW + feather, off / ${f1(WIDEN)});

      // Distance down the road (1 at the crest), and the extent envelope. The
      // envelope reads dy squeezed by REACH, which draws it further down the
      // road; the noise below still uses the true distance, so it stays tight.
      float h = max(uv.y - HORIZON_Y, 0.003);
      float dyE = below / ${f1(REACH)};
      float dist = pow(${f1(CREST_Y - HORIZON_Y)} / (${f1(CREST_Y - HORIZON_Y)} + dyE), ${f1(FALLOFF)});
      float env = dy < 0.0
        ? 1.0 - smoothstep(0.0, ${f1(RISE)}, -dy)
        : dist * (1.0 - smoothstep(${f1(FADE[0])}, ${f1(FADE[1])}, dyE));
      float m = inBand * env;

      if (m < 0.004) {
        outColor = textureLod(uImg, uv, uLod);
        return;
      }

      // Ground-plane coordinates: depth runs as log(h), lateral as offset
      // over h, so a fixed noise cell covers less and less of the screen the
      // further down the road it lies — the shimmer tightens with the road.
      vec2 g = vec2((uv.x - center) * uAspect / h * 0.5, log(h) * 2.5)
             * ${f1(TIGHTEN)};

      // Slow boil — the Hermeus warp, drifting away from the viewer
      vec3 wq = vec3(g + vec2(0.0, uTime * 0.6), uTime * 0.5);
      vec2 warp = vec2(fbm(wq), fbm(wq + vec3(5.2, 1.3, 7.7)));

      // Fine shimmer — tight horizontal striations climbing quickly
      float rip = noise(vec3(g.x * 3.0, g.y * 2.5 + uTime * 6.0, uTime * 1.5)) - 0.5;

      vec2 d = (warp * vec2(${f1(WARP_AMP[0])}, ${f1(WARP_AMP[1])})
             + rip * vec2(${f1(RIPPLE_AMP[0])}, ${f1(RIPPLE_AMP[1])}))
             * ${f1(2 * INTENSITY)} * m;
      vec2 suv = uv + vec2(d.x / uAspect, d.y);

      // Drifting blur patches: pockets of hotter air, as a mip bias
      float bn = fbm(vec3(g * vec2(0.5, 0.6) + vec2(uTime * 0.1, uTime * 0.3), uTime * 0.3));
      float blur = smoothstep(-0.05, 0.25, bn) * m * ${f1(BLUR_BIAS * INTENSITY)};

      // Explicit LOD: these reads sit behind the early-out, where implicit
      // derivatives are undefined
      vec4 col = textureLod(uImg, clamp(suv, 0.0, 1.0), uLod + blur);

      // Inferior mirage: just past the crest the asphalt mirrors what sits
      // above it, flickering with the warp
      float strip = smoothstep(0.0, 0.002, dy) * (1.0 - smoothstep(0.006, 0.016, dy));
      float mir = onRoad * strip * smoothstep(-0.15, 0.15, warp.x) * ${f1(MIRAGE * INTENSITY)};
      if (mir > 0.001) {
        vec2 ruv = vec2(suv.x, CREST_Y - dy * 1.3 + d.y * 3.0);
        col = mix(col, textureLod(uImg, clamp(ruv, 0.0, 1.0), uLod + blur + 0.5), mir);
      }

      outColor = col;
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
  const vs = compile(gl.VERTEX_SHADER, VS)
  const fs = compile(gl.FRAGMENT_SHADER, FS)
  if (!vs || !fs) return null
  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(prog))
    return null
  }
  gl.useProgram(prog)

  // One oversized triangle covers the viewport
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  )
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  // The photo, mipmapped so the blur patches are a free LOD bias
  const tex = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const uRes = gl.getUniformLocation(prog, "uRes")
  const uScale = gl.getUniformLocation(prog, "uScale")
  const uAspect = gl.getUniformLocation(prog, "uAspect")
  const uTime = gl.getUniformLocation(prog, "uTime")
  const uLod = gl.getUniformLocation(prog, "uLod")
  gl.uniform1i(gl.getUniformLocation(prog, "uImg"), 0)

  const iw = img.naturalWidth
  const ih = img.naturalHeight
  gl.uniform1f(uAspect, iw / ih)

  let lost = false
  canvas.addEventListener(
    "webglcontextlost",
    (e) => {
      e.preventDefault()
      lost = true
      stop()
      onLost?.()
    },
    { once: true },
  )

  let ready = false
  function draw(tSec: number) {
    if (lost) return
    gl!.uniform1f(uTime, tSec)
    gl!.drawArrays(gl!.TRIANGLES, 0, 3)
    if (!ready) {
      ready = true
      onReady?.()
    }
  }

  /* Matches CSS `object-fit: cover; object-position: center` exactly, so the
     canvas lands pixel-for-pixel on the <img> it is drawn over. */
  function resize() {
    if (lost) return
    const rect = canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    canvas.width = Math.max(1, Math.round(rect.width * dpr))
    canvas.height = Math.max(1, Math.round(rect.height * dpr))
    gl!.viewport(0, 0, canvas.width, canvas.height)
    const s = Math.max(canvas.width / iw, canvas.height / ih)
    gl!.uniform2f(uRes, canvas.width, canvas.height)
    gl!.uniform2f(uScale, 1 / (iw * s), 1 / (ih * s))
    gl!.uniform1f(uLod, Math.max(0, -Math.log2(s)))
    draw(lastT)
  }

  // The canvas is viewport-fixed, so it tracks the viewport — including the
  // mobile URL bar showing and hiding, which the footer's own box can miss
  // behind its min-height. Coalesced onto a frame; the first call is the
  // observer's initial notification.
  let resizePending = false
  new ResizeObserver(() => {
    if (resizePending) return
    resizePending = true
    requestAnimationFrame(() => {
      resizePending = false
      resize()
    })
  }).observe(canvas)

  let rafId: number | null = null
  let lastT = 0
  function loop(ms: number) {
    rafId = requestAnimationFrame(loop)
    lastT = ms / 1000
    draw(lastT)
  }
  function start() {
    if (rafId !== null || lost) return
    rafId = requestAnimationFrame(loop)
  }
  function stop() {
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null
  }

  return { start, stop, resize }
}
