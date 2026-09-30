// Where an element sits in the document, cached, for scroll-bus subscribers.
//
// A subscriber that reads getBoundingClientRect() every frame pays for a
// synchronous style and layout pass whenever anything earlier in the same
// tick has written a style — and on the bus something nearly always has. For
// an element that only ever moves with the page (no transform of its own or
// of its ancestors, not inside a sticky box), its viewport top is just its
// document top minus scrollY, and the document top only changes when layout
// does. So measure it then, and do arithmetic in the frame.
//
// "When layout does" is any of: the window resizing, the document's own box
// changing size (fonts landing, images decoding, a section growing — anything
// that moves an element also moves the document's end), or the fonts
// settling. Callbacks run synchronously from those, where layout is already
// clean, so the measuring itself is cheap.

const subs = new Set<() => void>();
let wired = false;

const fire = () => subs.forEach((cb) => cb());

/** Runs `cb` now and again after anything that can move laid-out content. */
export function onLayoutChange(cb: () => void): void {
  subs.add(cb);
  cb();
  if (wired) return;
  wired = true;
  window.addEventListener("resize", fire, { passive: true });
  new ResizeObserver(fire).observe(document.documentElement);
  document.fonts?.ready.then(fire);
}

/** The element's top edge in document coordinates. */
export const docTop = (el: Element): number =>
  el.getBoundingClientRect().top + window.scrollY;
