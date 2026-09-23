/*
 * Heat haze over the footer's Yosemite river.
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
 * fine ripple climbing through them.
 *
 * Unlike Hermeus's, this one has to pass for the real thing, so it behaves
 * the way shimmer over a long flat surface does:
 *
 *   · it covers the whole river, bank to bank and down to the bottom of the
 *     frame, and rises just a little into the trees above its far end;
 *   · it grows with distance. Looking up the river, the sightline skims ever
 *     more warm air, so the effect peaks where the river bends out of sight
 *     and eases off toward the foreground;
 *   · its texture is laid out on the water's plane rather than the screen,
 *     so the ripples crowd together and tighten into the distance exactly as
 *     the river does.
 *
 * All of it is measured in the *full photo's* UV space, so it stays glued to
 * the river however `object-fit: cover` crops the photo, and whichever cut of
 * it (full or portrait) the page has loaded. The <img> underneath is the real
 * background: this canvas covers only the band of it the shimmer lives in,
 * is transparent wherever the shimmer is not, and never appears at all
 * without WebGL2 or under reduced motion. Kept to that band it can render at
 * the screen's full pixel density cheaply, so the photo stays as crisp under
 * the canvas as around it.
 */

/* ── Where the river is ──
   Measured off the source photo (5472×3648), in image UV: x from the left,
   y down from the top. */
// The water's far visible edge, where the river bends out of sight below El
// Capitan
const FAR_Y = 0.655
// The banks, as [y, left x, right x] from the far edge to the bottom of the
// photo, straight between. The river spreads like a road running away from
// the camera down to ≈0.78; below that the left bank runs out of frame and
// the right one stops under the overhanging leaves.
const BANKS = [
  [FAR_Y, 0.46, 0.545],
  [0.7, 0.44, 0.6],
  [0.74, 0.4, 0.64],
  [0.78, 0.22, 0.71],
  [0.82, -0.02, 0.74],
  [1, -0.02, 0.74],
]
// Where the banks of that first straight stretch (both spreading ≈1.3 UV x
// per UV y) would meet if it ran on flat: the vanishing point's height, and
// its line across the frame. Distance up the river goes as 1 / (y − HORIZON_Y).
const HORIZON_Y = 0.622
const AXIS_X = 0.5025
// Past this height below the horizon the noise stops spreading with the
// water plane. Left to grow, the foreground's ripples would be swells a
// third of the frame wide rather than a shimmer.
const NEAR_H = 0.15

/* ── Extent ──
   Intensity is 1 at the far edge and eases down to FOREGROUND at the bottom
   of the photo. Above the far edge it only rises RISE into the trees before
   stopping. */
const FOREGROUND = 0.6
const RISE = 0.012 // ≈44px of the source photo
// Feather past the banks: a fixed margin plus a share of the half-width
const BANK_FEATHER = [0.008, 0.1]

/* ── Distortion ──
   Amplitudes are fractions of the image height at full intensity, so the
   effect scales with the photo rather than with device pixels. INTENSITY
   scales all three together: the warp and ripple amplitudes and the blur.
   The noise scale is separate, so it stays just as tight. */
const INTENSITY = 1.3
// Density of the noise pattern: higher means smaller, tighter ripples.
const TIGHTEN = 1.5
const WARP_AMP = [0.0016, 0.0013] // slow boiling warp (x, y)
const RIPPLE_AMP = [0.0005, 0.0012] // fine rising shimmer (x, y)
const BLUR_BIAS = 1.3 // peak mip bias of the drifting blur patches

/* ── Canvas band ──
   Everything above reaches no higher than the rise over the far edge
   (FAR_Y − RISE ≈ 0.643) and runs on to the bottom of the photo, so the
   canvas spans CANVAS_Y of the photo's height, full width. The texture
   starts a little higher, TEX_Y, for the distortion to sample from. */
const CANVAS_Y = [0.64, 1]
const TEX_Y = [0.63, 1]
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
  /** its current source: the file's size in pixels (naturalWidth/Height
   *  won't do, as for a srcset pick they are divided by the pick's density
   *  and rounded) and where it sits in the full photo, as UV (x, y, width,
   *  height) — [0, 0, 1, 1] unless it is a cut of it */
  source: () => { width: number; height: number; rect: readonly number[] }
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
  const bankY = BANKS.map((b) => f1(b[0])).join(", ")
  const bankX = BANKS.map((b) => `vec2(${f1(b[1])}, ${f1(b[2])})`).join(", ")

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

    const float FAR_Y = ${f1(FAR_Y)};
    const int NB = ${BANKS.length};
    const float BANK_Y[NB] = float[NB](${bankY});
    const vec2 BANK_X[NB] = vec2[NB](${bankX});
    const float HORIZON_Y = ${f1(HORIZON_Y)};

    // The banks (left, right) at height y. Above the far edge they are the
    // far edge's own, so the rise into the trees sits squarely over the water.
    vec2 banks(float y) {
      for (int i = 1; i < NB; i++) {
        if (y <= BANK_Y[i]) {
          float t = clamp((y - BANK_Y[i - 1]) / (BANK_Y[i] - BANK_Y[i - 1]), 0.0, 1.0);
          return mix(BANK_X[i - 1], BANK_X[i], t);
        }
      }
      return BANK_X[NB - 1];
    }

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
      // Drifting blur patches: pockets of warmer air
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

      // dy: how far below the far edge (negative above it)
      float dy = uv.y - FAR_Y;
      float below = max(dy, 0.0);

      vec2 bank = banks(uv.y);
      float halfW = 0.5 * (bank.y - bank.x);
      float feather = ${f1(BANK_FEATHER[0])} + halfW * ${f1(BANK_FEATHER[1])};
      float inRiver = 1.0 - smoothstep(halfW, halfW + feather, abs(uv.x - 0.5 * (bank.x + bank.y)));

      // The extent envelope: full strength at the far edge, easing to
      // FOREGROUND at the bottom of the photo
      float env = dy < 0.0
        ? 1.0 - smoothstep(0.0, ${f1(RISE)}, -dy)
        : mix(1.0, ${f1(FOREGROUND)}, below / ${f1(1 - FAR_Y)});
      float m = inRiver * env;

      // Transparent where there is nothing to distort, so the <img> beneath
      // shows through; faded in over the mask's faint fringe, where what the
      // canvas draws is all but identical to it anyway
      float alpha = smoothstep(0.004, 0.04, m);
      if (alpha == 0.0) {
        outColor = vec4(0.0);
        return;
      }

      // Water-plane coordinates, about the river's axis. Depth runs as
      // log(h), lateral as offset over h, so a fixed noise cell covers less
      // and less of the screen the further up the river it lies — the
      // shimmer tightens with the river. h levels off toward NEAR_H in the
      // foreground, where the cells would otherwise grow into swells.
      float h = max(uv.y - HORIZON_Y, 0.003);
      h = h / (1.0 + h / ${f1(NEAR_H)});
      vec4 hz = haze(vec2((uv.x - ${f1(AXIS_X)}) * uAspect / h * 0.5, log(h) * 2.5)
                     * ${f1(TIGHTEN)});

      vec2 d = (hz.xy * vec2(${f1(WARP_AMP[0])}, ${f1(WARP_AMP[1])})
              + hz.z * vec2(${f1(RIPPLE_AMP[0])}, ${f1(RIPPLE_AMP[1])}))
              * m * ${f1(2 * INTENSITY)};
      vec2 suv = uv + vec2(d.x / uAspect, d.y);

      // Blur patches, as a mip bias
      float blur = smoothstep(-0.05, 0.25, hz.w) * m * ${f1(BLUR_BIAS * INTENSITY)};

      // Explicit LOD: this read sits behind the early-out, where implicit
      // derivatives are undefined
      vec4 col = photo(suv, uLod + blur);

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

  // The source the texture was cut from: its pixel size and where it sits
  // in the full photo. Kept apart from the <img>, which may already be
  // loading its next source, so the mapping always matches the texture.
  let src: { nw: number; nh: number; rect: readonly number[] } | null = null
  let loadId = 0

  function reload() {
    const id = ++loadId
    if (!img.naturalWidth || !img.naturalHeight) return
    const { width: nw, height: nh, rect } = source()
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
     snapped to whole CSS pixels, and maps the canvas's pixels back to
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
    // Photo UV y -> frame CSS px
    const yAt = (v: number) => oy + ((v - rect[1]) / rect[3]) * nh * s
    // The band, in whole CSS px: at a fractional CSS offset (1691 device px
    // is 563.67 CSS px at 3x) the browser snaps the canvas to its layout
    // grid and it lands a device pixel off the photo
    const maxY = Math.floor(fh)
    const top = Math.min(maxY, Math.max(0, Math.floor(yAt(CANVAS_Y[0]))))
    const bottom = Math.min(maxY, Math.max(top, Math.ceil(yAt(CANVAS_Y[1]))))

    canvas.style.top = `${top}px`
    canvas.style.height = `${bottom - top}px`
    canvas.width = Math.max(1, Math.round(fw * dpr))
    canvas.height = Math.max(1, Math.round((bottom - top) * dpr))
    gl!.viewport(0, 0, canvas.width, canvas.height)
    gl!.uniform2f(uRes, canvas.width, canvas.height)

    // Canvas px -> frame CSS px -> photo UV
    const kx = fw / canvas.width
    const ky = Math.max(1, bottom - top) / canvas.height
    gl!.uniform4f(
      uToUv,
      (kx / (nw * s)) * rect[2],
      (ky / (nh * s)) * rect[3],
      rect[0] - (ox / (nw * s)) * rect[2],
      rect[1] + ((top - oy) / (nh * s)) * rect[3],
    )
    // Device px per texel sets the base mip level
    gl!.uniform1f(uLod, Math.max(0, -Math.log2((s * canvas.width) / fw)))
    draw(lastT)
  }

  // The frame is viewport-fixed, so it tracks the viewport — including the
  // mobile URL bar showing and hiding, which the footer's own box can miss
  // behind its min-height. Coalesced onto a frame.
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
