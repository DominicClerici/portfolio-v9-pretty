// The footer's backdrop: a trefoil knot drawn in characters. It is raymarched
// once per character cell into a texture a couple of hundred texels wide, and
// a second pass sets a glyph from Roboto Mono in each cell by how much light
// the first found there. The whole scene costs one ray per character, so it
// runs on anything; the type is real type, rasterised from the page's own
// face.

import { buildProgram, whenLinked } from "../lib/gl-program";
import {
  DARK,
  FULLSCREEN_VS,
  bindFullscreenTriangle,
  createLoop,
  fitCanvas,
  getGL,
  glsl3,
  trackPointer,
  uniforms,
} from "../lib/gl-kit";

// Darkest to brightest. The footer prints the same string as its legend
// (Footer.astro), which is also what puts these glyphs in the subset font.
const RAMP = " .:-=+*#%@";
const FONT = '"Roboto Mono", ui-monospace, monospace';
const FONT_PX = 12;
const FONT_PX_SMALL = 10;
const LINE = 1.22; // cell height / font size
const ADVANCE = 0.6; // Roboto Mono's advance / font size
const INTRO_S = 1.9;
// The knot's silhouette, in the scene's units, at its widest turn: what the
// radius it is given is divided by to get the scene's scale.
const KNOT_REACH = 0.76;

const SCENE_FS = `#version 300 es
precision highp float;
uniform vec2 uGrid;
uniform vec2 uCellPx;
uniform vec2 uCenter;
uniform float uScale;
uniform float uTime;
uniform vec3 uRot;
uniform vec3 uPointer;
out vec4 o;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

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

// A (2,3) torus knot: the tube's cross-section turns one and a half times per
// lap, and mirroring it gives the two passes of the one strand.
float knot(vec3 p) {
  float r = length(p.xz);
  float a = atan(p.z, p.x);
  vec2 q = vec2(r - 0.68, p.y);
  float twist = length(q);
  q = rot(a * 1.5) * q;
  q.y = abs(q.y) - 0.3;
  // The twist stretches distances more the nearer the axis, so the step is
  // shortened by how much it does at this point.
  return (length(q) - 0.14) * r / sqrt(r * r + 2.25 * twist * twist);
}

float scene(vec3 p) {
  p.xy = rot(uRot.z) * p.xy;
  p.yz = rot(uRot.y) * p.yz;
  p.xz = rot(uRot.x) * p.xz;
  return knot(p);
}

void main() {
  // The middle of this cell, in px from the canvas's bottom-left.
  vec2 px = (floor(gl_FragCoord.xy) + 0.5) * uCellPx;
  vec2 uv = (px - uCenter) / uScale;

  vec3 ro = vec3(0.0, 0.0, 3.2);
  vec3 rd = normalize(vec3(uv, -2.1));
  float t = 1.6;
  float hit = 0.0;
  for (int i = 0; i < 110; i++) {
    float d = scene(ro + rd * t);
    if (d < 0.0015) { hit = 1.0; break; }
    t += d;
    if (t > 5.2) break;
  }

  // Behind the knot: stray characters that come and go, each on its own
  // clock, gathering where a slow drift of noise passes and round the pointer.
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 gp = px / 190.0;
  float n = vnoise(gp + vec2(uTime * 0.05, -uTime * 0.02));
  vec2 pd = (px - uPointer.xy) / (uScale * 0.4);
  float near = exp(-dot(pd, pd)) * uPointer.z;
  float beat = floor(uTime * 0.45 + hash(cell * 0.71) * 9.0);
  float chance = 0.012 + 0.05 * smoothstep(0.45, 0.85, n) + 0.3 * near;
  float lit = step(1.0 - chance, hash(cell + beat * 7.31));
  float field = lit * mix(0.12, 0.62, hash(cell * 3.3 + beat));

  if (hit < 0.5) {
    o = vec4(field, 0.0, near, 1.0);
    return;
  }

  vec3 p = ro + rd * t;
  vec2 e = vec2(0.006, 0.0);
  vec3 nrm = normalize(vec3(
    scene(p + e.xyy) - scene(p - e.xyy),
    scene(p + e.yxy) - scene(p - e.yxy),
    scene(p + e.yyx) - scene(p - e.yyx)));
  vec3 l = normalize(vec3(-0.55, 0.75, 0.6));
  float diff = max(dot(nrm, l), 0.0);
  float spec = pow(max(dot(reflect(-l, nrm), -rd), 0.0), 22.0);
  float rim = pow(1.0 - max(dot(nrm, -rd), 0.0), 2.5);
  float ao = clamp(scene(p + nrm * 0.14) / 0.14, 0.0, 1.0);
  // One strand's shadow on the other is what reads as over and under.
  float sh = 1.0;
  float st = 0.05;
  for (int i = 0; i < 18; i++) {
    float d = scene(p + l * st);
    sh = min(sh, 9.0 * d / st);
    st += clamp(d, 0.02, 0.12);
    if (sh < 0.02 || st > 1.6) break;
  }
  sh = clamp(sh, 0.0, 1.0);
  float lum = 0.13 + 0.7 * diff * sh * mix(0.5, 1.0, ao) + 0.1 * rim + 0.55 * spec * sh;
  o = vec4(clamp(lum, 0.0, 1.0), 1.0, near, 1.0);
}`;

const GLYPH_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uAtlas;
uniform vec2 uRes;
uniform vec2 uCellPx;
uniform vec2 uGrid;
uniform float uCount;
uniform float uTime;
uniform float uIntro;
out vec4 o;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 cell = floor(gl_FragCoord.xy / uCellPx);
  vec2 inCell = fract(gl_FragCoord.xy / uCellPx);
  vec4 s = texelFetch(uScene, ivec2(min(cell, uGrid - 1.0)), 0);
  float lum = s.r;
  float solid = s.g;

  // A little line noise on anything lit, so the picture is never quite still.
  float tick = floor(uTime * 9.0);
  lum += (hash(cell + tick * 0.37) - 0.5) * 0.07 * step(0.03, lum);

  // Boot: cells come up at random from the top down, flashing a wrong glyph
  // on the way to the right one.
  float order = hash(cell * 1.31) * 0.55 + (1.0 - cell.y / uGrid.y) * 0.45;
  float up = smoothstep(order, order + 0.12, uIntro * 1.12);
  float settling = up * (1.0 - smoothstep(order + 0.12, order + 0.3, uIntro * 1.12));
  lum = mix(lum, hash(cell + tick) * 0.9, settling * 0.8) * up;

  lum = clamp(lum, 0.0, 1.0);
  float idx = min(floor(lum * uCount), uCount - 1.0);
  float glyph = texture(uAtlas, vec2((idx + inCell.x) / uCount, inCell.y)).r;

  vec3 lime = vec3(0.808, 0.969, 0.62);
  vec3 dim = vec3(0.3, 0.37, 0.33);
  vec3 col = mix(dim, lime, smoothstep(0.12, 0.62, lum));
  col = mix(col, vec3(0.97, 1.0, 0.93), smoothstep(0.78, 1.0, lum));
  // Off the knot the field stays grey, warming to lime only by the pointer.
  col = mix(mix(vec3(0.36, 0.39, 0.37), lime, s.b * 0.7), col, solid);
  float a = glyph * mix(0.55, 1.0, solid) * mix(0.75, 1.0, lum);

  vec3 bg = ${glsl3(DARK)};
  o = vec4(mix(bg, col, a), 1.0);
}`;

export type SignalScene = {
  start(): void;
  stop(): void;
  resize(): void;
};

export function createSignal(init: {
  canvas: HTMLCanvasElement;
  /** The element the canvas fills. */
  wrap: HTMLElement;
  reducedMotion: boolean;
  /** Where the knot goes: its centre from the wrap's top-left and the radius
   *  it may fill, in CSS px. Asked again on every resize. */
  place(): { x: number; y: number; r: number };
}): SignalScene | null {
  const { canvas, wrap, reducedMotion, place } = init;
  const gl = getGL(canvas);
  if (!gl) return null;

  const sceneProg = buildProgram(gl, FULLSCREEN_VS, SCENE_FS);
  const glyphProg = buildProgram(gl, FULLSCREEN_VS, GLYPH_FS);
  bindFullscreenTriangle(gl);

  const sceneTex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  const atlasTex = gl.createTexture();
  const atlas = document.createElement("canvas");

  const pointer = trackPointer();
  let ready = false;
  let us: Record<string, WebGLUniformLocation | null>;
  let ug: Record<string, WebGLUniformLocation | null>;
  let dpr = 1;
  let cellW = 8;
  let cellH = 16;
  let cols = 1;
  let rows = 1;
  let spot = { x: 0, y: 0, r: 1 };
  let intro = reducedMotion ? 1 : 0;
  let px = 0.5;
  let py = 0.5;
  let near = 0;

  function buildAtlas() {
    const fontPx = (wrap.clientWidth < 640 ? FONT_PX_SMALL : FONT_PX) * dpr;
    cellW = Math.max(4, Math.round(fontPx * ADVANCE));
    cellH = Math.max(6, Math.round(fontPx * LINE));
    atlas.width = cellW * RAMP.length;
    atlas.height = cellH;
    const c = atlas.getContext("2d")!;
    c.fillStyle = "#000";
    c.fillRect(0, 0, atlas.width, atlas.height);
    c.fillStyle = "#fff";
    c.font = `${fontPx}px ${FONT}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    for (let i = 0; i < RAMP.length; i++)
      c.fillText(RAMP[i], (i + 0.5) * cellW, cellH * 0.52);
    gl!.bindTexture(gl!.TEXTURE_2D, atlasTex);
    gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, true);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.R8, gl!.RED, gl!.UNSIGNED_BYTE, atlas);
    gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, false);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
  }

  function resize() {
    fitCanvas(canvas, wrap, 2);
    dpr = canvas.width / Math.max(1, wrap.clientWidth);
    buildAtlas();
    cols = Math.ceil(canvas.width / cellW);
    rows = Math.ceil(canvas.height / cellH);
    gl!.bindTexture(gl!.TEXTURE_2D, sceneTex);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA8, cols, rows, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, null);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.NEAREST);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, sceneTex, 0);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    spot = place();
    still();
  }

  function draw(t: number) {
    if (!ready) return;
    const W = canvas.width;
    const H = canvas.height;
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
    gl!.viewport(0, 0, cols, rows);
    gl!.useProgram(sceneProg);
    gl!.uniform2f(us.uGrid, cols, rows);
    gl!.uniform2f(us.uCellPx, cellW, cellH);
    gl!.uniform2f(us.uCenter, spot.x * dpr, H - spot.y * dpr);
    gl!.uniform1f(us.uScale, (spot.r * dpr) / KNOT_REACH);
    gl!.uniform1f(us.uTime, t);
    gl!.uniform3f(
      us.uRot,
      t * 0.26 + (px - 0.5) * 1.6,
      1.02 + (py - 0.5) * 0.8 + Math.sin(t * 0.19) * 0.22,
      Math.sin(t * 0.13) * 0.35,
    );
    gl!.uniform3f(us.uPointer, pointer.x * dpr, H - pointer.y * dpr, near);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);

    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.viewport(0, 0, W, H);
    gl!.useProgram(glyphProg);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, sceneTex);
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, atlasTex);
    gl!.uniform1i(ug.uScene, 0);
    gl!.uniform1i(ug.uAtlas, 1);
    gl!.uniform2f(ug.uRes, W, H);
    gl!.uniform2f(ug.uCellPx, cellW, cellH);
    gl!.uniform2f(ug.uGrid, cols, rows);
    gl!.uniform1f(ug.uCount, RAMP.length);
    gl!.uniform1f(ug.uTime, t);
    gl!.uniform1f(ug.uIntro, intro);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  }

  const still = () => {
    if (!loop.running) draw(reducedMotion ? 9 : loop.time);
  };

  const loop = createLoop((t, dt) => {
    if (intro < 1) intro = Math.min(1, intro + dt / INTRO_S);
    const k = 1 - Math.pow(0.02, dt);
    if (pointer.seen) {
      px += (pointer.x / window.innerWidth - px) * k;
      py += (pointer.y / window.innerHeight - py) * k;
      near += (1 - near) * k;
    }
    draw(t);
  });

  whenLinked(gl, [sceneProg, glyphProg], (ok) => {
    if (!ok) return;
    us = uniforms(gl, sceneProg, [
      "uGrid",
      "uCellPx",
      "uCenter",
      "uScale",
      "uTime",
      "uRot",
      "uPointer",
    ]);
    ug = uniforms(gl, glyphProg, [
      "uScene",
      "uAtlas",
      "uRes",
      "uCellPx",
      "uGrid",
      "uCount",
      "uTime",
      "uIntro",
    ]);
    const go = () => {
      ready = true;
      resize();
    };
    // The glyphs are drawn with the page's mono face, so wait for it.
    const fonts = document.fonts;
    if (fonts?.load) fonts.load(`${FONT_PX}px ${FONT}`, RAMP).then(go, go);
    else go();
  });

  return {
    start: () => {
      if (!reducedMotion) loop.start();
    },
    stop: () => loop.stop(),
    resize: () => {
      if (ready) resize();
    },
  };
}
