// Temporary: with ?inkbench, measures what a frame of the ink costs, on
// whatever device opens the page. ink-bench.mjs drives it and explains the
// figures.
//
// Counts (draws, fragments, texture reads, memory) are exact. Times are
// taken with vsync out of the way: frames run back to back, then one
// readPixels waits for the GPU to finish them all.
//
// Run like that, a frame takes as long as the slower of two things working
// in parallel: the browser turning GL calls into GPU commands (a cost per
// pass), and the GPU shading them (a cost per fragment). To read the GPU's
// side on its own, everything is timed with the GPU deliberately made the
// slower: the display pass is drawn LOAD more times a frame, and then what a
// further repeat of any one pass adds is that pass's GPU time, with the
// browser's share hidden behind it. Repeats are the same inputs to the same
// target, so the simulation (whose flow the cost of a pass depends on) is
// not disturbed. Repeating a pass with a one-pixel scissor instead gives
// what a pass on that target costs the GPU before it shades anything, which
// is loading and storing the target.
//
// No time is read on its own, since the machine may be busy or warm: each
// round also times a fixed reference workload (GPU-bound, on the same
// context) and the frame's GPU time is given against it, in "ref units".

import { FULLSCREEN_VS } from "../lib/gl-kit";
import type { InkScene } from "./ink-fluid";

const REF_SIZE = 2048;
const REF_PASSES = 4;
const REPEATS = 8;
const TARGET_MS = 200; // per timing: Safari's clock only ticks in whole ms

const REF_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSource;
void main() {
  vec2 t = 1.0 / vec2(textureSize(uSource, 0));
  o = 0.2 * (texture(uSource, vUv)
    + texture(uSource, vUv + vec2(t.x, 0.0))
    + texture(uSource, vUv - vec2(t.x, 0.0))
    + texture(uSource, vUv + vec2(0.0, t.y))
    + texture(uSource, vUv - vec2(0.0, t.y))) + 0.001;
}`;

type Round = {
  ref: number;
  /** A frame as it is, back to back. */
  wall: number;
  submit: number;
  /** A frame with every draw cut to one pixel. */
  bare: number;
  /** With the display pass drawn `load` and `2 * load` more times. */
  loaded: number;
  loaded2: number;
  /** The loaded frame with every draw cut to one pixel: what the browser
   *  takes over it. The GPU's time can only be read while it is well above
   *  this, which a busy CPU can undo. */
  loadedBare: number;
  /** Loaded, and one pass repeated: whole, and at one pixel. */
  repeated: Record<string, number>;
  idle: Record<string, number>;
};

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : 0;
};
const quantile = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0;
};
const spread = (v: number[]) =>
  (quantile(v, 0.75) - quantile(v, 0.25)) / (median(v) || 1);
const tick = () => new Promise((r) => setTimeout(r, 0));

export async function inkBench(ink: InkScene) {
  while (!ink.tune({}).dyeGrid) await new Promise((r) => setTimeout(r, 50));
  const probe = ink.probe();
  const gl = probe.gl;
  const canvas = gl.canvas as HTMLCanvasElement;
  const names = new Map(
    Object.entries(probe.programs).map(([n, p]) => [p, n] as const),
  );

  /* ── Knowing which pass each draw is ── */

  const raw = {
    useProgram: gl.useProgram.bind(gl),
    viewport: gl.viewport.bind(gl),
    drawArrays: gl.drawArrays.bind(gl),
  };
  let program = "";
  let vw = 0;
  let vh = 0;
  let onDraw: ((kind: string, draw: () => void) => void) | null = null;
  const grid = () =>
    vw === canvas.width && vh === canvas.height
      ? "screen"
      : `${vw}x${vh}` === ink.tune({}).dyeGrid
        ? "ink"
        : "water";
  gl.useProgram = (p) => {
    program = (p && names.get(p)) || "other";
    raw.useProgram(p);
  };
  gl.viewport = (x, y, w, h) => {
    vw = w;
    vh = h;
    raw.viewport(x, y, w, h);
  };
  gl.drawArrays = (mode, first, count) => {
    const draw = () => raw.drawArrays(mode, first, count);
    if (onDraw) onDraw(`${program}:${grid()}`, draw);
    else draw();
  };

  /* ── Counts ── */

  function counted<T>(run: () => T, seen: (name: string, args: any[]) => void) {
    const proto = WebGL2RenderingContext.prototype as any;
    const g = gl as any;
    const undo: (() => void)[] = [];
    for (const name of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, name)!;
      if (typeof d.value !== "function" || name === "constructor") continue;
      const own = Object.prototype.hasOwnProperty.call(g, name);
      const was = g[name];
      g[name] = function (...args: any[]) {
        seen(name, args);
        return was.apply(gl, args);
      };
      undo.push(() => (own ? (g[name] = was) : delete g[name]));
    }
    try {
      return run();
    } finally {
      for (const u of undo) u();
    }
  }

  function census() {
    const taps = new Map<string, number>();
    for (const [p, n] of names) {
      const fs = gl
        .getAttachedShaders(p)
        ?.find((s) => gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER);
      taps.set(n, ((fs && gl.getShaderSource(fs))?.match(/texture\(/g) ?? []).length);
    }

    let bytes = canvas.width * canvas.height * 4;
    let targets = 0;
    const now = ink.tune({});
    counted(
      () => ink.tune({ dye: now.dye }),
      (name, a) => {
        if (name !== "texImage2D") return;
        targets++;
        bytes += a[3] * a[4] * 8;
      },
    );

    for (let i = 0; i < 90; i++) probe.frame(1 / 60);
    let calls = 0;
    const kinds: Record<
      string,
      { draws: number; fragments: number; taps: number }
    > = {};
    onDraw = (kind, draw) => {
      const k = (kinds[kind] ||= { draws: 0, fragments: 0, taps: 0 });
      k.draws++;
      k.fragments += vw * vh;
      k.taps += vw * vh * (taps.get(kind.split(":")[0]) ?? 0);
      draw();
    };
    counted(
      () => probe.frame(1 / 60),
      () => calls++,
    );
    onDraw = null;
    const sum = (f: "draws" | "fragments" | "taps") =>
      Object.values(kinds).reduce((a, k) => a + k[f], 0);
    return {
      calls,
      draws: sum("draws"),
      fragments: sum("fragments"),
      taps: sum("taps"),
      targets,
      bytes,
      kinds,
    };
  }

  /* ── Times ── */

  const px = new Uint8Array(4);
  const sync = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  };

  function timeFrames(n: number) {
    sync();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) probe.frame(1 / 60);
    const t1 = performance.now();
    sync();
    return {
      frame: (performance.now() - t0) / n,
      submit: (t1 - t0) / n,
    };
  }

  const ref = (() => {
    const prog = gl.createProgram()!;
    for (const [type, src] of [
      [gl.VERTEX_SHADER, FULLSCREEN_VS],
      [gl.FRAGMENT_SHADER, REF_FS],
    ] as const) {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    const loc = gl.getUniformLocation(prog, "uSource");
    const side = () => {
      const tex = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, REF_SIZE, REF_SIZE, 0, gl.RGBA, gl.HALF_FLOAT, null);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo };
    };
    const sides = [side(), side()];
    return (n: number) => {
      sync();
      const t0 = performance.now();
      raw.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(loc, 0);
      for (let i = 0; i < n * REF_PASSES; i++) {
        gl.bindTexture(gl.TEXTURE_2D, sides[i & 1].tex);
        gl.bindFramebuffer(gl.FRAMEBUFFER, sides[(i + 1) & 1].fbo);
        raw.viewport(0, 0, REF_SIZE, REF_SIZE);
        raw.drawArrays(gl.TRIANGLES, 0, 3);
      }
      // Onto the canvas, so the readPixels there waits for all of it.
      gl.bindTexture(gl.TEXTURE_2D, sides[0].tex);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      raw.viewport(0, 0, 1, 1);
      raw.drawArrays(gl.TRIANGLES, 0, 3);
      sync();
      return (performance.now() - t0) / n;
    };
  })();

  const SCREEN = "display:screen";
  let counts: ReturnType<typeof census>;
  let frames = 10;
  let refs = 10;
  let load = 4;
  const rounds: Round[] = [];
  const repeats = (kind: string) => (counts.kinds[kind].draws > 4 ? 1 : REPEATS);
  /** A frame's time with the display drawn `loadBy` more times and `kind`
   *  drawn its repeats more (at one pixel if `onePixel`). */
  function loaded(n: number, loadBy: number, kind = "", onePixel = false, bareAll = false) {
    const again = (times: number, scissor: boolean, draw: () => void) => {
      for (let i = 0; i < times; i++) {
        // A pass of its own each time: a tile-based GPU shades only the
        // last of several opaque draws over the same pixels in one pass.
        gl.flush();
        if (scissor) {
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(0, 0, 1, 1);
        }
        draw();
        if (scissor) gl.disable(gl.SCISSOR_TEST);
      }
    };
    onDraw = (k, draw) => {
      draw();
      if (k === SCREEN) again(loadBy, false, draw);
      if (k === kind) again(repeats(kind), onePixel, draw);
    };
    if (bareAll) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, 1, 1);
    }
    const ms = timeFrames(n).frame;
    if (bareAll) gl.disable(gl.SCISSOR_TEST);
    onDraw = null;
    return ms;
  }
  const GPU_BOUND = 1.5;
  // And the answer has to be possible: back to back, a frame cannot take
  // less than the GPU's part of it.
  const valid = (r: Round) => {
    const frame = 2 * r.loaded - r.loaded2;
    return r.loaded > GPU_BOUND * r.loadedBare && frame > 0 && frame < r.wall * 1.15;
  };

  function bare(n: number) {
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 1, 1);
    const ms = timeFrames(n).frame;
    gl.disable(gl.SCISSOR_TEST);
    return ms;
  }

  async function prepare() {
    counts = census();
    for (let i = 0; i < 60; i++) probe.frame(1 / 60);
    sync();
    const clamp = (n: number) => Math.max(8, Math.min(400, Math.ceil(n)));
    frames = clamp(TARGET_MS / Math.max(timeFrames(10).frame, 0.05));
    refs = clamp(TARGET_MS / Math.max(ref(4), 0.05));
    // The least load under which each further display pass costs as much as
    // the one before: from there on it is the GPU being waited for. Less
    // load is better, since the frame's own time is read as what is left
    // after taking the load off.
    const n = Math.max(4, frames >> 2);
    for (load = 1; load < 128; load *= 2) {
      const [a, b, c] = [load, load * 2, load * 4].map((l) => loaded(n, l));
      const cpu = loaded(n, load, "", false, true);
      if (a > 2 * GPU_BOUND * cpu && (b - a) / load > (0.9 * (c - b)) / (load * 2)) break;
      await tick();
    }
    rounds.length = 0;
  }

  async function round() {
    const n = Math.max(4, frames >> 1);
    const r: Round = {
      ref: 0,
      wall: 0,
      submit: 0,
      bare: 0,
      loaded: 0,
      loaded2: 0,
      loadedBare: 0,
      repeated: {},
      idle: {},
    };
    // Each reading is the mean of several, spread through the round, so a
    // busy second lands on all of them alike.
    const kinds = Object.keys(counts.kinds);
    const SLICES = 4;
    const add = (o: Record<string, number>, k: string, v: number) =>
      (o[k] = (o[k] ?? 0) + v / SLICES);
    for (let i = 0; i < SLICES; i++) {
      r.ref += ref(Math.ceil(refs / SLICES)) / SLICES;
      const base = timeFrames(Math.ceil(frames / SLICES));
      r.wall += base.frame / SLICES;
      r.submit += base.submit / SLICES;
      r.bare += bare(Math.ceil(frames / SLICES)) / SLICES;
      // Twice over: the frame's GPU time is the small difference of these.
      const pair = () => {
        r.loaded += loaded(Math.ceil(n / SLICES), load) / SLICES / 2;
        r.loaded2 += loaded(Math.ceil(n / SLICES), load * 2) / SLICES / 2;
      };
      pair();
      r.loadedBare += loaded(Math.ceil(n / SLICES), load, "", false, true) / SLICES;
      await tick();
      for (const kind of kinds) {
        add(r.repeated, kind, loaded(Math.ceil(n / SLICES), load, kind));
        add(r.idle, kind, loaded(Math.ceil(n / SLICES), load, kind, true));
      }
      pair();
      await tick();
    }
    rounds.push(r);
    return r;
  }

  /** One round's GPU times, ms a frame: the whole frame, each pass's
   *  shading, and what its passes cost before they shade anything. */
  function gpu(r: Round) {
    const shading: Record<string, number> = {};
    const unshaded: Record<string, number> = {};
    for (const kind of Object.keys(counts.kinds)) {
      shading[kind] = (r.repeated[kind] - r.idle[kind]) / repeats(kind);
      unshaded[kind] = (r.idle[kind] - r.loaded) / repeats(kind);
    }
    return {
      // loaded = frame + load × display, loaded2 = frame + 2 × load × display
      frame: 2 * r.loaded - r.loaded2,
      shading,
      unshaded,
    };
  }

  /** Frames at the screen's own pace. Depends on what else the machine is
   *  doing: a check that it holds the refresh rate, not a measurement. */
  function paced(seconds = 4) {
    return new Promise<{ median: number; p95: number; slow: number }>((done) => {
      const gaps: number[] = [];
      let last = 0;
      let start = 0;
      const frame = (ts: number) => {
        if (last) gaps.push(ts - last);
        else start = ts;
        const dt = last ? Math.min((ts - last) / 1000, 1 / 40) : 1 / 60;
        last = ts;
        probe.frame(dt);
        if (ts - start < seconds * 1000) return requestAnimationFrame(frame);
        const m = median(gaps);
        done({
          median: m,
          p95: quantile(gaps, 0.95),
          slow: gaps.filter((g) => g > m * 1.5).length / gaps.length,
        });
      };
      requestAnimationFrame(frame);
    });
  }

  function marks() {
    const at = (n: string) => performance.getEntriesByName(n)[0]?.startTime ?? NaN;
    return {
      create: at("ink:create"),
      build: at("ink:built") - at("ink:create"),
      link: at("ink:linked") - at("ink:built"),
      setup: at("ink:ready") - at("ink:linked"),
      ready: at("ink:ready"),
    };
  }

  async function report(opts: { paced?: boolean } = {}) {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const good = rounds.filter(valid);
    const g = good.map(gpu);
    const units = good.map((r, i) => g[i].frame / r.ref);
    const whole = median(units);
    const row = (of: (x: ReturnType<typeof gpu>) => number) => {
      const share = g.map((x, i) => of(x) / good[i].ref / whole);
      return {
        share: median(share),
        spread: quantile(share, 0.75) - quantile(share, 0.25),
      };
    };
    const kinds = Object.keys(counts.kinds).map((kind) => ({
      name: kind,
      ...counts.kinds[kind],
      ...row((x) => x.shading[kind]),
      unshaded: row((x) => x.unshaded[kind]).share,
    }));
    const result = {
      ua: navigator.userAgent,
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "",
      screen: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
      config: ink.tune({}),
      counts: { ...counts, kinds: undefined },
      load: marks(),
      repeatsOfDisplay: load,
      rounds,
      units: median(units),
      unitsSpread: spread(units),
      gpuMs: Math.min(...g.map((x) => x.frame)),
      gpuRounds: rounds.map((r) => (valid(r) ? gpu(r).frame : null)),
      validRounds: good.length,
      refMs: Math.min(...rounds.map((r) => r.ref)),
      wallMs: Math.min(...rounds.map((r) => r.wall)),
      bareMs: Math.min(...rounds.map((r) => r.bare)),
      submitMs: Math.min(...rounds.map((r) => r.submit)),
      kinds,
      paced: opts.paced === false ? null : await paced(),
      text: "",
    };
    result.text = format(result);
    return result;
  }

  function format(r: Awaited<ReturnType<typeof report>>) {
    const pad = (s: unknown, n: number) => String(s).padStart(n);
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const mega = (x: number) => (x / 1e6).toFixed(2);
    const c = r.counts;
    const lines = [
      r.renderer || r.ua,
      `screen ${r.screen}  buffer ${r.config.buffer}  ink ${r.config.dyeGrid}  water ${r.config.sim}`,
      "",
      "exact, per frame:",
      `  ${c.draws} draws, ${c.calls} GL calls, ${mega(c.fragments)}M fragments, ${mega(c.taps)}M texture reads`,
      `  ${c.targets} float targets + canvas = ${(c.bytes / 2 ** 20).toFixed(1)} MB`,
      "",
      r.validRounds < 3
        ? "GPU time: too few usable rounds, the figures below are not to be trusted"
        : "",
      `GPU time a frame = ${r.units.toFixed(3)} ref units (spread ${pct(r.unitsSpread)} over ${r.validRounds} rounds)`,
      ...(r.validRounds < r.rounds.length
        ? [`  ${r.rounds.length - r.validRounds} of ${r.rounds.length} rounds thrown out: the CPU was too busy for the GPU's time to be read`]
        : []),
      `  quietest round: ${r.gpuMs.toFixed(3)} ms, ref ${r.refMs.toFixed(3)} ms`,
      `back to back, a frame takes ${r.wallMs.toFixed(3)} ms; with nothing shaded, ${r.bareMs.toFixed(3)} ms (the browser's cost of ${c.draws} passes); the page's own part is ${r.submitMs.toFixed(3)} ms`,
      "",
      `${"of the GPU time".padEnd(20)}${pad("draws", 6)}${pad("Mfrag", 8)}${pad("Mreads", 8)}${pad("shading", 9)}${pad("±", 7)}${pad("unshaded", 10)}`,
    ];
    let known = 0;
    for (const k of [...r.kinds].sort((a, b) => b.share - a.share)) {
      known += k.share;
      lines.push(
        `${k.name.padEnd(20)}${pad(k.draws, 6)}${pad(mega(k.fragments), 8)}${pad(mega(k.taps), 8)}${pad(pct(k.share), 9)}${pad(pct(k.spread), 7)}${pad(pct(k.unshaded), 10)}`,
      );
    }
    lines.push(
      `${"all shading".padEnd(42)}${pad(pct(known), 9)}`,
      "(unshaded: what the pass costs with its drawing cut to one pixel, which is",
      " loading and storing its target plus this bench's own flush before it)",
    );
    if (r.paced)
      lines.push(
        "",
        `paced (load-dependent): ${(1000 / r.paced.median).toFixed(1)} fps, p95 gap ${r.paced.p95.toFixed(1)} ms, ${pct(r.paced.slow)} slow frames`,
      );
    const l = r.load;
    lines.push(
      "",
      `load (this visit): created at ${l.create.toFixed(0)} ms, build ${l.build.toFixed(1)}, link wait ${l.link.toFixed(1)}, setup ${l.setup.toFixed(1)}, ready at ${l.ready.toFixed(0)} ms`,
    );
    return lines.join("\n");
  }

  async function run(n = 7, status?: (s: string) => void) {
    await prepare();
    for (let i = 0; i < n; i++) {
      status?.(`round ${i + 1}/${n}`);
      await round();
      await tick();
    }
    status?.("finishing");
    return report();
  }

  (window as any).__inkBench = {
    prepare,
    round,
    report,
    run,
    tune: ink.tune,
    // Two builds being compared must carry the same load.
    load: (n?: number) => (load = n ?? load),
  };

  // By hand (a phone): a button, the result on screen, and a copy of it
  // posted to ink-bench.mjs if it gave the page somewhere to send it.
  const params = new URLSearchParams(location.search);
  if (params.get("inkbench") === "driven") return;
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;left:6px;right:6px;top:max(6px,env(safe-area-inset-top));z-index:99999;" +
    "max-height:80vh;overflow:auto;padding:6px 8px;border-radius:6px;" +
    "font:9px/1.35 ui-monospace,Menlo,monospace;color:#fff;background:rgba(0,0,0,.85)";
  const button = document.createElement("button");
  button.textContent = "run ink bench";
  button.style.cssText = "font:inherit;color:#000;background:#fff;border:0;border-radius:4px;padding:6px 10px";
  const out = document.createElement("pre");
  out.style.cssText = "margin:6px 0 0;white-space:pre;user-select:text;-webkit-user-select:text";
  box.append(button, out);
  document.body.appendChild(box);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const r = await run(Number(params.get("rounds")) || 7, (s) => (out.textContent = s));
      out.textContent = r.text;
      const to = params.get("report");
      if (to)
        await fetch(to, { method: "POST", mode: "no-cors", body: JSON.stringify(r) })
          .then(() => (out.textContent += "\n\nsent"))
          .catch(() => (out.textContent += "\n\nnot sent"));
    } catch (e) {
      out.textContent = String(e);
    }
    button.disabled = false;
  });
}
