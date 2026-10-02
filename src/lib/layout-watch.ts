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
// that moves an element also moves the document's end), the fonts settling,
// or a box a subscriber asked to have watched changing size on its own.
//
// Every subscriber is in two halves, and each change runs all the measuring
// first and all the writing after: one subscriber's reads after another's
// writes would each force a fresh style and layout pass, and on a phone these
// run every time the address bar slides in or out, mid-scroll. This way the
// first read settles layout once and the rest are cheap. One observer covers
// every watched box, so a change that resizes several of them at once (a
// font landing resizes most) is still one pass.

type Sub = { measure: () => void; apply?: () => void };
const subs = new Set<Sub>();
let ro: ResizeObserver | null = null;

const fire = () => {
  subs.forEach((s) => s.measure());
  subs.forEach((s) => s.apply?.());
};

/** Runs `measure` then `apply` now, and again after anything that can move
 *  laid-out content, including any change to the size of the `watch`ed
 *  elements. `measure` should only read layout and `apply` only write. */
export function onLayoutChange(
  measure: () => void,
  apply?: () => void,
  watch: Element[] = [],
): void {
  subs.add({ measure, apply });
  measure();
  apply?.();
  if (!ro) {
    window.addEventListener("resize", fire, { passive: true });
    ro = new ResizeObserver(fire);
    ro.observe(document.documentElement);
    document.fonts?.ready.then(fire);
  }
  for (const el of watch) ro.observe(el);
}

/** The element's top edge in document coordinates. */
export const docTop = (el: Element): number =>
  el.getBoundingClientRect().top + window.scrollY;
