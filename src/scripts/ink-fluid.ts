// The hero as a sheet of wet paper. A small Navier-Stokes solver (Stam's
// stable fluids: advect, confine vorticity, project) carries three pigments
// around the frame, and the display pass lays them on bone the way ink sits
// on paper: each one filters the light the others let through, so where two
// run together they make a third colour rather than a brighter one.
//
// The pointer drags the water and bleeds pigment into it, and so does a
// finger, for as long as it is down (scrolling the page or not). Two slow
// wandering brushes keep it moving when nothing else does, and a few drops
// fall as the page opens.
//
// The sheet is a loop top to bottom: scrolling slides it through the frame,
// and what leaves one edge comes back in at the other, so the frame is never
// short of sheet to show.

import { buildProgram, whenLinked } from "../lib/gl-program";
import {
  BONE,
  DARK,
  FULLSCREEN_VS,
  bindFullscreenTriangle,
  createLoop,
  fitCanvas,
  getGL,
  glsl3,
  uniforms,
} from "../lib/gl-kit";

// Grid sizes along the frame's short side: the water, and the pigment it
// carries (which is what is seen, so it gets the resolution).
const SIM_RES = 144;
const DYE_RES = 900;
const DYE_RES_SMALL = 800;
// A frame whose short side is under this many CSS px is a phone's.
const SMALL_FRAME = 600;
const PRESSURE_ITERATIONS = 18;
const CURL = 14; // vorticity confinement: how much the eddies are kept alive
const VELOCITY_FADE = 0.55; // per second
const DYE_FADE = 0.16; // per second
const POINTER_FORCE = 3200;
const POINTER_INK = 0.22;
// Splat sizes, in short sides squared. A finger is blunter than a cursor.
const POINTER_RADIUS = 0.0011;
const TOUCH_RADIUS = 0.0022;
const TOUCH_DAB = 0.3; // the ink a finger leaves where it lands
// How far the sheet slides for each px the page scrolls. Where the canvas
// does the sliding itself (see createInk), global.css's ink-slide carries
// the same figure.
const PARALLAX = 0.5;

// What each pigment lets through at full strength.
const PIGMENTS = [
  [0.52, 0.93, 0.5], // green
  [0.28, 0.68, 0.98], // blue
  [0.66, 0.46, 0.98], // violet
] as const;
const absorb = (c: readonly number[]) =>
  `vec3(${c.map((x) => (-Math.log(x)).toFixed(4)).join(", ")})`;

const HEAD = `precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 o;
`;

const ADVECT_FS = `#version 300 es
${HEAD}
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec2 uShift;
uniform float uDt;
uniform float uFade;
void main() {
  vec2 from = vUv - uDt * texture(uVelocity, vUv).xy * uTexel - uShift;
  o = texture(uSource, from) / (1.0 + uFade * uDt);
}`;

const SPLAT_FS = `#version 300 es
${HEAD}
uniform sampler2D uTarget;
uniform vec2 uShape;
uniform vec2 uPoint;
uniform vec3 uColor;
uniform float uRadius;
void main() {
  vec2 d = vUv - uPoint;
  d.y = fract(d.y + 0.5) - 0.5;
  vec2 p = d * uShape;
  o = vec4(texture(uTarget, vUv).xyz + uColor * exp(-dot(p, p) / uRadius), 1.0);
}`;

const CURL_FS = `#version 300 es
${HEAD}
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main() {
  float l = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float r = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float t = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  float b = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  o = vec4(0.5 * (r - l - t + b), 0.0, 0.0, 1.0);
}`;

const VORTICITY_FS = `#version 300 es
${HEAD}
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform vec2 uTexel;
uniform float uCurlAmount;
uniform float uDt;
void main() {
  float l = texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uCurl, vUv + vec2(0.0, uTexel.y)).x;
  float b = texture(uCurl, vUv - vec2(0.0, uTexel.y)).x;
  float c = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));
  force /= length(force) + 0.0001;
  force *= uCurlAmount * c;
  force.y *= -1.0;
  vec2 v = texture(uVelocity, vUv).xy + force * uDt;
  o = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
}`;

const DIVERGENCE_FS = `#version 300 es
${HEAD}
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main() {
  float l = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  float b = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  o = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
}`;

const PRESSURE_FS = `#version 300 es
${HEAD}
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexel;
void main() {
  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float d = texture(uDivergence, vUv).x;
  o = vec4((l + r + b + t - d) * 0.25, 0.0, 0.0, 1.0);
}`;

const SCALE_FS = `#version 300 es
${HEAD}
uniform sampler2D uSource;
uniform float uValue;
void main() {
  o = uValue * texture(uSource, vUv);
}`;

const PROJECT_FS = `#version 300 es
${HEAD}
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main() {
  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  o = vec4(texture(uVelocity, vUv).xy - vec2(r - l, t - b), 0.0, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
${HEAD}
uniform sampler2D uDye;
uniform vec2 uTexel;
uniform float uDark;
uniform float uTiles;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec2 uv = vec2(vUv.x, vUv.y * uTiles);
  vec3 c = max(texture(uDye, uv).rgb, 0.0);

  // Pigment gathers at the rim of a wash as it dries: a little extra where
  // the amount of ink is changing fastest.
  float sum = c.r + c.g + c.b;
  float sx = dot(texture(uDye, uv + vec2(uTexel.x * 2.0, 0.0)).rgb, vec3(1.0))
           - dot(texture(uDye, uv - vec2(uTexel.x * 2.0, 0.0)).rgb, vec3(1.0));
  float sy = dot(texture(uDye, uv + vec2(0.0, uTexel.y * 2.0)).rgb, vec3(1.0))
           - dot(texture(uDye, uv - vec2(0.0, uTexel.y * 2.0)).rgb, vec3(1.0));
  float rim = smoothstep(0.0, 0.22, length(vec2(sx, sy)));

  // The paper's tooth takes more pigment in its hollows.
  float tooth = vnoise(gl_FragCoord.xy * 0.55) * 0.6 + hash(gl_FragCoord.xy) * 0.4;
  c *= 1.0 + 0.2 * rim + 0.22 * (tooth - 0.5);

  // No wash builds past what the paper can hold, so the copy over it stays
  // readable however much ink is pushed into one place.
  c = 1.0 - exp(-c * 1.35);
  c *= min(1.0, 1.25 / (c.r + c.g + c.b + 0.001));

  vec3 through = exp(-(c.r * ${absorb(PIGMENTS[0])}
                     + c.g * ${absorb(PIGMENTS[1])}
                     + c.b * ${absorb(PIGMENTS[2])}));
  vec3 paper = mix(${glsl3(BONE)}, ${glsl3(DARK)}, uDark);
  vec3 col = paper * mix(through, vec3(1.0), uDark * 0.6);
  col *= 1.0 - (tooth - 0.5) * 0.035 * (1.0 - uDark);
  o = vec4(col, 1.0);
}`;

type Target = {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
};
type Pair = { read: Target; write: Target; swap(): void };

export type InkScene = {
  start(): void;
  stop(): void;
  resize(): void;
  /** Scroll into the pinned scope, CSS px. */
  setScroll(px: number): void;
  /** The turn to dark, 0 (paper) to 1 (the glass scene's dark backdrop). */
  setDarkness(t: number): void;
  /** For the ?inkdebug readout: overrides the resolutions and reports what
   *  is in use. */
  tune(t: { dpr?: number; dye?: number; sim?: number }): {
    dpr: number;
    dye: number;
    sim: number;
    buffer: string;
    dyeGrid: string;
  };
  /** For ink-bench.ts: takes the frames out of the loop's hands, to be run
   *  on demand instead. */
  probe(): {
    gl: WebGL2RenderingContext;
    programs: Record<string, WebGLProgram>;
    frame(dt: number): void;
  };
};

// The buffer stops short of the screen's own density: the washes are soft
// and the pigment grid is coarser than the screen either way. A phone's
// stops a little higher, chosen by eye on one along with its pigment grid
// (ink-res-search.mjs measures both).
const MAX_DPR = 1.5;
const MAX_DPR_SMALL = 1.5;

export function createInk(init: {
  canvas: HTMLCanvasElement;
  /** The element the canvas fills. */
  wrap: HTMLElement;
  reducedMotion: boolean;
}): InkScene | null {
  const { canvas, wrap, reducedMotion } = init;
  performance.mark("ink:create");
  const gl = getGL(canvas);
  if (!gl) return null;
  // Rendering to half-float needs one of these; without it there is no sim.
  if (
    !gl.getExtension("EXT_color_buffer_float") &&
    !gl.getExtension("EXT_color_buffer_half_float")
  )
    return null;

  // On a phone the page hears its own scroll position late and in steps (a
  // fast flick, or Safari's bar sliding, brings it down to ten reports a
  // second), so a sheet slid from those reports lurches under copy that is
  // scrolling smoothly. There the canvas slides instead, on a scroll
  // timeline the compositor runs (global.css, ink-slide): it is --ink-tiles
  // frames tall, shows the looping sheet that many times over, and moving
  // it up one frame's height brings it back to where it began.
  const tiles =
    Number(getComputedStyle(canvas).getPropertyValue("--ink-tiles")) || 1;

  const sources = {
    advect: ADVECT_FS,
    splat: SPLAT_FS,
    curl: CURL_FS,
    vorticity: VORTICITY_FS,
    divergence: DIVERGENCE_FS,
    pressure: PRESSURE_FS,
    scale: SCALE_FS,
    project: PROJECT_FS,
    display: DISPLAY_FS,
  };
  type Name = keyof typeof sources;
  const names = Object.keys(sources) as Name[];
  const progs = Object.fromEntries(
    names.map((n) => [n, buildProgram(gl, FULLSCREEN_VS, sources[n])]),
  ) as Record<Name, WebGLProgram>;
  const U = {} as Record<Name, Record<string, WebGLUniformLocation | null>>;
  bindFullscreenTriangle(gl);
  performance.mark("ink:built");

  function target(w: number, h: number, filter: number): Target {
    const tex = gl!.createTexture()!;
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, filter);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, filter);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.REPEAT);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA16F, w, h, 0, gl!.RGBA, gl!.HALF_FLOAT, null);
    const fbo = gl!.createFramebuffer()!;
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, tex, 0);
    gl!.viewport(0, 0, w, h);
    gl!.clearColor(0, 0, 0, 1);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h };
  }
  function pair(w: number, h: number, filter: number): Pair {
    const p = {
      read: target(w, h, filter),
      write: target(w, h, filter),
      swap() {
        const t = p.read;
        p.read = p.write;
        p.write = t;
      },
    };
    return p;
  }
  const free = (t?: Target) => {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  };

  let velocity: Pair;
  let dye: Pair;
  let pressure: Pair;
  let divergence: Target;
  let curl: Target;
  let ready = false;
  let cssW = 1;
  let cssH = 1;
  let scroll = 0;
  let lastScroll = 0;
  let dark = 0;
  let maxDpr = 0;
  let simRes = SIM_RES;
  let dyeRes = 0;
  let rebuild = false;

  // From the frame's own proportions, not the buffer's: those round a
  // little differently at every pixel ratio, and a grid one row out settles
  // into a different picture.
  function gridSize(res: number) {
    const aspect = cssW / cssH;
    return aspect >= 1
      ? { w: Math.round(res * aspect), h: res }
      : { w: res, h: Math.round(res / aspect) };
  }

  function resize() {
    cssW = wrap.clientWidth;
    cssH = wrap.clientHeight;
    const small = Math.min(cssW, cssH) < SMALL_FRAME;
    maxDpr ||= small ? MAX_DPR_SMALL : MAX_DPR;
    const changed = fitCanvas(canvas, wrap, maxDpr, tiles) || rebuild;
    rebuild = false;
    const aspect = cssW / cssH;
    shapeX = Math.max(aspect, 1);
    shapeY = Math.max(1 / aspect, 1);
    if (!changed && velocity) return;
    const sim = gridSize(simRes);
    dyeRes ||= small ? DYE_RES_SMALL : DYE_RES;
    const d = gridSize(dyeRes);
    // A resize starts the sheet clean: resampling the old one is not worth
    // the code, and the brushes have it wet again within a second.
    for (const p of [velocity, dye, pressure]) {
      free(p?.read);
      free(p?.write);
    }
    free(divergence);
    free(curl);
    velocity = pair(sim.w, sim.h, gl!.LINEAR);
    pressure = pair(sim.w, sim.h, gl!.NEAREST);
    divergence = target(sim.w, sim.h, gl!.NEAREST);
    curl = target(sim.w, sim.h, gl!.NEAREST);
    dye = pair(d.w, d.h, gl!.LINEAR);
    if (reducedMotion) settle();
  }

  let unit = 0;
  function use(name: Name) {
    gl!.useProgram(progs[name]);
    unit = 0;
    return U[name];
  }
  function tex(loc: WebGLUniformLocation | null, t: Target) {
    gl!.activeTexture(gl!.TEXTURE0 + unit);
    gl!.bindTexture(gl!.TEXTURE_2D, t.tex);
    gl!.uniform1i(loc, unit++);
  }
  function blit(t: Target | null) {
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, t ? t.fbo : null);
    gl!.viewport(0, 0, t ? t.w : canvas.width, t ? t.h : canvas.height);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  }

  // The frame's proportions with its short side as 1, so a splat is round
  // and the same size against the short side whichever way the frame is
  // turned: a phone's upright sheet gets a phone's worth of ink.
  let shapeX = 1;
  let shapeY = 1;

  /** x, y in 0…1 from the bottom-left; force in sim texels per second. */
  function splat(
    x: number,
    y: number,
    fx: number,
    fy: number,
    ink: readonly number[] | null,
    radius: number,
  ) {
    let u = use("splat");
    tex(u.uTarget, velocity.read);
    gl!.uniform2f(u.uShape, shapeX, shapeY);
    gl!.uniform2f(u.uPoint, x, y);
    gl!.uniform3f(u.uColor, fx, fy, 0);
    gl!.uniform1f(u.uRadius, radius);
    blit(velocity.write);
    velocity.swap();
    if (!ink) return;
    u = use("splat");
    tex(u.uTarget, dye.read);
    gl!.uniform2f(u.uShape, shapeX, shapeY);
    gl!.uniform2f(u.uPoint, x, y);
    gl!.uniform3f(u.uColor, ink[0], ink[1], ink[2]);
    gl!.uniform1f(u.uRadius, radius);
    blit(dye.write);
    dye.swap();
  }

  /** A drop landing: a pool of one pigment, pushed outward all round. */
  function drop(x: number, y: number, pigment: number, size: number) {
    const ink = [0, 0, 0];
    ink[pigment] = 0.9;
    splat(x, y, 0, 0, ink, size);
    const ring = Math.sqrt(size) * 0.9;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + pigment;
      const kick = 260 + 160 * Math.sin(i * 2.4 + pigment);
      splat(
        x + (Math.cos(a) * ring) / shapeX,
        y + (Math.sin(a) * ring) / shapeY,
        Math.cos(a) * kick,
        Math.sin(a) * kick,
        null,
        size * 0.35,
      );
    }
  }

  function step(dt: number) {
    const tx = 1 / velocity.read.w;
    const ty = 1 / velocity.read.h;
    // The sheet rides up with the page, at a fraction of its speed.
    const shift = tiles > 1 ? 0 : ((scroll - lastScroll) * PARALLAX) / cssH;
    lastScroll = scroll;

    let u = use("curl");
    tex(u.uVelocity, velocity.read);
    gl!.uniform2f(u.uTexel, tx, ty);
    blit(curl);

    u = use("vorticity");
    tex(u.uVelocity, velocity.read);
    tex(u.uCurl, curl);
    gl!.uniform2f(u.uTexel, tx, ty);
    gl!.uniform1f(u.uCurlAmount, CURL);
    gl!.uniform1f(u.uDt, dt);
    blit(velocity.write);
    velocity.swap();

    u = use("divergence");
    tex(u.uVelocity, velocity.read);
    gl!.uniform2f(u.uTexel, tx, ty);
    blit(divergence);

    // Last frame's pressure is most of the way to this frame's answer.
    u = use("scale");
    tex(u.uSource, pressure.read);
    gl!.uniform1f(u.uValue, 0.8);
    blit(pressure.write);
    pressure.swap();

    u = use("pressure");
    gl!.uniform2f(u.uTexel, tx, ty);
    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      unit = 0;
      tex(u.uPressure, pressure.read);
      tex(u.uDivergence, divergence);
      blit(pressure.write);
      pressure.swap();
    }

    u = use("project");
    tex(u.uPressure, pressure.read);
    tex(u.uVelocity, velocity.read);
    gl!.uniform2f(u.uTexel, tx, ty);
    blit(velocity.write);
    velocity.swap();

    u = use("advect");
    tex(u.uVelocity, velocity.read);
    tex(u.uSource, velocity.read);
    gl!.uniform2f(u.uTexel, tx, ty);
    gl!.uniform2f(u.uShift, 0, shift);
    gl!.uniform1f(u.uDt, dt);
    gl!.uniform1f(u.uFade, VELOCITY_FADE);
    blit(velocity.write);
    velocity.swap();

    unit = 0;
    tex(u.uVelocity, velocity.read);
    tex(u.uSource, dye.read);
    gl!.uniform1f(u.uFade, DYE_FADE);
    blit(dye.write);
    dye.swap();
  }

  function draw() {
    if (!ready) return;
    const u = use("display");
    tex(u.uDye, dye.read);
    gl!.uniform2f(u.uTexel, 1 / dye.read.w, 1 / dye.read.h);
    gl!.uniform1f(u.uDark, dark);
    gl!.uniform1f(u.uTiles, tiles);
    blit(null);
  }

  /* ── What stirs it ── */

  // The pointer, as last reported and (lx, ly) as last stirred from, in the
  // frame's own 0…1 with y up. The events only note where it is; the frame
  // that uses it places it, so the canvas is measured once a frame at most.
  const ptr = {
    cx: 0,
    cy: 0,
    lx: 0,
    ly: 0,
    down: false,
    fresh: false,
    touch: false,
    landed: false,
  };
  window.addEventListener(
    "pointermove",
    (e) => {
      // A finger's pointer events stop the moment the browser takes the
      // gesture for a scroll; its touch events (below) do not.
      if (e.pointerType === "touch") return;
      if (ptr.touch) ptr.down = false;
      ptr.touch = false;
      ptr.cx = e.clientX;
      ptr.cy = e.clientY;
      ptr.fresh = true;
    },
    { passive: true },
  );
  const onTouch = (e: TouchEvent) => {
    const f = e.touches[0];
    if (!f) return;
    // Each touch is a stroke of its own, not a line from the last one.
    if (e.type === "touchstart" && e.touches.length === 1) {
      ptr.down = false;
      ptr.landed = true;
    }
    ptr.touch = true;
    ptr.cx = f.clientX;
    ptr.cy = f.clientY;
    ptr.fresh = true;
  };
  window.addEventListener("touchstart", onTouch, { passive: true });
  window.addEventListener("touchmove", onTouch, { passive: true });

  // Which pigment the pointer is loaded with: it turns through the three as
  // it travels, so a long stroke changes colour along its length.
  let travel = 0;
  function pointerInk(amount: number) {
    const p = travel * 1.6;
    return [0, 1, 2].map(
      (i) => amount * Math.max(0, Math.cos(p - (i * Math.PI * 2) / 3)) ** 2,
    );
  }

  function stir(t: number, dt: number) {
    if (ptr.fresh) {
      ptr.fresh = false;
      const r = canvas.getBoundingClientRect();
      const x = (ptr.cx - r.left) / r.width;
      let y = 1 - (ptr.cy - r.top) / r.height;
      const radius = ptr.touch ? TOUCH_RADIUS : POINTER_RADIUS;
      // Off the frame (it has scrolled away from under the pointer) the
      // stroke ends: the sheet's loop would bring it back in at the far edge.
      if (y < 0 || y > 1) ptr.down = false;
      else {
        y = (y * tiles) % 1;
        // Across the seam between two frames of the sheet, the short way.
        if (ptr.down && Math.abs(y - ptr.ly) > 0.5) ptr.ly += y > ptr.ly ? 1 : -1;
        if (!ptr.down) {
          ptr.lx = x;
          ptr.ly = y;
          ptr.down = true;
          if (ptr.landed) {
            travel += 0.2;
            splat(x, y, 0, 0, pointerInk(TOUCH_DAB), radius);
          }
        }
        const dx = (x - ptr.lx) * shapeX;
        const dy = (y - ptr.ly) * shapeY;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.0005) {
          travel += dist;
          const ink = pointerInk(Math.min(1, dist * 26) * POINTER_INK * 4);
          // Laid along the stroke, so a fast flick is a line and not dots.
          const n = Math.min(10, Math.max(1, Math.ceil(dist / 0.02)));
          for (let i = 1; i <= n; i++) {
            const k = i / n;
            splat(
              ptr.lx + (x - ptr.lx) * k,
              ptr.ly + (y - ptr.ly) * k,
              (dx * POINTER_FORCE) / n,
              (dy * POINTER_FORCE) / n,
              ink.map((v) => v / n),
              radius,
            );
          }
        }
        ptr.lx = x;
        ptr.ly = y;
      }
      ptr.landed = false;
    }

    // Two brushes on slow looping paths, each trailing one pigment and
    // pushing the water the way it is heading.
    for (let b = 0; b < 2; b++) {
      const s = t * (b ? 0.13 : 0.1) + b * 2.7;
      const at = (q: number) => [
        0.5 + 0.4 * Math.sin(q * 1.9 + b) * Math.cos(q * 0.7 + b * 1.3),
        0.5 + 0.36 * Math.sin(q * 1.3 + 1.1 + b * 2.0),
      ];
      const [x, y] = at(s);
      const [x1, y1] = at(s + 0.01);
      const ink = [0, 0, 0];
      ink[(b + Math.floor(t / 13)) % 3] = 1.5 * dt;
      splat(
        x,
        y,
        (x1 - x) * shapeX * 5200,
        (y1 - y) * shapeY * 5200,
        ink,
        0.004,
      );
    }
  }

  // The opening: three drops, one of each pigment, a beat apart.
  const DROPS = [
    { at: 0.25, x: 0.3, y: 0.42, pigment: 0, size: 0.012 },
    { at: 0.6, x: 0.68, y: 0.62, pigment: 1, size: 0.009 },
    { at: 1.0, x: 0.56, y: 0.3, pigment: 2, size: 0.007 },
  ];
  let dropped = 0;
  function openingDrops(t: number) {
    while (dropped < DROPS.length && t >= DROPS[dropped].at) {
      const d = DROPS[dropped++];
      drop(d.x, d.y, d.pigment, d.size);
    }
  }

  /** Under reduced motion: let the opening play out unseen, and show where
   *  it came to rest. */
  function settle() {
    if (!ready) return;
    dropped = 0;
    for (let i = 0; i < 150; i++) {
      openingDrops(i / 60);
      step(1 / 60);
    }
    draw();
  }

  const loop = createLoop((t, dt) => {
    if (!ready) return;
    openingDrops(t);
    stir(t, dt);
    step(Math.min(dt, 1 / 40));
    draw();
  });

  whenLinked(gl, Object.values(progs), (ok) => {
    if (!ok) return;
    performance.mark("ink:linked");
    const find = (src: string) =>
      Array.from(new Set(Array.from(src.matchAll(/uniform \w+ (\w+);/g), (m) => m[1])));
    for (const n of names) U[n] = uniforms(gl, progs[n], find(sources[n]));
    ready = true;
    resize();
    if (!loop.running && !reducedMotion) draw();
    performance.mark("ink:ready");
  });

  const still = () => {
    if (ready && !loop.running) draw();
  };

  let probed = false;

  return {
    start: () => {
      if (!reducedMotion && !probed) loop.start();
    },
    probe() {
      probed = true;
      loop.stop();
      let t = 10;
      return {
        gl,
        programs: progs,
        frame(dt) {
          t += dt;
          stir(t, dt);
          step(dt);
          draw();
        },
      };
    },
    stop: () => loop.stop(),
    resize: () => {
      if (ready) resize();
    },
    setScroll(px) {
      scroll = px;
    },
    tune(t) {
      if (t.dpr) maxDpr = t.dpr;
      if (t.dye) dyeRes = t.dye;
      if (t.sim) simRes = t.sim;
      if (ready && (t.dpr || t.dye || t.sim)) {
        rebuild = true;
        resize();
        still();
      }
      return {
        dpr: maxDpr,
        dye: dyeRes,
        sim: simRes,
        buffer: `${canvas.width}x${canvas.height}`,
        dyeGrid: dye ? `${dye.read.w}x${dye.read.h}` : "",
      };
    },
    setDarkness(t) {
      if (t === dark) return;
      dark = t;
      still();
    },
  };
}
