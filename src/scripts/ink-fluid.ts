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

import { buildProgram, buildShader, whenLinked } from "../lib/gl-program";
import {
  BONE,
  DARK,
  FULLSCREEN_VS,
  bindFullscreenTriangle,
  createLoop,
  fitBuffer,
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
const PRESSURE_PASSES = 9; // each is two rounds of the relaxation
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
// A splat is drawn only where it can change a half-float at all. The format's
// finest step is 2^-24, so anything under half of that is rounded away
// whatever it is added to; the margin below that covers the sum being
// rounded twice, once as a float and once into the target.
const SPLAT_FLOOR = 2 ** -27;

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

// Blended onto the target, not written over it: see splatOnto.
const SPLAT_FS = `#version 300 es
${HEAD}
uniform vec2 uShape;
uniform vec2 uPoint;
uniform vec3 uColor;
uniform float uRadius;
void main() {
  vec2 d = vUv - uPoint;
  d.y = fract(d.y + 0.5) - 0.5;
  vec2 p = d * uShape;
  o = vec4(uColor * exp(-dot(p, p) / uRadius), 0.0);
}`;

// The water grid's edges, for a shader that fetches texels by index: held at
// the sides and looping top to bottom, as the targets' samplers have them.
const GRID = `
ivec2 size;
ivec2 cell(int x, int y) {
  return ivec2(clamp(x, 0, size.x - 1), (y + size.y) % size.y);
}`;

// The curl is worked out here, at the cell and its four neighbours, and not
// in a pass of its own: on a grid this small a pass costs far more than the
// fetches it saves.
const VORTICITY_FS = `#version 300 es
${HEAD}
uniform sampler2D uVelocity;
uniform float uCurlAmount;
uniform float uDt;
${GRID}
vec2 vel(int x, int y) {
  return texelFetch(uVelocity, cell(x, y), 0).xy;
}
float curl(int x, int y) {
  x = clamp(x, 0, size.x - 1);
  return 0.5 * (vel(x + 1, y).y - vel(x - 1, y).y - vel(x, y + 1).x + vel(x, y - 1).x);
}
void main() {
  size = textureSize(uVelocity, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  float l = curl(p.x - 1, p.y);
  float r = curl(p.x + 1, p.y);
  float t = curl(p.x, p.y + 1);
  float b = curl(p.x, p.y - 1);
  float c = curl(p.x, p.y);
  vec2 force = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));
  force /= length(force) + 0.0001;
  force *= uCurlAmount * c;
  force.y *= -1.0;
  vec2 v = vel(p.x, p.y) + force * uDt;
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

// Two rounds of the relaxation, p ← (its four neighbours − d) / 4, in one
// pass: the second round written out in terms of what the first one reads.
// Each neighbour's own neighbours are the cell itself (four times over), the
// diagonals (twice each) and the cells two away.
//
// At the sides a single round reads the edge cell for the one beyond it. Two
// rounds at once must then read the cell two beyond the edge as the one a
// step inside it, which is the grid mirrored in its edge, and not held.
//
// uScale is applied to the pressure as it is read: the first pass of a frame
// starts from last frame's answer, taken down a little.
const PRESSURE_FS = `#version 300 es
${HEAD}
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform float uScale;
ivec2 size;
ivec2 cell(int x, int y) {
  x = x < 0 ? -1 - x : x >= size.x ? 2 * size.x - 1 - x : x;
  return ivec2(x, (y + size.y) % size.y);
}
float p(int x, int y) {
  return texelFetch(uPressure, cell(x, y), 0).x;
}
float d(int x, int y) {
  return texelFetch(uDivergence, cell(x, y), 0).x;
}
void main() {
  size = textureSize(uPressure, 0);
  int x = int(gl_FragCoord.x);
  int y = int(gl_FragCoord.y);
  float around = 4.0 * p(x, y)
    + 2.0 * (p(x - 1, y - 1) + p(x + 1, y - 1) + p(x - 1, y + 1) + p(x + 1, y + 1))
    + p(x - 2, y) + p(x + 2, y) + p(x, y - 2) + p(x, y + 2);
  float near = d(x - 1, y) + d(x + 1, y) + d(x, y - 1) + d(x, y + 1);
  o = vec4(((uScale * around - near) * 0.25 - d(x, y)) * 0.25, 0.0, 0.0, 1.0);
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

/** The frame's size in CSS px, and the screen's pixel ratio. */
export type FrameSize = { cssW: number; cssH: number; dpr: number };

/** Where the pointer or a finger is: 0…1 across the canvas each way, y up. */
export type PointerSample = {
  x: number;
  y: number;
  touch: boolean;
  /** A finger has just come down. */
  landed: boolean;
  /** The stroke before this point is over: this is not a line on from it. */
  lift: boolean;
};

type Pixels = { w: number; h: number; bytes: Uint8Array };
type Held = "dye" | "velocity" | "pressure";

/** For ink-look.mjs: the simulation stepped and read back on demand, in
 *  calls that can be made from another thread. */
export type InkLook = {
  /** Runs frames, and returns the canvas as the last one left it. */
  run(frames: number): Pixels;
  /** One of the opening drops. */
  drop(i: number): void;
  /** A target's floats, and the same put back. */
  read(what: Held): Pixels;
  write(what: Held, bytes: Uint8Array): void;
  info(): ReturnType<Ink["tune"]>;
  /** A clean sheet. */
  reset(): void;
};

export type Ink = {
  start(): void;
  stop(): void;
  resize(size: FrameSize): void;
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
  } & InkLook;
};

// The buffer stops short of the screen's own density: the washes are soft
// and the pigment grid is coarser than the screen either way. A phone's
// stops a little higher, chosen by eye on one along with its pigment grid
// (ink-res-search.mjs measures both).
const MAX_DPR = 1.5;
const MAX_DPR_SMALL = 1.5;

/** The simulation, on whichever thread holds the canvas: nothing in here
 *  reads the page. What it needs from it (the frame's size, the pointer,
 *  the scroll) is handed in, by ink-mount.ts. */
export function createInk(init: {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** How many times over the canvas shows the sheet (see ink-mount.ts). */
  tiles: number;
  reducedMotion: boolean;
  size: FrameSize;
  /** Where the pointer has got to, if it has moved since last asked: asked
   *  once a frame. */
  pointer(): PointerSample | null;
  mark?(name: string): void;
}): Ink | null {
  const { canvas, tiles, reducedMotion } = init;
  const mark = init.mark ?? ((name: string) => performance.mark(name));
  mark("ink:create");
  const gl = getGL(canvas);
  if (!gl) return null;
  // Rendering to half-float needs one of these; without it there is no sim.
  if (
    !gl.getExtension("EXT_color_buffer_float") &&
    !gl.getExtension("EXT_color_buffer_half_float")
  )
    return null;

  const sources = {
    advect: ADVECT_FS,
    splat: SPLAT_FS,
    vorticity: VORTICITY_FS,
    divergence: DIVERGENCE_FS,
    pressure: PRESSURE_FS,
    project: PROJECT_FS,
    display: DISPLAY_FS,
  };
  type Name = keyof typeof sources;
  const names = Object.keys(sources) as Name[];
  const vs = buildShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
  const progs = Object.fromEntries(
    names.map((n) => [n, buildProgram(gl, vs, sources[n])]),
  ) as Record<Name, WebGLProgram>;
  const U = {} as Record<Name, Record<string, WebGLUniformLocation | null>>;
  bindFullscreenTriangle(gl);
  // Only splats blend. They leave alpha as it is, at 1.
  gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
  mark("ink:built");

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

  let size = init.size;
  function resize() {
    cssW = size.cssW;
    cssH = size.cssH;
    const small = Math.min(cssW, cssH) < SMALL_FRAME;
    maxDpr ||= small ? MAX_DPR_SMALL : MAX_DPR;
    const changed =
      fitBuffer(canvas, cssW, cssH, Math.min(size.dpr, maxDpr), tiles) || rebuild;
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
    velocity = pair(sim.w, sim.h, gl!.LINEAR);
    pressure = pair(sim.w, sim.h, gl!.NEAREST);
    divergence = target(sim.w, sim.h, gl!.NEAREST);
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
  /** A pass over the whole of a target. */
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

  /** Adds a splat to a target in place, over the box it reaches and no
   *  further: most are a small part of the grid, and none needs the rest of
   *  it read and written back. */
  function splatOnto(
    t: Target,
    x: number,
    y: number,
    color: readonly number[],
    radius: number,
  ) {
    const peak = Math.max(Math.abs(color[0]), Math.abs(color[1]), Math.abs(color[2]));
    const reach = Math.sqrt(Math.max(0, radius * Math.log(peak / SPLAT_FLOOR)));
    if (!reach) return;
    const x0 = Math.max(0, Math.floor((x - reach / shapeX) * t.w));
    const x1 = Math.min(t.w, Math.ceil((x + reach / shapeX) * t.w));
    if (!(x1 > x0)) return;
    const u = use("splat");
    gl!.uniform2f(u.uShape, shapeX, shapeY);
    gl!.uniform2f(u.uPoint, x, y);
    gl!.uniform3f(u.uColor, color[0], color[1], color[2]);
    gl!.uniform1f(u.uRadius, radius);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, t.fbo);
    gl!.viewport(0, 0, t.w, t.h);
    const rows = (from: number, to: number) => {
      gl!.scissor(x0, from, x1 - x0, to - from);
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    };
    // The sheet loops top to bottom, and the shader measures to the nearest
    // copy of the point, so a box over an edge carries on from the other.
    // The pieces must not overlap: a row drawn twice is added to twice.
    const wrapped = y - Math.floor(y);
    const y0 = Math.floor((wrapped - reach / shapeY) * t.h);
    const y1 = Math.ceil((wrapped + reach / shapeY) * t.h);
    if (y1 - y0 >= t.h) rows(0, t.h);
    else {
      rows(Math.max(y0, 0), Math.min(y1, t.h));
      if (y0 < 0) rows(y0 + t.h, t.h);
      if (y1 > t.h) rows(0, y1 - t.h);
    }
  }

  /** x, y in 0…1 from the bottom-left; force in sim texels per second. */
  function splat(
    x: number,
    y: number,
    fx: number,
    fy: number,
    ink: readonly number[] | null,
    radius: number,
  ) {
    gl!.enable(gl!.BLEND);
    gl!.enable(gl!.SCISSOR_TEST);
    splatOnto(velocity.read, x, y, [fx, fy, 0], radius);
    if (ink) splatOnto(dye.read, x, y, ink, radius);
    gl!.disable(gl!.SCISSOR_TEST);
    gl!.disable(gl!.BLEND);
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

    let u = use("vorticity");
    tex(u.uVelocity, velocity.read);
    gl!.uniform1f(u.uCurlAmount, CURL);
    gl!.uniform1f(u.uDt, dt);
    blit(velocity.write);
    velocity.swap();

    u = use("divergence");
    tex(u.uVelocity, velocity.read);
    gl!.uniform2f(u.uTexel, tx, ty);
    blit(divergence);

    u = use("pressure");
    for (let i = 0; i < PRESSURE_PASSES; i++) {
      unit = 0;
      tex(u.uPressure, pressure.read);
      tex(u.uDivergence, divergence);
      // Last frame's pressure is most of the way to this frame's answer.
      gl!.uniform1f(u.uScale, i ? 1 : 0.8);
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

  // Where the stroke under way was last stirred from, in the frame's own
  // 0…1 with y up.
  const ptr = { lx: 0, ly: 0, down: false };

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
    const at = init.pointer();
    if (at) {
      if (at.lift) ptr.down = false;
      const x = at.x;
      let y = at.y;
      const radius = at.touch ? TOUCH_RADIUS : POINTER_RADIUS;
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
          if (at.landed) {
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
    mark("ink:linked");
    const find = (src: string) =>
      Array.from(new Set(Array.from(src.matchAll(/uniform \w+ (\w+);/g), (m) => m[1])));
    for (const n of names) U[n] = uniforms(gl, progs[n], find(sources[n]));
    ready = true;
    resize();
    if (!loop.running && !reducedMotion) draw();
    mark("ink:ready");
  });

  const still = () => {
    if (ready && !loop.running) draw();
  };

  let probed = false;

  const scene: Ink = {
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
        // The canvas is read in the task that drew it: its buffer is not kept.
        run(frames) {
          for (let i = 0; i < frames; i++) this.frame(1 / 60);
          const bytes = new Uint8Array(canvas.width * canvas.height * 4);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
          return { w: canvas.width, h: canvas.height, bytes };
        },
        drop(i) {
          const d = DROPS[i];
          drop(d.x, d.y, d.pigment, d.size);
        },
        read(what) {
          const t = { dye, velocity, pressure }[what].read;
          const f = new Float32Array(t.w * t.h * 4);
          gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
          gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, f);
          return { w: t.w, h: t.h, bytes: new Uint8Array(f.buffer) };
        },
        write(what, bytes) {
          const t = { dye, velocity, pressure }[what].read;
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, t.tex);
          gl.texSubImage2D(
            gl.TEXTURE_2D, 0, 0, 0, t.w, t.h, gl.RGBA, gl.FLOAT,
            new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4),
          );
        },
        info: () => scene.tune({}),
        reset: () => void scene.tune({ dye: dyeRes }),
      };
    },
    stop: () => loop.stop(),
    resize(to) {
      size = to;
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
  return scene;
}

/** What ink-mount.ts says to the ink, across to its worker or straight to
 *  it, and what comes back. */
export type ToInk =
  | {
      is: "open";
      canvas: HTMLCanvasElement | OffscreenCanvas;
      tiles: number;
      reducedMotion: boolean;
      size: FrameSize;
    }
  | { is: "size"; size: FrameSize }
  | { is: "running"; on: boolean }
  | { is: "scroll"; px: number }
  | { is: "dark"; t: number }
  | { is: "pointer"; at: PointerSample }
  | { is: "look"; id: number; call: keyof InkLook; args: unknown[] };
export type FromInk =
  | { is: "failed" }
  | { is: "mark"; name: string; at: number }
  | { is: "looked"; id: number; value: unknown };

/** Runs an ink from messages. `pointer`, where the ink is on the page's own
 *  thread, is asked in place of waiting to be told. */
export function serveInk(
  reply: (m: FromInk, transfer?: Transferable[]) => void,
  pointer?: () => PointerSample | null,
) {
  let ink: Ink | null = null;
  let look: InkLook | undefined;
  // Told of more often than a frame comes round: the frame takes where it
  // has got to, and whatever happened on the way there.
  let told: PointerSample | null = null;
  const take = () => {
    const at = told;
    told = null;
    return at;
  };
  return {
    ink: () => ink,
    hear(m: ToInk) {
      if (m.is === "open") {
        ink = createInk({
          ...m,
          pointer: pointer ?? take,
          mark(name) {
            performance.mark(name);
            reply({ is: "mark", name, at: performance.timeOrigin + performance.now() });
          },
        });
        if (!ink) reply({ is: "failed" });
      } else if (!ink) return;
      else if (m.is === "size") ink.resize(m.size);
      else if (m.is === "running") m.on ? ink.start() : ink.stop();
      else if (m.is === "scroll") ink.setScroll(m.px);
      else if (m.is === "dark") ink.setDarkness(m.t);
      else if (m.is === "pointer")
        told = {
          ...m.at,
          landed: m.at.landed || !!told?.landed,
          lift: m.at.lift || !!told?.lift,
        };
      else if (m.is === "look") {
        look ??= ink.probe();
        const value = (look[m.call] as (...a: unknown[]) => unknown)(...m.args);
        const bytes = (value as Pixels | undefined)?.bytes;
        reply({ is: "looked", id: m.id, value }, bytes ? [bytes.buffer] : []);
      }
    },
  };
}
