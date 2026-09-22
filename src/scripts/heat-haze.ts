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
 * layers are generated per pixel in a fragment shader instead, confined to a
 * band along the horizon where the road runs out. On top of those sits a
 * fine, fast ripple climbing the band (the part of real road shimmer a slow
 * warp misses) and a faint inferior mirage: just below the horizon, the far
 * stretch of asphalt picks up a wobbling reflection of what is above it.
 *
 * All of it is measured in *image* space, so the band stays glued to the
 * road however `object-fit: cover` crops the photo. The <img> underneath is
 * the real background — this canvas only draws over it once the texture is
 * up, and simply never appears without WebGL2 or under reduced motion.
 */

/* ── Where the road is ──
   The vanishing point, in image UV (x from left, y down from top), read off
   the source photo: the far end of the centre line, where the road meets the
   horizon. Everything else is placed relative to it. */
const VP = [0.515, 0.443]
// Road half-width grows by this much (UV x) per unit of UV y below the horizon
const ROAD_SLOPE = 1.9

/* ── Band ──
   Gaussian falloffs either side of the horizon, in UV y. Hot air hugs the
   ground, so the band reaches further down the road than up into the air. */
const BAND_UP = 0.045
const BAND_DOWN = 0.06
// Band strength far from the road, relative to directly over it — the desert
// floor shimmers too, just less than the black asphalt
const BAND_OFF_ROAD = 0.35
const BAND_ROAD_W = 0.3 // gaussian width of the road-centred boost, UV x

/* ── Distortion ──
   Amplitudes are fractions of the image height, so the effect scales with the
   photo rather than with device pixels. */
const WARP_AMP = [0.007, 0.0045] // Hermeus-style slow warp (x, y)
const RIPPLE_AMP = [0.0015, 0.003] // fine rising shimmer (x, y)
const BLUR_BIAS = 2.4 // peak mip bias of the drifting blur patches
const MIRAGE = 0.4 // peak mix of the reflected strip on the far road

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

  const f1 = (x: number) => x.toFixed(4)

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

    const vec2 VP = vec2(${f1(VP[0])}, ${f1(VP[1])});

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

      // Band: asymmetric gaussian about the horizon, boosted over the road
      float dy = uv.y - VP.y;
      float bw = dy < 0.0 ? ${f1(BAND_UP)} : ${f1(BAND_DOWN)};
      float band = exp(-(dy * dy) / (bw * bw));
      float dx = uv.x - VP.x;
      float road = exp(-(dx * dx) / ${f1(BAND_ROAD_W * BAND_ROAD_W)});
      float m = band * mix(${f1(BAND_OFF_ROAD)}, 1.0, road);

      if (m < 0.004) {
        outColor = textureLod(uImg, uv, uLod);
        return;
      }

      // Noise lives in square units (image height = 1) so its cells are round
      vec3 q = vec3(uv.x * uAspect, uv.y, uTime);

      // Slow warp — broad blobs that bend whatever is behind them, drifting
      // upward like the air they stand in for
      vec3 wq = vec3(q.xy * vec2(9.0, 16.0) + vec2(0.0, uTime * 0.3), uTime * 0.35);
      vec2 warp = vec2(fbm(wq), fbm(wq + vec3(5.2, 1.3, 7.7)));

      // Fine shimmer — tight horizontal striations climbing quickly
      float rip = noise(vec3(q.x * 16.0, q.y * 150.0 + uTime * 5.0, uTime * 1.3)) - 0.5;

      vec2 d = (warp * vec2(${f1(WARP_AMP[0])}, ${f1(WARP_AMP[1])})
             + rip * vec2(${f1(RIPPLE_AMP[0])}, ${f1(RIPPLE_AMP[1])})) * 2.0 * m;
      vec2 suv = uv + vec2(d.x / uAspect, d.y);

      // Drifting blur patches: pockets of hotter air, as a mip bias
      float bn = fbm(vec3(q.xy * vec2(4.0, 7.0) + vec2(uTime * 0.07, uTime * 0.2), uTime * 0.25));
      float blur = smoothstep(-0.05, 0.25, bn) * m * ${f1(BLUR_BIAS)};

      // Explicit LOD: these reads sit behind the band's early-out, where
      // implicit derivatives are undefined
      vec4 col = textureLod(uImg, clamp(suv, 0.0, 1.0), uLod + blur);

      // Inferior mirage: on the far road just past the horizon, mirror what
      // sits above it. Masked to the road's wedge and flickered by the warp.
      float rw = max(dy, 0.0) * ${f1(ROAD_SLOPE)};
      float onRoad = 1.0 - smoothstep(rw * 0.7, rw + 0.004, abs(dx));
      float depth = smoothstep(0.0, 0.004, dy) * (1.0 - smoothstep(0.012, 0.04, dy));
      float mir = onRoad * depth * smoothstep(-0.2, 0.2, warp.x) * ${f1(MIRAGE)};
      if (mir > 0.001) {
        vec2 ruv = vec2(suv.x, VP.y - dy * 1.4 + d.y * 3.0);
        col = mix(col, textureLod(uImg, clamp(ruv, 0.0, 1.0), uLod + blur + 1.0), mir);
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
