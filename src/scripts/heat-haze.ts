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
 *     the road does;
 *   · the far edge of the flat ground boils too, so a thin strip of the same
 *     shimmer runs along the horizon either side of the road, level with the
 *     road haze's top edge.
 *
 * All of it is measured in the *full photo's* UV space, so it stays glued to
 * the road however `object-fit: cover` crops the photo, and whichever cut of
 * it (full or portrait) the page has loaded. The <img> underneath is the real
 * background: this canvas covers only the band of it the shimmer lives in,
 * is transparent wherever the shimmer is not, and never appears at all
 * without WebGL2 or under reduced motion. Kept to that band it can render at
 * the screen's full pixel density cheaply, so the photo stays as crisp under
 * the canvas as around it.
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

/* ── Horizon line ──
   A thin strip of the same shimmer laid along the horizon, where the
   foreground grass meets the flat distant plain. Seen from standing height,
   the far ground's edge boils like the far road does. It sits level with the
   road haze's top edge (the crest less RISE), which is also where the horizon
   falls in the photo. It spans the flat stretch between the rocky ridge on
   the left and the rising ground on the right (image UV x), and fades out
   over LINE_FEATHER at each end. */
const LINE_Y = CREST_Y - RISE
const LINE_X = [0.4, 0.65]
const LINE_FEATHER = 0.025
const LINE_HALF_H = 0.0035 // gaussian half-height, UV y (≈5px of the photo)
const LINE_STRENGTH = 0.8 // peak, relative to the road haze at the crest

/* ── Canvas band ──
   Everything above reaches no higher than the horizon strip's faint top edge
   (≈0.427) and no lower than the road haze's fade (CREST_Y + FADE[1] × REACH
   ≈ 0.617), so the canvas spans just CANVAS_Y of the photo's height, full
   width. The texture spans a little more, TEX_Y, for the distortion and the
   mirage (which reads up to ≈0.02 above the crest) to sample from. */
const CANVAS_Y = [0.42, 0.62]
const TEX_Y = [0.4, 0.64]
// Device pixel ratio ceiling. The band is small enough to afford full density
// on any current screen.
const MAX_DPR = 3

export type HeatHaze = {
  start(): void
  stop(): void
  resize(): void
  /** re-read the photo after it has loaded a different source */
  reload(): void
}

export type HeatHazeOptions = {
  canvas: HTMLCanvasElement
  /** the box the photo is cover-fitted to; the canvas is placed inside it */
  frame: HTMLElement
  /** the decoded background photo */
  img: HTMLImageElement
  /** its current source: the file's width in pixels (naturalWidth won't do,
   *  as for a srcset pick it is scaled by the pick's density) and where it
   *  sits in the full photo, as UV (x, y, width, height) — [0, 0, 1, 1]
   *  unless it is a cut of it */
  source: () => { width: number; rect: readonly number[] }
  /** fires once the first distorted frame is on the canvas */
  onReady?: () => void
  /** fires if the GL context is lost; the caller should hide the canvas */
  onLost?: () => void
}

/** Returns null when WebGL2 is unavailable — the photo alone is the fallback. */
export function createHeatHaze(opts: HeatHazeOptions): HeatHaze | null {
  const { canvas, frame, img, source, onReady, onLost } = opts

  let gl: WebGL2RenderingContext | null = null
  try {
    gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: true,
      premultipliedAlpha: true,
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
    uniform vec4 uToUv;    // canvas device px (y-down) -> photo UV: xy * px + zw
    uniform vec4 uTexRect; // the texture's rect in photo UV (x, y, w, h)
    uniform float uAspect; // full photo width / height
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

    // The shimmer's noise at noise-space point g: the slow warp (xy), the
    // fine ripple (z) and the blur-patch field (w)
    vec4 haze(vec2 g) {
      // Slow boil — the Hermeus warp, drifting away from the viewer
      vec3 wq = vec3(g + vec2(0.0, uTime * 0.6), uTime * 0.5);
      vec2 warp = vec2(fbm(wq), fbm(wq + vec3(5.2, 1.3, 7.7)));
      // Fine shimmer — tight horizontal striations climbing quickly
      float rip = noise(vec3(g.x * 3.0, g.y * 2.5 + uTime * 6.0, uTime * 1.5)) - 0.5;
      // Drifting blur patches: pockets of hotter air
      float bn = fbm(vec3(g * vec2(0.5, 0.6) + vec2(uTime * 0.1, uTime * 0.3), uTime * 0.3));
      return vec4(warp, rip, bn);
    }

    // The photo at UV p, from the texture's band of it
    vec4 photo(vec2 p, float lod) {
      return textureLod(uImg, clamp((p - uTexRect.xy) / uTexRect.zw, 0.0, 1.0), lod);
    }

    void main() {
      // gl_FragCoord is y-up; the image is y-down
      vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
      vec2 uv = px * uToUv.xy + uToUv.zw;

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
      float mRoad = inBand * env;

      // The horizon strip, handing over to the road haze where they meet so
      // the two never stack
      float ly = (uv.y - ${f1(LINE_Y)}) / ${f1(LINE_HALF_H)};
      float lx = smoothstep(${f1(LINE_X[0] - LINE_FEATHER)}, ${f1(LINE_X[0])}, uv.x)
               * (1.0 - smoothstep(${f1(LINE_X[1])}, ${f1(LINE_X[1] + LINE_FEATHER)}, uv.x));
      float mLine = exp(-ly * ly) * lx * ${f1(LINE_STRENGTH)} * (1.0 - mRoad);

      // Transparent where there is nothing to distort, so the <img> beneath
      // shows through; faded in over the mask's faint fringe, where what the
      // canvas draws is all but identical to it anyway
      float alpha = smoothstep(0.004, 0.04, mRoad + mLine);
      if (alpha == 0.0) {
        outColor = vec4(0.0);
        return;
      }

      // Road: ground-plane coordinates. Depth runs as log(h), lateral as
      // offset over h, so a fixed noise cell covers less and less of the
      // screen the further down the road it lies — the shimmer tightens with
      // the road.
      vec4 hr = vec4(0.0);
      if (mRoad >= 0.004) {
        hr = haze(vec2((uv.x - center) * uAspect / h * 0.5, log(h) * 2.5)
                  * ${f1(TIGHTEN)});
      }
      // Horizon: everything on it is equally far off, so it gets flat
      // coordinates at the density the road's noise has at the crest
      vec4 hl = vec4(0.0);
      if (mLine >= 0.004) {
        hl = haze(vec2(uv.x * uAspect * ${f1((0.5 / (CREST_Y - HORIZON_Y)) * TIGHTEN)},
                       uv.y * ${f1((2.5 / (CREST_Y - HORIZON_Y)) * TIGHTEN)}));
      }

      vec2 dr = hr.xy * vec2(${f1(WARP_AMP[0])}, ${f1(WARP_AMP[1])})
              + hr.z * vec2(${f1(RIPPLE_AMP[0])}, ${f1(RIPPLE_AMP[1])});
      vec2 dl = hl.xy * vec2(${f1(WARP_AMP[0])}, ${f1(WARP_AMP[1])})
              + hl.z * vec2(${f1(RIPPLE_AMP[0])}, ${f1(RIPPLE_AMP[1])});
      vec2 d = (dr * mRoad + dl * mLine) * ${f1(2 * INTENSITY)};
      vec2 suv = uv + vec2(d.x / uAspect, d.y);

      // Blur patches, as a mip bias
      float blur = (smoothstep(-0.05, 0.25, hr.w) * mRoad
                  + smoothstep(-0.05, 0.25, hl.w) * mLine)
                  * ${f1(BLUR_BIAS * INTENSITY)};

      // Explicit LOD: these reads sit behind the early-out, where implicit
      // derivatives are undefined
      vec4 col = photo(suv, uLod + blur);

      // Inferior mirage: just past the crest the asphalt mirrors what sits
      // above it, flickering with the warp
      float strip = smoothstep(0.0, 0.002, dy) * (1.0 - smoothstep(0.006, 0.016, dy));
      float mir = onRoad * strip * smoothstep(-0.15, 0.15, hr.x) * ${f1(MIRAGE * INTENSITY)};
      if (mir > 0.001) {
        vec2 ruv = vec2(suv.x, CREST_Y - dy * 1.3 + d.y * 3.0);
        col = mix(col, photo(ruv, uLod + blur + 0.5), mir);
      }

      outColor = vec4(col.rgb * alpha, alpha);
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

  // The photo's band (TEX_Y), mipmapped so the blur patches are a free LOD
  // bias. Filled in by reload().
  const tex = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const uRes = gl.getUniformLocation(prog, "uRes")
  const uToUv = gl.getUniformLocation(prog, "uToUv")
  const uTexRect = gl.getUniformLocation(prog, "uTexRect")
  const uAspect = gl.getUniformLocation(prog, "uAspect")
  const uTime = gl.getUniformLocation(prog, "uTime")
  const uLod = gl.getUniformLocation(prog, "uLod")
  gl.uniform1i(gl.getUniformLocation(prog, "uImg"), 0)

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

  // The source the texture was cut from: its natural size and where it sits
  // in the full photo. Kept apart from the <img>, which may already be
  // loading its next source, so the mapping always matches the texture.
  let src: { nw: number; nh: number; rect: readonly number[] } | null = null
  let loadId = 0

  function reload() {
    const id = ++loadId
    if (!img.naturalWidth || !img.naturalHeight) return
    const { width: nw, rect } = source()
    const nh = Math.round((nw * img.naturalHeight) / img.naturalWidth)
    // This source's rows that cover TEX_Y
    const toRow = (v: number) => ((v - rect[1]) / rect[3]) * nh
    const r0 = Math.max(0, Math.floor(toRow(TEX_Y[0])))
    const r1 = Math.min(nh, Math.ceil(toRow(TEX_Y[1])))
    if (r1 <= r0) return
    createImageBitmap(img, 0, r0, nw, r1 - r0)
      .then((bmp) => {
        if (id !== loadId || lost) {
          bmp.close()
          return
        }
        gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, bmp)
        gl!.generateMipmap(gl!.TEXTURE_2D)
        bmp.close()
        src = { nw, nh, rect }
        gl!.uniform4f(
          uTexRect,
          rect[0],
          rect[1] + (r0 / nh) * rect[3],
          rect[2],
          ((r1 - r0) / nh) * rect[3],
        )
        gl!.uniform1f(uAspect, nw / rect[2] / (nh / rect[3]))
        resize()
      })
      .catch(() => {})
  }

  let ready = false
  function draw(tSec: number) {
    if (lost || !src) return
    gl!.uniform1f(uTime, tSec)
    gl!.drawArrays(gl!.TRIANGLES, 0, 3)
    if (!ready) {
      ready = true
      onReady?.()
    }
  }

  /* Sizes and places the canvas over CANVAS_Y of the photo as CSS
     `object-fit: cover; object-position: center` lays it out in the frame,
     snapped to whole device pixels, and maps the canvas's pixels back to
     photo UV so it lands pixel-for-pixel on the <img> it is drawn over. */
  function resize() {
    if (lost || !src) return
    const { nw, nh, rect } = src
    const { width: fw, height: fh } = frame.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
    // The cover fit: CSS px per source px, and the source's top-left corner
    const s = Math.max(fw / nw, fh / nh)
    const ox = (fw - nw * s) / 2
    const oy = (fh - nh * s) / 2
    // Photo UV y -> frame device px
    const yAt = (v: number) => (oy + ((v - rect[1]) / rect[3]) * nh * s) * dpr
    const maxY = Math.round(fh * dpr)
    const top = Math.min(maxY, Math.max(0, Math.floor(yAt(CANVAS_Y[0]))))
    const bottom = Math.min(maxY, Math.max(top, Math.ceil(yAt(CANVAS_Y[1]))))

    canvas.style.top = `${top / dpr}px`
    canvas.style.height = `${(bottom - top) / dpr}px`
    canvas.width = Math.max(1, Math.round(fw * dpr))
    canvas.height = Math.max(1, bottom - top)
    gl!.viewport(0, 0, canvas.width, canvas.height)
    gl!.uniform2f(uRes, canvas.width, canvas.height)

    // Canvas px -> frame CSS px -> photo UV
    const kx = fw / canvas.width
    gl!.uniform4f(
      uToUv,
      (kx / (nw * s)) * rect[2],
      (1 / dpr / (nh * s)) * rect[3],
      rect[0] - (ox / (nw * s)) * rect[2],
      rect[1] + ((top / dpr - oy) / (nh * s)) * rect[3],
    )
    // Device px per texel sets the base mip level
    gl!.uniform1f(uLod, Math.max(0, -Math.log2((s * canvas.width) / fw)))
    draw(lastT)
  }

  // The frame is sized off the large viewport, so mobile toolbar show/hide
  // doesn't reach it — only real viewport changes do. Coalesced onto a frame.
  let resizePending = false
  new ResizeObserver(() => {
    if (resizePending) return
    resizePending = true
    requestAnimationFrame(() => {
      resizePending = false
      resize()
    })
  }).observe(frame)

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

  reload()

  return { start, stop, resize, reload }
}
