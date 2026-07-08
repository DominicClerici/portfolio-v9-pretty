/*
 * Minimal Lenis-style smooth scroll.
 *
 * Unlike transform-based smooth-scroll wrappers, this drives the *real* document
 * scroll position via window.scrollTo. That keeps position: sticky, window.scrollY,
 * native scroll events, and IntersectionObservers all working — so the Hero canvas
 * parallax and the header observers ride along unchanged, just smoothed.
 *
 * Scope is intentionally tiny: wheel-driven easing on the root, native scroll left
 * alone on touch, plus the small amount of glue needed to coexist with the rest of
 * the site (external-scroll resync, anchor links, reduced-motion, opt-out regions).
 */

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (!prefersReducedMotion) {
  // Fraction of the remaining distance covered per 60fps frame, expressed as a
  // continuous rate so the feel is identical at 60Hz, 120Hz, or any refresh.
  const LERP = 0.1;
  const LAMBDA = -Math.log(1 - LERP) * 60;
  const WHEEL_MULTIPLIER = 1;

  const maxScroll = () => document.documentElement.scrollHeight - window.innerHeight;
  const clamp = (value: number) => Math.max(0, Math.min(value, maxScroll()));

  let target = window.scrollY;
  let current = window.scrollY;
  let running = false;
  let lastTime = 0;

  const tick = (time: number) => {
    // Clamp dt so a backgrounded tab (paused rAF) can't produce a wild step.
    const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.064) : 0;
    lastTime = time;

    const alpha = 1 - Math.exp(-LAMBDA * dt);
    current += (target - current) * alpha;

    // Snap and stop once we're within a sub-pixel of the target.
    if (Math.abs(target - current) < 0.1) current = target;

    window.scrollTo(0, current);

    if (current === target) {
      running = false;
      return;
    }
    requestAnimationFrame(tick);
  };

  const start = () => {
    if (running) return;
    running = true;
    lastTime = 0;
    requestAnimationFrame(tick);
  };

  // Public scroll-to that rides the same easing. Consumers (e.g. the Career
  // scroll-pin) call this instead of window.scrollTo so programmatic jumps feel
  // identical to wheel scrolling and don't fight the engine's resync.
  (window as any).__smoothScrollTo = (y: number) => {
    target = clamp(y);
    start();
  };

  window.addEventListener(
    "wheel",
    (e) => {
      // Let the browser own zoom gestures and any opted-out scroll region.
      if (e.ctrlKey) return;
      if ((e.target as Element)?.closest?.("[data-lenis-prevent]")) return;

      e.preventDefault();
      target = clamp(target + e.deltaY * WHEEL_MULTIPLIER);
      start();
    },
    { passive: false },
  );

  // Any scroll we didn't cause — keyboard, scrollbar drag, find-in-page — resyncs
  // the engine so it never fights the user or snaps back. Movement during our own
  // animation is ignored (running), as is the rounding noise from the final frame.
  window.addEventListener(
    "scroll",
    () => {
      if (running) return;
      if (Math.abs(window.scrollY - current) < 2) return;
      target = current = window.scrollY;
    },
    { passive: true },
  );

  // In-page anchor links ease through the same engine.
  document.addEventListener("click", (e) => {
    const link = (e.target as Element)?.closest?.<HTMLAnchorElement>('a[href^="#"]');
    if (!link) return;

    const hash = link.getAttribute("href");
    if (!hash || hash === "#") return;

    const el = document.querySelector(hash);
    if (!el) return;

    e.preventDefault();
    target = clamp(window.scrollY + el.getBoundingClientRect().top);
    start();
    history.pushState(null, "", hash);
  });

  // Content reflow (fonts, images, viewport resize) can move the lower bound.
  window.addEventListener("resize", () => {
    target = clamp(target);
  });
} else {
  // No eased engine under reduced motion — still expose the API so consumers can
  // navigate; here it's an instant (accessible) jump.
  (window as any).__smoothScrollTo = (y: number) =>
    window.scrollTo(0, Math.max(0, y));
}
