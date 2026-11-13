// Temporary: checks that two builds of the ink (src/scripts/ink-fluid.ts)
// draw the same picture. Both are stepped through the same scripted minute
// with a fixed clock (the opening drops, the idle brushes, a pointer stroke
// or a finger, a scroll, the turn to dark), and at each checkpoint the
// canvas and the simulation's own float targets are read back and compared.
//
//   pnpm build
//   node ink-look.mjs --a <baseline dir> [--b dist/client]
//        [--device desktop|phone|both] [--out dir] [--chrome <path>]
//        [--qa <query>] [--qb <query>]
//
// With the same build as A and B it must report no difference at all: that
// is the check that the run is deterministic on this machine.
//
// canvas   the 8-bit picture: the largest difference in any channel, in
//          levels of 255, and how many pixels differ at all. On a touch
//          screen the canvas is two frames tall and each half is given.
// dye etc. the float targets: the largest absolute difference, beside the
//          largest value there, so it can be read as a proportion.
//
// --out saves each checkpoint's two pictures and their difference (x64).
//
// The water is chaotic: a difference in the last digit of one value becomes
// a different swirl within a couple of seconds (as does a frame arriving a
// millisecond late, so no two visits see the same one). Run as above, only
// a change that alters no arithmetic at all compares equal. For one that
// rounds differently, --step: at each checkpoint B is first given A's
// simulation exactly, both then draw one frame, and that frame is compared.
// What it shows is how far one frame of B strays from the same frame of A,
// with the float differences also given in steps of the half-float they are
// stored in ("ulp"). Steps marked "no frame" compare the targets straight
// after the splats, before the water has moved.
//
// --jitter (with --step, and the same build as A and B) is the control for
// that: B gets A's simulation with one velocity in a hundred moved by a
// single ulp, which shows how far a frame strays from rounding alone.
//
// Alpha is left out of the float comparison: nothing reads it.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const A = arg("a", "dist/client");
const B = arg("b", "dist/client");
// The query each build's page is opened with: "inklook" for the ink as shipped,
// "inklook=main" or "inklook=worker" to say which thread it is on.
const QUERY = [arg("qa", "inkbench=driven"), arg("qb", "inkbench=driven")];
const DEVICE = arg("device", "both");
const OUT = arg("out", "");
const STEP = process.argv.includes("--step");
const JITTER = process.argv.includes("--jitter");
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
// Reduced motion keeps the ink's own loop from running and plays the opening
// drops out at a fixed pace, so it is how those are checked. It also turns
// off the two-frame canvas a touch screen gets, so that is run with motion
// on: there every frame still comes from this script, but from a clean sheet
// and without the drops.
const RUNS = {
  desktop: { device: DEVICES.desktop, still: true },
  phone: { device: DEVICES.phone, still: true },
  "phone, two tiles": { device: DEVICES.phone, still: false },
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

async function serve(dir) {
  const root = resolve(dir);
  await stat(join(root, "index.html"));
  const server = createServer(async (req, res) => {
    let file = join(root, normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)));
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
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://localhost:${server.address().port}`, close: () => server.close() };
}

async function launch() {
  const profile = await mkdtemp(join(tmpdir(), "ink-look-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--hide-scrollbars",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
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

  async function page(url, device, still) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    await call("Emulation.setDeviceMetricsOverride", device);
    const features = still ? [{ name: "prefers-reduced-motion", value: "reduce" }] : [];
    if (device.mobile) {
      await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      features.push({ name: "hover", value: "none" }, { name: "pointer", value: "coarse" });
    }
    await call("Emulation.setEmulatedMedia", { features });
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
    await call("Page.navigate", { url });
    for (let i = 0; ; i++) {
      if (await evaluate("!!window.__inkLook").catch(() => false)) break;
      if (i > 300) throw new Error(`no ink look hook at ${url}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return { evaluate };
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

/* ── In the page ── */

// Positions are fractions of the viewport, y down.
const IN_PAGE = `window.__lk = (() => {
  const hook = window.__inkLook;
  const { ink } = hook;
  const canvas = document.getElementById("ink-canvas");
  // Builds from before the ink could be on a worker gave out its GL context
  // in place of calls.
  const legacy = (probe) => {
    const gl = probe.gl;
    return {
      run(n) {
        for (let i = 0; i < n; i++) probe.frame(1 / 60);
        const bytes = new Uint8Array(gl.canvas.width * gl.canvas.height * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, gl.canvas.width, gl.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        return { w: gl.canvas.width, h: gl.canvas.height, bytes };
      },
      drop: (i) => probe.drop(i),
      read(what) {
        const t = probe.state()[what];
        const f = new Float32Array(t.w * t.h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, f);
        return { w: t.w, h: t.h, bytes: new Uint8Array(f.buffer) };
      },
      write(what, bytes) {
        const t = probe.state()[what];
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, new Float32Array(bytes.buffer));
      },
      info: () => ink.tune({}),
      reset: () => void ink.tune({ dye: ink.tune({}).dye }),
    };
  };
  const look = hook.look ?? (hook.probe.read ? hook.probe : legacy(hook.probe));
  const held = {};
  const pending = {};
  const b64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const at = (x, y) => ({ clientX: x * innerWidth, clientY: y * innerHeight });
  return {
    ink,
    put(what, text) {
      (pending[what] ||= []).push(text);
    },
    async commit(what) {
      const bin = atob(pending[what].join(""));
      delete pending[what];
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await look.write(what, bytes);
    },
    info: async () => ({
      ...(await look.info()),
      tiles: getComputedStyle(canvas).getPropertyValue("--ink-tiles").trim() || "1",
    }),
    reset: () => look.reset(),
    drop: (i) => look.drop(i),
    async run(n) {
      held.canvas = await look.run(n);
    },
    mouse(x, y) {
      window.dispatchEvent(new PointerEvent("pointermove", { ...at(x, y), pointerType: "mouse" }));
    },
    touch(type, x, y) {
      const t = new Touch({ identifier: 1, target: document.body, ...at(x, y) });
      window.dispatchEvent(new TouchEvent(type, { touches: [t], changedTouches: [t] }));
    },
    async grab(what) {
      if (what !== "canvas") held[what] = await look.read(what);
      const h = held[what];
      h.text = b64(h.bytes);
      return { w: h.w, h: h.h, length: h.text.length };
    },
    slice: (what, from, n) => held[what].text.slice(from, from + n),
  };
})(); 1`;

// Each call may be answered from another thread, so each is waited for.
const play = (page, script) =>
  page.evaluate(`(async () => { ${script.replaceAll("__lk.", "await __lk.")} })().then(() => 1)`);

// A slow curve, a fast flick (several splats a frame), and a pass along the
// top edge, where a splat's far side comes back in at the bottom.
const stroke = (move) => {
  const steps = [];
  for (let i = 0; i <= 24; i++) {
    const k = i / 24;
    steps.push([0.2 + 0.3 * k, 0.6 - 0.25 * Math.sin(k * Math.PI)]);
  }
  for (let i = 1; i <= 6; i++) steps.push([0.5 + 0.07 * i, 0.6 - 0.09 * i]);
  for (let i = 0; i <= 12; i++) steps.push([0.9 - 0.06 * i, 0.012 + 0.004 * (i % 3)]);
  return steps.map(([x, y]) => `${move(x, y)}; __lk.run(1);`).join("");
};

const scenario = (touch) => [
  ["opening drops", "__lk.reset(); __lk.run(1);"],
  ["idle, 2 s", "__lk.run(120);"],
  touch
    ? [
        "finger",
        `__lk.touch("touchstart", 0.3, 0.7); __lk.run(1);` +
          stroke((x, y) => `__lk.touch("touchmove", ${x}, ${y})`) +
          `__lk.touch("touchstart", 0.6, 0.995); __lk.run(3);`,
      ]
    : ["pointer", stroke((x, y) => `__lk.mouse(${x}, ${y})`)],
  [
    "scrolling",
    Array.from({ length: 30 }, (_, i) => `__lk.ink.setScroll(${(i + 1) * 23}); __lk.run(1);`).join(""),
  ],
  [
    "stroke after scroll",
    touch
      ? `__lk.touch("touchstart", 0.5, 0.02); __lk.run(1); __lk.touch("touchmove", 0.7, 0.3); __lk.run(1);`
      : `__lk.mouse(0.3, 0.98); __lk.run(1); __lk.mouse(0.5, 0.99); __lk.run(1); __lk.mouse(0.8, 0.6); __lk.run(1);`,
  ],
  ["half dark", "__lk.ink.setDarkness(0.5); __lk.run(1);"],
  ["idle, 10 s more", "__lk.ink.setDarkness(0); __lk.run(600);"],
];

// For --step: [label, what both do first, the one frame compared].
const steps = (touch) => {
  const move = touch
    ? (x, y) => `__lk.touch("touchmove", ${x}, ${y}); __lk.run(1);`
    : (x, y) => `__lk.mouse(${x}, ${y}); __lk.run(1);`;
  const slow = Array.from({ length: 12 }, (_, i) => move(0.2 + 0.012 * i, 0.6 - 0.01 * i)).join("");
  return [
    ["first drop", "__lk.reset();", "__lk.drop(0); __lk.run(1);"],
    ["drop, no frame", "", "__lk.drop(1);"],
    ["second drop", "", "__lk.drop(1); __lk.run(1);"],
    ["third drop", "", "__lk.drop(2); __lk.run(1);"],
    ["idle", "__lk.run(120);", "__lk.run(1);"],
    ...(touch ? [["finger lands", "", `__lk.touch("touchstart", 0.2, 0.6); __lk.run(1);`]] : []),
    ["stroke, slow", slow, move(0.35, 0.47)],
    ["stroke, flick", "", move(0.8, 0.15)],
    ["stroke, top edge", move(0.7, 0.012), move(0.55, 0.004)],
    [
      "scrolling",
      Array.from({ length: 10 }, (_, i) => `__lk.ink.setScroll(${(i + 1) * 23}); __lk.run(1);`).join(""),
      "__lk.ink.setScroll(253); __lk.run(1);",
    ],
    ["stroke, bottom edge", move(0.3, 0.98), move(0.5, 0.995)],
    ["half dark", "", "__lk.ink.setDarkness(0.5); __lk.run(1);"],
    ["idle, 10 s on", "__lk.ink.setDarkness(0); __lk.run(600);", "__lk.run(1);"],
    ["drop, no frame", "", "__lk.drop(0);"],
  ];
};

/* ── Comparing ── */

const WHAT = ["dye", "velocity", "pressure"];
async function copyState(from, to) {
  const CHUNK = 4 << 20;
  for (const what of WHAT) {
    const { bytes } = await fetchHeld(from, what);
    if (JITTER && what === "velocity") {
      const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
      for (let i = 0; i < f.length; i += 400) f[i] += halfUlp(f[i]);
    }
    const text = bytes.toString("base64");
    for (let i = 0; i < text.length; i += CHUNK)
      await to.evaluate(`__lk.put("${what}", "${text.slice(i, i + CHUNK)}"); 1`);
    await to.evaluate(`__lk.commit("${what}"); 1`);
  }
}

async function fetchHeld(page, what) {
  const { w, h, length } = await page.evaluate(`__lk.grab(${JSON.stringify(what)})`);
  let text = "";
  const CHUNK = 4 << 20;
  for (let i = 0; i < length; i += CHUNK)
    text += await page.evaluate(`__lk.slice(${JSON.stringify(what)}, ${i}, ${CHUNK})`);
  return { w, h, bytes: Buffer.from(text, "base64") };
}

function diffCanvas(a, b, rows) {
  if (a.w !== b.w || a.h !== b.h) return [{ note: `sizes differ: ${a.w}x${a.h} / ${b.w}x${b.h}` }];
  const rowBytes = a.w * 4;
  const per = Math.floor(a.h / rows);
  return Array.from({ length: rows }, (_, r) => {
    let max = 0;
    let differing = 0;
    let over = 0;
    for (let i = r * per * rowBytes; i < (r + 1) * per * rowBytes; i += 4) {
      const d = Math.max(
        Math.abs(a.bytes[i] - b.bytes[i]),
        Math.abs(a.bytes[i + 1] - b.bytes[i + 1]),
        Math.abs(a.bytes[i + 2] - b.bytes[i + 2]),
      );
      if (d) differing++;
      if (d > 1) over++;
      if (d > max) max = d;
    }
    return { max, differing, over, of: per * a.w };
  });
}

const halfUlp = (v) => 2 ** (Math.max(Math.floor(Math.log2(Math.abs(v))), -14) - 10);

function diffFloat(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { note: "sizes differ" };
  const fa = new Float32Array(a.bytes.buffer, a.bytes.byteOffset, a.bytes.length / 4);
  const fb = new Float32Array(b.bytes.buffer, b.bytes.byteOffset, b.bytes.length / 4);
  let max = 0;
  let peak = 0;
  let differing = 0;
  let ulps = 0;
  for (let i = 0; i < fa.length; i++) {
    if (i % 4 === 3) continue;
    const d = Math.abs(fa[i] - fb[i]);
    if (d) {
      differing++;
      ulps = Math.max(ulps, d / halfUlp(Math.max(Math.abs(fa[i]), Math.abs(fb[i]))));
    }
    if (d > max) max = d;
    if (Math.abs(fa[i]) > peak) peak = Math.abs(fa[i]);
  }
  return { max, peak, differing, ulps, of: (fa.length / 4) * 3 };
}

async function save(dir, name, a, b) {
  const { default: sharp } = await import("sharp");
  const png = (bytes) =>
    sharp(bytes, { raw: { width: a.w, height: a.h, channels: 4 } }).flip().removeAlpha().png();
  const d = Buffer.alloc(a.bytes.length, 255);
  for (let i = 0; i < d.length; i++)
    if (i % 4 !== 3) d[i] = Math.min(255, Math.abs(a.bytes[i] - b.bytes[i]) * 64);
  await png(a.bytes).toFile(join(dir, `${name}-a.png`));
  await png(b.bytes).toFile(join(dir, `${name}-b.png`));
  await png(d).toFile(join(dir, `${name}-diff.png`));
}

/* ── Main ── */

const servers = [await serve(A), await serve(B)];
let worst = 0;
try {
  for (const name of Object.keys(RUNS).filter((n) => DEVICE === "both" || n.startsWith(DEVICE))) {
    const { device, still } = RUNS[name];
    const chrome = await launch();
    try {
      const pages = [];
      for (const [i, s] of servers.entries()) {
        const p = await chrome.page(`${s.url}/?${QUERY[i]}`, device, still);
        await p.evaluate(IN_PAGE);
        for (let n = 0; !(await p.evaluate("__lk.info()")).dyeGrid; n++) {
          if (n > 200) throw new Error(`the ink never came up at ${s.url}/?${QUERY[i]}`);
          await new Promise((r) => setTimeout(r, 50));
        }
        pages.push(p);
      }
      const info = await Promise.all(pages.map((p) => p.evaluate("__lk.info()")));
      const tiles = +info[0].tiles;
      console.log(
        `\n══ ${name}: buffer ${info[0].buffer}, ink ${info[0].dyeGrid}, tiles ${tiles}` +
          `${JSON.stringify(info[0]) === JSON.stringify(info[1]) ? "" : `  (B: ${JSON.stringify(info[1])})`} ══`,
      );
      if (OUT) await mkdir(OUT, { recursive: true });
      const list = STEP
        ? steps(device.mobile)
        : scenario(device.mobile).map(([label, script]) => [label, "", script]);
      for (const [label, first, script] of list) {
        if (STEP) {
          for (const p of pages) await play(p, first);
          await copyState(pages[0], pages[1]);
        }
        for (const p of pages) await play(p, script);
        const cells = [];
        const [ca, cb] = [await fetchHeld(pages[0], "canvas"), await fetchHeld(pages[1], "canvas")];
        // readPixels starts at the bottom row.
        diffCanvas(ca, cb, tiles).forEach((d, i) => {
          if (d.note) return cells.push(d.note);
          worst = Math.max(worst, d.max);
          const which = tiles > 1 ? (i ? "upper " : "lower ") : "";
          cells.push(`${which}canvas ${d.max}/255, ${d.differing} px (${d.over} by more than 1)`);
        });
        if (tiles > 1) {
          const half = cb.bytes.length / 2;
          const alike = cb.bytes.subarray(0, half).equals(cb.bytes.subarray(half));
          cells.push(`B's tiles ${alike ? "alike" : "differ"}`);
        }
        if (OUT) await save(OUT, `${name}-${label}`.replace(/[^a-z0-9]+/gi, "-"), ca, cb);
        for (const what of WHAT) {
          const d = diffFloat(await fetchHeld(pages[0], what), await fetchHeld(pages[1], what));
          cells.push(
            d.note ??
              `${what} ${d.max.toExponential(1)} of ${d.peak.toPrecision(3)}, ${d.ulps.toFixed(0)} ulp, ${((d.differing / d.of) * 100).toFixed(2)}%`,
          );
        }
        console.log(`${label.padEnd(20)} ${cells.join(" | ")}`);
      }
    } finally {
      await chrome.close();
    }
  }
} finally {
  for (const s of servers) s.close();
}
console.log(`\nworst canvas difference: ${worst}/255`);
process.exit(0);
