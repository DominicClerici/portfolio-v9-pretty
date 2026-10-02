// WebGL programs built without stalling the main thread.
//
// compileShader and linkProgram only queue the work: in Chrome it runs in the
// GPU process, and with KHR_parallel_shader_compile on the driver's own
// threads. What blocks is the first question asked about the result —
// COMPILE_STATUS, LINK_STATUS, a uniform location, useProgram — which waits
// out the whole compile on the spot. For the glass scene's two programs that
// is tens of milliseconds on a laptop and well over a hundred on some Windows
// and phone drivers, landing as one long task in the hero's opening.
//
// So compile and link everything up front, ask nothing, and hand the
// programs over once they are done: polled once a frame where the extension
// can say so without blocking, otherwise checked a frame later, by which time
// the rest of the page's startup has run alongside the compile.

/** Compiles and links a program without asking how it went. */
export function buildProgram(
  gl: WebGL2RenderingContext,
  vs: string,
  fs: string,
): WebGLProgram {
  const prog = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  return prog;
}

/** Calls `done(true)` once every program has finished linking, or
 *  `done(false)` if one failed (its logs go to the console) or the context
 *  was lost while waiting. */
export function whenLinked(
  gl: WebGL2RenderingContext,
  progs: WebGLProgram[],
  done: (ok: boolean) => void,
): void {
  const ext = gl.getExtension("KHR_parallel_shader_compile");
  const check = () => {
    if (gl.isContextLost()) return done(false);
    if (
      ext &&
      !progs.every((p) => gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR))
    ) {
      requestAnimationFrame(check);
      return;
    }
    for (const p of progs) {
      if (gl.getProgramParameter(p, gl.LINK_STATUS)) continue;
      for (const sh of gl.getAttachedShaders(p) ?? []) {
        const log = gl.getShaderInfoLog(sh);
        if (log) console.error(log);
      }
      console.error(gl.getProgramInfoLog(p));
      return done(false);
    }
    done(true);
  };
  requestAnimationFrame(check);
}
