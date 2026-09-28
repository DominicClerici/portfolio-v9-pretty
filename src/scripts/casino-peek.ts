/* ── Casino peek ──
   On phones the casino's door is its own drawer, peeking up from the foot of
   the page: the sheet's top bar, drawn into the footer (Footer.astro). A tap
   opens it, the sheet rising out of the peek; a pull up lifts the sheet
   itself, which follows the finger from there and is let go of exactly as
   its own handle is (sheet.ts decides between open and back down).

   The casino chunk is still fetched on demand: the footer warms it once the
   peek is on screen, and a press warms it too. A pull that outruns the
   download picks the sheet up where the finger has got to once it lands. */

import { loadCasino, type CasinoModule } from "./casino-trigger"

// px of upward travel before a press becomes a lift (and its click is eaten)
const SLOP = 6

type Drag = { move(y: number, t: number): void; end(t: number): void }

export function bindPeek(peek: HTMLElement) {
  let mod: CasinoModule | null = null
  const load = () =>
    loadCasino().then(
      (m) => (mod = m),
      () => null,
    )

  let id: number | null = null
  let startY = 0
  let startT = 0
  let lastY = 0
  let lastT = 0
  let lifting = false
  let drag: Drag | null = null
  let eatClickUntil = 0

  const open = () => void load().then((m) => m?.open(peek))

  const pickUp = () => {
    if (!mod || id === null || drag) return
    drag = mod.lift(peek, startY, startT)
    drag?.move(lastY, lastT)
  }

  peek.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || id !== null) return
    id = e.pointerId
    startY = lastY = e.clientY
    startT = lastT = e.timeStamp
    lifting = false
    void load()
  })

  // On the window rather than the peek: once the sheet is up the page is
  // inert under the modal, and the rest of the gesture may be re-aimed at
  // whatever the finger is over. Either way it bubbles here.
  addEventListener("pointermove", (e) => {
    if (e.pointerId !== id) return
    lastY = e.clientY
    lastT = e.timeStamp
    if (drag) return drag.move(lastY, lastT)
    if (lifting || startY - lastY < SLOP) return
    lifting = true
    if (mod) pickUp()
    else void load().then(pickUp)
  })

  const release = (e: PointerEvent) => {
    if (e.pointerId !== id) return
    id = null
    if (!lifting) return
    lifting = false
    eatClickUntil = performance.now() + 100
    if (drag) drag.end(e.timeStamp)
    // Let go before the chunk arrived: it was on its way up, so open it
    else if (e.type === "pointerup") open()
    drag = null
  }
  addEventListener("pointerup", release)
  addEventListener("pointercancel", release)

  // Taps, and Enter or Space from the keyboard
  peek.addEventListener("click", (e) => {
    e.preventDefault()
    if (performance.now() < eatClickUntil) return
    open()
  })

  return {
    /** Starts the download ahead of a tap, once the peek is in view. */
    warm: () => void load(),
  }
}
