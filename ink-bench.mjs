// Benchmarks the ink (src/scripts/ink-fluid.ts) from a production build, in
// a way that does not depend on what else the machine is doing.
//
//   pnpm build
//   node ink-bench.mjs                     this build, desktop and phone sizes
//   node ink-bench.mjs --b other/client    ...against a second build (A/B)
//   node ink-bench.mjs --phone             serve it, and wait for a real phone
//        [--a dist/client] [--device desktop|phone|both] [--rounds 7]
//        [--loads 5] [--save results.json] [--headed]
//
// To compare a change: build, copy dist/client somewhere, make the change,
// build again, and pass the copy as --a and dist/client as --b.
//
// ── What it reports, and why it holds on a busy machine ──
// exact     Draw calls, GL calls, fragments shaded, texture reads and GPU
//           memory per frame, counted by wrapping the GL context. Bytes of
//           script the ink ships. These do not vary at all.
// GPU time  Frames are run with vsync out of the way: many back to back,
//           then a readPixels that waits for the GPU. Run like that, a
//           frame takes as long as the slower of two things working in
//           parallel: the browser turning GL calls into GPU commands (a
//           cost per pass) and the GPU shading them (a cost per fragment).
//           So the GPU is deliberately made the slower, by drawing the
//           display pass many more times a frame, and its time for the
//           frame as it really is is read back from how the total grows.
// ref units That GPU time against a fixed reference workload (5-tap blurs
//           over a 2048² half-float target) timed on the same GL context
//           moments apart. Load and heat slow both alike, so the ratio
//           holds; the median over the rounds is given with its spread,
//           and a wide spread means run it again.
// share     Each pass's part of the GPU time: with the GPU saturated as
//           above, the pass is drawn several more times, and again with
//           those repeats cut to one pixel. The first less the second is
//           its shading; the second is what a pass on that target costs
//           before it shades anything (loading and storing the target).
//           Repeats leave the simulation as it was, which matters: a
//           pass's cost depends on the flow. (Chrome's GPU timer queries
//           are not used: on Metal they come back several times the whole
//           frame.)
// wall      A frame back to back as it is, and with every draw cut to one
//           pixel. The second is the browser's cost of the passes, which
//           the GPU time above leaves out. These are plain times: the
//           least of the rounds is given.
// A/B       With --b, both builds are open in the same browser and take
//           turns round by round, so each pair of timings shares whatever
//           the machine was doing. The ratio of each pair is what is read.
// load      Cold starts in a fresh browser profile each time: how long the
//           ink's script blocks, how long its shaders take to link, and when
//           it is ready. These are times, so the least of several is given.
// paced     Frame gaps at the screen's own rate. Load-dependent: a sanity
//           check that nothing is dropped, not a measurement.
//
// The phone figures taken here are a phone's *workload* on this machine's
// GPU. --phone gets a phone's own: open the address it prints and tap run.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const A = arg("a", "dist/client");
const B = arg("b", "");
const DEVICE = arg("device", "both");
const ROUNDS = +arg("rounds", 7);
const LOADS = +arg("loads", 5);
const SAVE = arg("save", "");
const CHROME = arg(
  "chrome",
  {
    darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  }[process.platform] ?? "google-chrome",
);

const DEVICES = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
  phone: { width: 402, height: 874, deviceScaleFactor: 3, mobile: true },
};

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : NaN;
};
const spread = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const q = (x) => s[Math.min(s.length - 1, Math.floor(s.length * x))];
  return (q(0.75) - q(0.25)) / median(v);
};
const pct = (x) => `${(x * 100).toFixed(1)}%`;

/* ── Serving a build ── */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serve(dir, onReport) {
  const root = resolve(dir);
  await stat(join(root, "index.html"));
  const server = createServer(async (req, res) => {
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.writeHead(204).end();
      try {
        onReport?.(JSON.parse(body));
      } catch {}
      return;
    }
    let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    let file = join(root, path);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      const data = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "0.0.0.0", r));
  return { port: server.address().port, close: () => server.close() };
}

/* ── What the ink ships ── */

async function shipped(dir) {
  const astro = join(resolve(dir), "_astro");
  const files = (await readdir(astro)).filter((f) => f.endsWith(".js"));
  const text = Object.fromEntries(
    await Promise.all(files.map(async (f) => [f, await readFile(join(astro, f), "utf8")])),
  );
  const entry = files.find((f) => text[f].includes("uPressure"));
  if (!entry) return null;
  // Only what the page fetches before the ink can start: static imports.
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f) || !text[f]) return;
    seen.add(f);
    for (const m of text[f].matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) walk(m[1]);
  };
  walk(entry);
  const rows = [...seen].map((f) => ({
    file: f,
    raw: Buffer.byteLength(text[f]),
    gzip: gzipSync(text[f]).length,
    brotli: brotliCompressSync(text[f]).length,
  }));
  const shaders = (text[entry].match(/#version 300 es/g) ?? []).length;
  return { rows, shaders };
}

function printShipped(label, s) {
  if (!s) return console.log(`${label}: no ink chunk found`);
  console.log(`\n${label}: script fetched before the ink can start (${s.shaders} shaders in it)`);
  const total = { raw: 0, gzip: 0, brotli: 0 };
  for (const r of s.rows) {
    for (const k in total) total[k] += r[k];
    console.log(
      `  ${r.file.replace(/\.astro_astro_type_script_index_0_lang/, "").padEnd(34)}${String(r.raw).padStart(8)} raw${String(r.gzip).padStart(7)} gz${String(r.brotli).padStart(7)} br`,
    );
  }
  console.log(
    `  ${"total".padEnd(34)}${String(total.raw).padStart(8)} raw${String(total.gzip).padStart(7)} gz${String(total.brotli).padStart(7)} br`,
  );
  return total;
}

/* ── Chrome, over its DevTools socket ── */

const running = new Set();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    for (const chrome of running) chrome.kill();
    process.exit(1);
  });

async function launch() {
  const profile = await mkdtemp(join(tmpdir(), "ink-bench-"));
  const chrome = spawn(
    CHROME,
    [
      ...(flag("headed") ? [] : ["--headless=new"]),
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--hide-scrollbars",
      // Two builds take turns in two tabs; neither may be put to sleep.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  running.add(chrome);
  chrome.on("exit", () => running.delete(chrome));
  const endpoint = await new Promise((done, fail) => {
    let err = "";
    chrome.stderr.on("data", (d) => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) done(m[1]);
    });
    chrome.on("exit", () => fail(new Error(`Chrome exited:\n${err}`)));
    setTimeout(() => fail(new Error("Chrome did not start")), 15000);
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
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  async function page(url, device) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    await call("Emulation.setDeviceMetricsOverride", device);
    if (device.mobile) {
      await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await call("Emulation.setEmulatedMedia", {
        features: [
          { name: "hover", value: "none" },
          { name: "pointer", value: "coarse" },
        ],
      }).catch(() => {});
    }
    const evaluate = async (expression) => {
      const r = await call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const until = async (expression, what) => {
      for (let i = 0; i < 300; i++) {
        if (await evaluate(expression)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for ${what} at ${url}`);
    };
    const go = async (to = url) => {
      await call("Page.navigate", { url: to });
    };
    await go();
    return { evaluate, until, go, call };
  }

  return {
    page,
    async close() {
      chrome.kill();
      await new Promise((r) => chrome.on("exit", r));
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/* ── The runs ── */

async function benchDevice(name, builds) {
  const device = DEVICES[name];
  const chrome = await launch();
  try {
    const pages = [];
    for (const b of builds) {
      const p = await chrome.page(`${b.url}/?inkbench=driven`, device);
      await p.until("!!window.__inkBench", "the bench hook (is this build made with ?inkbench support?)");
      await p.evaluate("window.__inkBench.prepare()");
      pages.push(p);
    }
    const load = Math.max(
      ...(await Promise.all(pages.map((p) => p.evaluate("window.__inkBench.load()")))),
    );
    for (const p of pages) await p.evaluate(`window.__inkBench.load(${load})`);
    for (let r = 0; r < ROUNDS; r++) {
      process.stdout.write(`\r${name}: round ${r + 1}/${ROUNDS} `);
      const order = r % 2 ? [...pages].reverse() : pages;
      for (const p of order) await p.evaluate("window.__inkBench.round().then(() => 1)");
    }
    process.stdout.write("\r");
    const results = [];
    for (const p of pages) {
      // The paced check runs on animation frames, which a tab behind
      // another does not get.
      await p.call("Page.bringToFront");
      results.push(await p.evaluate("window.__inkBench.report()"));
    }

    results.forEach((r, i) => {
      console.log(`\n══ ${name}${builds.length > 1 ? `, build ${builds[i].label}` : ""} ══`);
      console.log(r.text.replace(/\nload \(this visit\).*$/s, "").trimEnd());
    });
    if (results.length === 2) compare(name, results[0], results[1]);
    return results;
  } finally {
    await chrome.close();
  }
}

function compare(name, a, b) {
  const paired = (of) =>
    a.rounds.map((_, i) => of(b, i) / of(a, i)).filter((x) => Number.isFinite(x));
  const line = (label, v, note = "") =>
    console.log(
      `  ${label.padEnd(26)}×${median(v).toFixed(3)}  (${pct(median(v) - 1)}; spread ${pct(spread(v))})${note}`,
    );
  const d = (k) => `${a.counts[k]} → ${b.counts[k]}`;
  const m = (k) => `${(a.counts[k] / 1e6).toFixed(2)}M → ${(b.counts[k] / 1e6).toFixed(2)}M`;
  console.log(`\n── ${name}: B against A, over ${a.rounds.length} paired rounds ──`);
  const gpu = paired((r, i) => (r.gpuRounds[i] === null ? NaN : r.gpuRounds[i] / r.rounds[i].ref));
  if (gpu.length) line("GPU time a frame", gpu, `  in ref units, ${gpu.length} rounds`);
  else console.log("  GPU time a frame: no round was quiet enough to read it");
  line("frame, back to back", paired((r, i) => r.rounds[i].wall));
  line("  with nothing shaded", paired((r, i) => r.rounds[i].bare));
  line("reference", paired((r, i) => r.rounds[i].ref), "  the same work in both");
  if (gpu.length < 4 || spread(gpu) > 0.08)
    console.log("  Too few quiet rounds, or too wide a spread, to trust the GPU figure: run it again, or with more --rounds.");
  console.log(`  draws ${d("draws")}, GL calls ${d("calls")}`);
  console.log(`  fragments ${m("fragments")}, texture reads ${m("taps")}`);
  console.log(
    `  GPU memory ${(a.counts.bytes / 2 ** 20).toFixed(1)} → ${(b.counts.bytes / 2 ** 20).toFixed(1)} MB`,
  );
}

async function loads(build) {
  const runs = { cold: [], warm: [] };
  for (let i = 0; i < LOADS; i++) {
    process.stdout.write(`\rload ${build.label}: ${i + 1}/${LOADS} `);
    const chrome = await launch();
    try {
      const p = await chrome.page(`${build.url}/?inkbench=driven`, DEVICES.desktop);
      const marks = `(() => {
        const at = (n) => performance.getEntriesByName(n)[0]?.startTime;
        return at("ink:ready") === undefined ? null : {
          create: at("ink:create"), build: at("ink:built") - at("ink:create"),
          link: at("ink:linked") - at("ink:built"), setup: at("ink:ready") - at("ink:linked"),
          ready: at("ink:ready"),
        };
      })()`;
      for (const kind of ["cold", "warm"]) {
        await p.until(marks, "the ink to be ready");
        runs[kind].push(await p.evaluate(marks));
        if (kind === "cold") {
          await p.go("about:blank");
          await p.go();
        }
      }
    } finally {
      await chrome.close();
    }
  }
  process.stdout.write("\r");
  console.log(`\n══ load, build ${build.label} (desktop, ${LOADS} fresh profiles; least / median, ms) ══`);
  const row = (label, key) => {
    const cell = (v) =>
      `${Math.min(...v.map((r) => r[key])).toFixed(1).padStart(7)} /${median(v.map((r) => r[key])).toFixed(1).padStart(7)}`;
    console.log(`  ${label.padEnd(44)} cold ${cell(runs.cold)}   warm ${cell(runs.warm)}`);
  };
  row("script starts creating the ink at", "create");
  row("context + 9 programs queued (blocks the page)", "build");
  row("waiting on the shader link (page is free)", "link");
  row("uniforms, targets, first draw (blocks)", "setup");
  row("ink ready at", "ready");
  return runs;
}

/* ── Main ── */

const reports = [];
const builds = [];
for (const [label, dir] of [["A", A], ...(B ? [["B", B]] : [])]) {
  const server = await serve(dir, (r) => {
    reports.push({ label, ...r });
    console.log(`\n══ from a device, build ${label} ══\n${r.text}\n`);
    if (SAVE) writeFile(SAVE, JSON.stringify(reports, null, 1));
  });
  builds.push({ label, dir, ...server, url: `http://localhost:${server.port}` });
}

const out = { shipped: {}, devices: {}, loads: {} };
for (const b of builds)
  out.shipped[b.label] = printShipped(`build ${b.label} (${b.dir})`, await shipped(b.dir));

if (flag("phone")) {
  const ip = Object.values(networkInterfaces())
    .flat()
    .find((n) => n.family === "IPv4" && !n.internal)?.address;
  console.log("\nOn the phone (same network), open and tap “run ink bench”:");
  for (const b of builds)
    console.log(`  build ${b.label}:  http://${ip}:${b.port}/?inkbench&report=/report`);
  console.log("\nResults print here as they arrive. Ctrl-C when done.");
} else {
  for (const name of DEVICE === "both" ? ["desktop", "phone"] : [DEVICE])
    out.devices[name] = await benchDevice(name, builds);
  if (LOADS > 0) for (const b of builds) out.loads[b.label] = await loads(b);
  if (SAVE) await writeFile(SAVE, JSON.stringify(out, null, 1));
  for (const b of builds) b.close();
  process.exit(0);
}
