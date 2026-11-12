// What the page's own full-frame WebGL backgrounds share: the ink under the
// hero (scripts/ink-fluid.ts) and the ASCII knot under the footer
// (scripts/signal-ascii.ts).

/** The dark backdrop the glass scene paints (BG_DARK in glass-scene.ts). */
export const DARK = [0.063, 0.063, 0.063] as const;
export const BONE = [0.957, 0.953, 0.945] as const;

export const glsl3 = (c: readonly number[]) =>
  `vec3(${c.map((x) => x.toFixed(3)).join(", ")})`;

export const FULLSCREEN_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** One oversized triangle covering clip space, bound to attribute 0. */
export function bindFullscreenTriangle(gl: WebGL2RenderingContext): void {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
}

export function getGL(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  try {
    return canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    });
  } catch {
    return null;
  }
}

export const uniforms = <K extends string>(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram,
  names: readonly K[],
) =>
  Object.fromEntries(
    names.map((n) => [n, gl.getUniformLocation(prog, n)]),
  ) as Record<K, WebGLUniformLocation | null>;

/** Sizes the canvas's buffer to its wrap, at up to `maxDpr`, or to `rows`
 *  wraps stacked. Returns whether the buffer changed. */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  wrap: HTMLElement,
  maxDpr: number,
  rows = 1,
): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(1, Math.round(wrap.clientWidth * dpr));
  const h = Math.max(1, Math.round(wrap.clientHeight * dpr)) * rows;
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

/** Pointer position over the viewport, y-down CSS px, plus whether one has
 *  been seen at all (a touch screen never reports a resting pointer). */
export function trackPointer() {
  const p = { x: 0, y: 0, seen: false, moved: 0 };
  window.addEventListener(
    "pointermove",
    (e) => {
      p.x = e.clientX;
      p.y = e.clientY;
      p.seen = true;
      p.moved = performance.now();
    },
    { passive: true },
  );
  return p;
}

/** A rAF loop that reports seconds since its first frame and the step since
 *  the last one, clamped so a background tab's gap is not played back. */
export function createLoop(frame: (t: number, dt: number) => void) {
  let raf = 0;
  let running = false;
  let last = 0;
  let t = 0;
  const tick = (ms: number) => {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    const dt = last ? Math.min((ms - last) / 1000, 1 / 20) : 1 / 60;
    last = ms;
    t += dt;
    frame(t, dt);
  };
  return {
    start() {
      if (running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    get running() {
      return running;
    },
    get time() {
      return t;
    },
  };
}
