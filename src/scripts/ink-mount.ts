// The ink's place on the page. On a touch screen the simulation itself
// (ink-fluid.ts) runs in a worker, drawing straight to the canvas, so that
// neither compiling its shaders nor each frame's drawing is the page's to
// wait for. A worker cannot
// see the page, so what the ink needs from it is measured here and sent
// over: the frame's size, where the pointer is, the scroll, the turn to dark.
//
// Elsewhere, and where a worker cannot have the canvas, the same simulation
// runs here on the page's thread and is spoken to the same way.

import type {
  FrameSize,
  FromInk,
  Ink,
  InkLook,
  PointerSample,
  ToInk,
} from "./ink-fluid";

export type InkScene = {
  start(): void;
  stop(): void;
  resize(): void;
  /** Scroll into the pinned scope, CSS px. */
  setScroll(px: number): void;
  /** The turn to dark, 0 (paper) to 1 (the glass scene's dark backdrop). */
  setDarkness(t: number): void;
  /** For ink-debug.ts and ink-bench.ts: the ink itself, where it is on this
   *  thread (ask for that with `thread`), and null where it is not. */
  direct(): Promise<Ink | null>;
  /** For ink-look.mjs. */
  look(): {
    [K in keyof InkLook]: (
      ...args: Parameters<InkLook[K]>
    ) => Promise<ReturnType<InkLook[K]>>;
  };
};

export function mountInk(init: {
  canvas: HTMLCanvasElement;
  /** The element the canvas fills. */
  wrap: HTMLElement;
  reducedMotion: boolean;
  /** For the debug tools: which thread, whatever would be chosen. */
  thread?: "page" | "worker";
}): InkScene {
  let { canvas } = init;
  const { wrap, reducedMotion } = init;

  // On a phone the page hears its own scroll position late and in steps (a
  // fast flick, or Safari's bar sliding, brings it down to ten reports a
  // second), so a sheet slid from those reports lurches under copy that is
  // scrolling smoothly. There the canvas slides instead, on a scroll
  // timeline the compositor runs (global.css, ink-slide): it is --ink-tiles
  // frames tall, shows the looping sheet that many times over, and moving
  // it up one frame's height brings it back to where it began.
  const tiles =
    Number(getComputedStyle(canvas).getPropertyValue("--ink-tiles")) || 1;

  const measure = (): FrameSize => ({
    cssW: wrap.clientWidth,
    cssH: wrap.clientHeight,
    dpr: window.devicePixelRatio || 1,
  });

  let say: (m: ToInk, transfer?: Transferable[]) => void = () => {};
  let worker: Worker | null = null;
  let direct: Promise<Ink | null> = Promise.resolve(null);
  const now = { running: false, scroll: 0, dark: 0 };

  /* ── The pointer ── */

  // The events only note where it is. It is placed in the frame, which
  // means measuring the canvas, once a frame at most: by the frame that
  // uses it where the ink is on this thread, and by one of the page's own
  // where it is told of it.
  const ptr = { cx: 0, cy: 0, touch: false, landed: false, lift: false, fresh: false };
  function take(): PointerSample | null {
    if (!ptr.fresh) return null;
    const r = canvas.getBoundingClientRect();
    const at = {
      x: (ptr.cx - r.left) / r.width,
      y: 1 - (ptr.cy - r.top) / r.height,
      touch: ptr.touch,
      landed: ptr.landed,
      lift: ptr.lift,
    };
    ptr.fresh = ptr.landed = ptr.lift = false;
    return at;
  }
  let telling = 0;
  function tell() {
    cancelAnimationFrame(telling);
    telling = 0;
    const at = take();
    if (at) say({ is: "pointer", at });
  }
  function moved(x: number, y: number) {
    ptr.cx = x;
    ptr.cy = y;
    ptr.fresh = true;
    if (worker && !telling) telling = requestAnimationFrame(tell);
  }
  window.addEventListener(
    "pointermove",
    (e) => {
      // A finger's pointer events stop the moment the browser takes the
      // gesture for a scroll; its touch events (below) do not.
      if (e.pointerType === "touch") return;
      if (ptr.touch) ptr.lift = true;
      ptr.touch = false;
      moved(e.clientX, e.clientY);
    },
    { passive: true },
  );
  const onTouch = (e: TouchEvent) => {
    const f = e.touches[0];
    if (!f) return;
    // Each touch is a stroke of its own, not a line from the last one.
    if (e.type === "touchstart" && e.touches.length === 1)
      ptr.lift = ptr.landed = true;
    ptr.touch = true;
    moved(f.clientX, f.clientY);
  };
  window.addEventListener("touchstart", onTouch, { passive: true });
  window.addEventListener("touchmove", onTouch, { passive: true });

  /* ── Where the ink runs ── */

  let asked = 0;
  const waiting = new Map<number, (value: unknown) => void>();
  function heard(m: FromInk) {
    if (m.is === "failed") {
      if (worker) onPage();
    } else if (m.is === "mark") {
      // The worker's clock started when it did: onto the page's.
      if (worker)
        performance.mark(m.name, { startTime: m.at - performance.timeOrigin });
    } else {
      waiting.get(m.id)?.(m.value);
      waiting.delete(m.id);
    }
  }

  function open(to: HTMLCanvasElement | OffscreenCanvas, transfer: Transferable[]) {
    say({ is: "open", canvas: to, tiles, reducedMotion, size: measure() }, transfer);
    say({ is: "scroll", px: now.scroll });
    say({ is: "dark", t: now.dark });
    say({ is: "running", on: now.running });
  }

  function inWorker() {
    if (!canvas.transferControlToOffscreen) return false;
    // Told of a scroll, a worker draws it a frame after the page would have
    // (measured: 16 ms at 60 Hz, every time). Where the canvas slides itself
    // the scroll is not drawn at all, so nothing is late; where the ink
    // slides the sheet (one tile), it stays with the page.
    if (init.thread ? init.thread === "page" : tiles === 1) return false;
    try {
      worker = new Worker(new URL("./ink-fluid.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      return false;
    }
    const w = worker;
    say = (m, transfer = []) => w.postMessage(m, transfer);
    w.onmessage = (e: MessageEvent<FromInk>) => heard(e.data);
    w.onerror = () => {
      if (worker === w) onPage();
    };
    const offscreen = canvas.transferControlToOffscreen();
    open(offscreen, [offscreen]);
    return true;
  }

  function onPage() {
    if (worker) {
      worker.terminate();
      worker = null;
      // A canvas given to a worker cannot be taken back.
      const fresh = canvas.cloneNode() as HTMLCanvasElement;
      canvas.replaceWith(fresh);
      canvas = fresh;
    }
    const early: ToInk[] = [];
    say = (m) => early.push(m);
    direct = import("./ink-fluid").then((m) => {
      const served = m.serveInk(heard, take);
      say = served.hear;
      early.forEach(served.hear);
      return served.ink();
    });
    open(canvas, []);
  }

  if (!inWorker()) onPage();

  const look = (call: keyof InkLook) =>
    (...args: unknown[]) =>
      new Promise((done) => {
        if (worker) tell();
        waiting.set(++asked, done);
        say({ is: "look", id: asked, call, args });
      });

  return {
    start() {
      if (!now.running) say({ is: "running", on: (now.running = true) });
    },
    stop() {
      if (now.running) say({ is: "running", on: (now.running = false) });
    },
    resize: () => say({ is: "size", size: measure() }),
    setScroll(px) {
      if (px !== now.scroll) say({ is: "scroll", px: (now.scroll = px) });
    },
    setDarkness(t) {
      if (t !== now.dark) say({ is: "dark", t: (now.dark = t) });
    },
    direct: () => direct,
    look: () =>
      Object.fromEntries(
        (["run", "drop", "read", "write", "info", "reset"] as const).map((k) => [
          k,
          look(k),
        ]),
      ) as ReturnType<InkScene["look"]>,
  };
}
