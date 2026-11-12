// Finds the resolutions above which the ink stops looking any different on
// a phone screen: the canvas's pixel ratio, or the pigment grid.
//
//   pnpm dev            (in another terminal)
//   node ink-res-search.mjs [--url http://localhost:4321/] [--out dir]
//        [--width 402 --height 874 --native 3 --ppi 460 --distance 30]
//        [--from 0.7 --to 2.4 --step 0.1] [--all]   (--all: no early stop)
//   node ink-res-search.mjs --param dye --dpr 1.75 --from 300 --to 900 --step 25
//
// ── Pixel ratio (the default) ──
// Drives headless Chrome at the phone's viewport and native density, with
// reduced motion on so the ink is the same settled frame every time, and
// through ?inkdebug (src/scripts/ink-debug.ts) renders it at each ratio from
// 0.7 to 2.4. Each screenshot, which is the canvas as the browser scaled it
// up to the screen, is first blurred by what the eye's optics lose at that
// pixel density and viewing distance, and then measured two ways, both in
// CIELAB, where 1 is about the smallest step a person can see side by side:
//
//   wash    how far the washes are from the native ratio's, over the worst
//           5% of the screen, with the grain smoothed out of both
//   grain   how strongly the paper's grain shows (its RMS lightness). The
//           grain is drawn per buffer pixel and is a different random field
//           at every ratio, so it is compared as an amount, not pixel by
//           pixel: lower ratios draw it coarser, and more of it gets through
//           the eye.
//
// "work" is the fragments shaded per frame, against the native ratio's: the
// simulation's passes, which cost the same at every ratio, plus the display
// pass over the canvas, which on a touch screen is two frames tall (see
// createInk). It counts fragments, not time on any particular GPU.
//
// A step is "unchanged" when its washes are within VISIBLE of native and its
// grain within GRAIN_SAME of the step before.
//
// ── Pigment grid (--param dye) ──
// At a fixed pixel ratio (--dpr), renders the settled frame at each grid
// size and measures how crisp the washes' edges are: the steepest 1% of the
// screen, as CIELAB change per screen px, after the eye's blur. A finer grid
// both holds a finer edge and loses less of it each time the water carries
// the pigment along. A step is "unchanged" when it is under EDGE_GAIN
// sharper than the best so far. "work" is against the grid's current size.
//
// The screen's size, density and viewing distance are assumptions; pass the
// real ones. It measures Chrome's scaling of the canvas, not Safari's.

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const URL_ = arg("url", "http://localhost:4321/");
const OUT = arg("out", "");
const WIDTH = +arg("width", 402);
const HEIGHT = +arg("height", 874);
const NATIVE = +arg("native", 3);
const PPI = +arg("ppi", 460);
const DISTANCE_CM = +arg("distance", 30);
const CHROME = arg(
  "chrome",
  {
    darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  }[process.platform] ?? "google-chrome",
);

const PARAM = arg("param", "dpr");
const DPR = +arg("dpr", 1.75);
const FROM = +arg("from", PARAM === "dye" ? 300 : 0.7);
const TO = +arg("to", PARAM === "dye" ? 900 : 2.4);
const STEP = +arg("step", PARAM === "dye" ? 25 : 0.1);
const EDGE_GAIN = 0.01;
const DYE_NOW = 800; // DYE_RES_SMALL in ink-fluid.ts
// Per frame in ink-fluid.ts's step(): passes over the water grid (curl,
// vorticity, divergence, pressure carry-over and its 18 iterations, project,
// advect, and the brushes' two splats) and over the pigment grid (advect, and
// the brushes' two splats).
const WATER_PASSES = 26;
const PIGMENT_PASSES = 3;
const TOUCH_TILES = 2;
const VISIBLE = 1;
const GRAIN_SAME = 0.015;
const GRAIN_PX = 4; // anything finer than this many screen px is grain
const STOP_AFTER = 3;

/* ── Chrome, over its DevTools socket ── */

const profile = await mkdtemp(join(tmpdir(), "ink-dpr-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const quit = async () => {
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
};

const endpoint = await new Promise((resolve, reject) => {
  let err = "";
  chrome.stderr.on("data", (d) => {
    err += d;
    const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  chrome.on("exit", () => reject(new Error(`Chrome exited:\n${err}`)));
  setTimeout(() => reject(new Error("Chrome did not start")), 15000);
});

const ws = new WebSocket(endpoint);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let nextId = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  const w = waiting.get(msg.id);
  if (!w) return;
  waiting.delete(msg.id);
  msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
};
let sessionId;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── The eye ── */

// What the eye's optics pass: a Gaussian about one arcminute wide at half
// height, in screen px.
const pxPerDegree = (PPI / 2.54) * DISTANCE_CM * Math.tan(Math.PI / 180);
const SIGMA = (1 / 2.355 / 60) * pxPerDegree;

const toLinear = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** PNG to CIELAB as the eye receives it: blurred in linear light. */
async function seen(png) {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const n = w * h;
  let img = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) img[i] = toLinear[data[i]];

  const eye = blur(img, w, h, SIGMA);
  const smooth = blur(eye, w, h, GRAIN_PX);
  let grain = 0;
  for (let i = 0; i < n * 3; i += 3)
    grain += (lightness(eye, i) - lightness(smooth, i)) ** 2;
  return {
    wash: toLab(smooth),
    grain: Math.sqrt(grain / n),
    edge: PARAM === "dye" ? steepest(toLab(eye), w, h) : 0,
  };
}

/** The gradient the steepest 1% of the picture reaches, CIELAB per px. */
function steepest(lab, w, h) {
  const g = new Float32Array((w - 2) * (h - 2));
  let o = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 3;
      let sum = 0;
      for (let c = 0; c < 3; c++) {
        const dx = (lab[i + 3 + c] - lab[i - 3 + c]) / 2;
        const dy = (lab[i + w * 3 + c] - lab[i - w * 3 + c]) / 2;
        sum += dx * dx + dy * dy;
      }
      g[o++] = Math.sqrt(sum);
    }
  g.sort();
  return g[Math.floor(g.length * 0.99)];
}

function blur(img, w, h, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) =>
    Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)),
  );
  const total = kernel.reduce((a, b) => a + b);
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
  ]) {
    const out = new Float32Array(img.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = Math.min(w - 1, Math.max(0, x + k * dx));
          const sy = Math.min(h - 1, Math.max(0, y + k * dy));
          const j = (sy * w + sx) * 3;
          const wgt = kernel[k + radius];
          r += img[j] * wgt;
          g += img[j + 1] * wgt;
          b += img[j + 2] * wgt;
        }
        const o = (y * w + x) * 3;
        out[o] = r / total;
        out[o + 1] = g / total;
        out[o + 2] = b / total;
      }
    img = out;
  }
  return img;
}

const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const lightness = (img, i) =>
  116 * labF(0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2]) - 16;
function toLab(img) {
  const out = new Float32Array(img.length);
  for (let i = 0; i < img.length; i += 3) {
    const r = img[i], g = img[i + 1], b = img[i + 2];
    const X = labF((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505);
    const Y = labF(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const Z = labF((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089);
    out[i] = 116 * Y - 16;
    out[i + 1] = 500 * (X - Y);
    out[i + 2] = 200 * (Y - Z);
  }
  return out;
}

/** How far apart the worst 5% of the screen is. */
function difference(a, b) {
  const n = a.length / 3;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    d[i] = Math.hypot(a[j] - b[j], a[j + 1] - b[j + 1], a[j + 2] - b[j + 2]);
  }
  d.sort();
  return d[Math.floor(n * 0.95)];
}

/* ── The search ── */

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
  await send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: NATIVE,
    mobile: true,
  });
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await send("Page.enable");
  const url = new URL(URL_);
  url.searchParams.set("inkdebug", "");
  await send("Page.navigate", { url: url.href });

  for (let i = 0; ; i++) {
    if (await evaluate("typeof window.__inkTune === 'function'").catch(() => false)) break;
    if (i > 100) throw new Error(`No ink at ${url.href}. Is the dev server running?`);
    await sleep(200);
  }
  // Nothing on screen but the ink.
  await evaluate(`{
    const s = document.createElement("style");
    s.textContent = "*{visibility:hidden!important}#ink-canvas{visibility:visible!important}";
    document.head.appendChild(s);
  }`);
  // The shaders link off the main thread; the sheet is drawn once they have.
  for (let i = 0; ; i++) {
    if ((await evaluate("window.__inkTune({}).dyeGrid")) !== "") break;
    if (i > 100) throw new Error("The ink never drew (no WebGL2 in this Chrome?)");
    await sleep(200);
  }

  if (OUT) await mkdir(OUT, { recursive: true });
  const frameH = await evaluate(
    "document.querySelector('.hero-canvas-wrap').clientHeight",
  );
  const frameW = await evaluate(
    "document.querySelector('.hero-canvas-wrap').clientWidth",
  );
  // gridSize() in ink-fluid.ts, for an upright frame.
  const cells = (res) => res * Math.round((res * frameH) / frameW);
  const work = (bufferPx, water, pigment) => ({
    fixed: WATER_PASSES * cells(water) + PIGMENT_PASSES * cells(pigment),
    display: bufferPx * TOUCH_TILES,
  });

  async function shot(set, name) {
    const t = await evaluate(`new Promise((done) => {
      const t = window.__inkTune(${JSON.stringify(set)});
      requestAnimationFrame(() => requestAnimationFrame(() => done(t)));
    })`);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    const png = Buffer.from(data, "base64");
    if (OUT) await writeFile(join(OUT, `ink-${name}.png`), png);
    const [bw, bh] = t.buffer.split("x").map(Number);
    return { ...t, ...work(bw * bh, t.sim, t.dye), ...(await seen(png)) };
  }

  console.log(
    `${WIDTH}x${HEIGHT} at ${NATIVE}x, ${PPI} ppi seen from ${DISTANCE_CM} cm ` +
      `(${pxPerDegree.toFixed(0)} px per degree, eye blur ${SIGMA.toFixed(2)} px)\n`,
  );
  const all = process.argv.includes("--all");
  const decimals = (String(STEP).split(".")[1] || "").length;
  const values = Array.from(
    { length: Math.round((TO - FROM) / STEP) + 1 },
    (_, i) => +(FROM + i * STEP).toFixed(decimals),
  );
  const rows = [];
  let unchanged = 0;
  const stop = () => {
    if (unchanged !== STOP_AFTER || all) return false;
    console.log(`\nStopped: ${STOP_AFTER} steps in a row with nothing to see.`);
    return true;
  };
  const dropoff = () => {
    const first = rows.findIndex(
      (_, i) =>
        i + STOP_AFTER <= rows.length &&
        rows.slice(i, i + STOP_AFTER).every((r) => r.same),
    );
    return first < 0 ? null : rows[Math.max(first - 1, 0)];
  };

  if (PARAM === "dye") {
    const first = await shot({ dpr: DPR }, "start");
    const now = work(0, first.sim, DYE_NOW).fixed + first.display;
    console.log(
      `pixel ratio ${DPR}, buffer ${first.buffer}, water grid ${first.sim}\n` +
        `per frame at the current ink grid (${DYE_NOW}): ${(now / 1e6).toFixed(2)}M fragments\n`,
    );
    console.log("ink   grid         edge    gain    work  ink's share");
    let best = 0;
    for (const dye of values) {
      const r = await shot({ dye }, String(dye));
      const gain = best ? r.edge / best - 1 : 0;
      const same = best > 0 && gain < EDGE_GAIN;
      best = Math.max(best, r.edge);
      unchanged = same ? unchanged + 1 : 0;
      rows.push({ value: dye, edge: r.edge, same });
      const total = r.fixed + r.display;
      console.log(
        `${String(dye).padEnd(4)}  ${r.dyeGrid.padEnd(10)}  ${r.edge.toFixed(3).padStart(6)}  ` +
          `${(gain >= 0 ? "+" : "") + (gain * 100).toFixed(1).padStart(4)}%  ` +
          `${((total / now) * 100).toFixed(0).padStart(4)}%  ` +
          `${(((PIGMENT_PASSES * cells(dye)) / total) * 100).toFixed(0).padStart(3)}%` +
          `${same ? "          unchanged" : ""}`,
      );
      if (stop()) break;
    }
    const at = dropoff();
    console.log(
      at
        ? `\nDropoff at ${at.value}: the edges get no crisper above it (${at.edge.toFixed(3)}, best ${best.toFixed(3)}).`
        : `\nNo plateau up to ${TO}: the edges were still getting crisper.`,
    );
  } else {
    const reference = await shot({ dpr: NATIVE }, NATIVE.toFixed(1));
    const nativeWork = reference.fixed + reference.display;
    console.log(
      `reference: ratio ${NATIVE}, buffer ${reference.buffer}, grain ${reference.grain.toFixed(3)}\n` +
        `per frame at the native ratio: ${(nativeWork / 1e6).toFixed(2)}M fragments, ` +
        `${(reference.fixed / 1e6).toFixed(2)}M of them the simulation's\n`,
    );
    console.log("ratio  buffer       wash   grain   work  display share");
    for (const ratio of values) {
      const r = await shot({ dpr: ratio }, ratio.toFixed(decimals));
      const washOff = difference(r.wash, reference.wash);
      const prev = rows.at(-1);
      const same =
        washOff < VISIBLE && !!prev && Math.abs(r.grain - prev.grain) < GRAIN_SAME;
      unchanged = same ? unchanged + 1 : 0;
      rows.push({ value: ratio, grain: r.grain, same });
      const total = r.fixed + r.display;
      console.log(
        `${ratio.toFixed(decimals)}    ${r.buffer.padEnd(10)}  ${washOff.toFixed(2).padStart(5)}   ` +
          `${r.grain.toFixed(3)}   ${((total / nativeWork) * 100).toFixed(0).padStart(3)}%  ` +
          `${((r.display / total) * 100).toFixed(0).padStart(3)}%` +
          `${same ? "          unchanged" : ""}`,
      );
      if (stop()) break;
    }
    const at = dropoff();
    console.log(
      at
        ? `\nDropoff at ${at.value.toFixed(decimals)}: above it the picture stops changing ` +
            `(grain ${at.grain.toFixed(3)}, against ${reference.grain.toFixed(3)} at the native ratio).`
        : `\nNo plateau up to ${TO}: every step still changed the picture.`,
    );
  }
} finally {
  ws.close();
  await quit();
}
