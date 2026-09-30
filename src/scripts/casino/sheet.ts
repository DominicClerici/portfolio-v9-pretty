/* ── Bottom sheet ──
   On phones the casino rises from the bottom edge as a sheet rather than
   popping in over the page. Its title bar is the handle: drag it down and the
   sheet follows the finger, dimming the page less as it goes; let go and it
   either springs home or carries on out, at the speed it was thrown. From
   anywhere else in the sheet, a pull down from content that's already
   scrolled to its top does the same, as native sheets do.

   The motion is all springs and momentum rather than fixed curves, so a
   flick feels like one: the spring home starts at the speed the finger left
   at, and a dismiss keeps that speed and decelerates to the edge. Keyframes
   are sampled from the simulation and played with the Web Animations API,
   so they run on the compositor like any CSS animation.

   On the front page it also has a dock: the window's title bar, drawn into
   the foot of the page (the footer's peek). Opened from there, the sheet
   rises out of the peek rather than the screen's edge, and closes back down
   into it while it's still on screen; a drag on the peek lifts the sheet
   itself, handed over mid-gesture (lift). The bar's caption buttons are
   hidden while it sits at the dock, as the peek has none.

   Wider screens keep the centred dialog; SHEET_QUERY is the switch, and the
   same width as the stylesheet's own (casino.css). */

import { reducedMotion } from "./ui"

export const SHEET_QUERY = window.matchMedia("(max-width: 900px)")

// px of travel before a press on the handle becomes a drag (and its click is
// eaten); below it, taps on the bar's buttons stay taps.
const SLOP = 6
// Past these, a release dismisses: a flick down (px/ms), or a drag that has
// taken the sheet this fraction of the way down without being flung back up.
const FLICK = 0.45
const DISTANCE = 0.35
// How far an upward drag can stretch the sheet past its resting place.
const STRETCH = 36

// Critically damped (damping = 2·√stiffness): the quickest settle with no
// overshoot past the resting place. Snapping back is a touch quicker than
// rising in, as on iOS.
const SPRING = { stiffness: 340, damping: 2 * Math.sqrt(340) }
const OPEN_SPRING = { stiffness: 190, damping: 2 * Math.sqrt(190) }

/** A damped spring from `from` to 0 with a starting velocity (px/ms),
    sampled at 60fps until it settles. */
function spring(from: number, v0: number, { stiffness, damping }: typeof SPRING) {
  const dt = 1 / 60
  let x = from
  let v = v0 * 1000 // px/s
  const out = [x]
  for (let i = 0; i < 180; i++) {
    const a = -stiffness * x - damping * v
    v += a * dt
    x += v * dt
    out.push(x)
    if (Math.abs(x) < 0.4 && Math.abs(v) < 8) break
  }
  out[out.length - 1] = 0
  return out
}

const at = (y: number) => `translate3d(0, ${y}px, 0)`

/** Rubber band for an upward drag: resistance grows the further it goes. */
const stretch = (y: number) => (y >= 0 ? y : -STRETCH * (1 - Math.exp(y / (STRETCH * 2.5))))

export class Sheet {
  private y = 0
  private anim: Animation | null = null
  private scrimAnim: Animation | null = null
  private samples: { t: number; y: number }[] = []
  private dragging = false
  // Finger position minus sheet offset at grab time
  private origin = 0
  // The gesture under way began on the dock, so letting go decides between
  // open and back to the dock rather than between open and dismissed
  private lifting = false

  constructor(
    private shell: HTMLElement,
    private scrim: HTMLElement,
    handle: HTMLElement,
    private onDismiss: (velocity: number) => void,
    /** Where the dock is, as an offset from the sheet's resting place, or
        null when there is none on screen. */
    private dock: () => number | null = () => null,
  ) {
    this.bindHandle(handle)
    this.bindContent()
  }

  get active() {
    return SHEET_QUERY.matches
  }

  // Measured once per gesture or animation, never per frame: reading layout
  // right after writing a transform would force a style pass on every move
  private h = 0
  private dockY: number | null = null
  private measure() {
    this.h = this.shell.offsetHeight || window.innerHeight
    const d = this.dock()
    this.dockY = d !== null && d > 0 && d < this.h ? d : null
    return this.h
  }
  private get height() {
    return this.h || this.measure()
  }

  /* ── Motion ── */

  private stop() {
    // Freeze wherever a running animation has got to, so a grab mid-flight
    // picks the sheet up where it is
    if (this.anim) {
      const m = getComputedStyle(this.shell).transform
      this.y = m && m !== "none" ? new DOMMatrixReadOnly(m).m42 : this.y
      this.anim.cancel()
      this.anim = null
    }
    this.scrimAnim?.cancel()
    this.scrimAnim = null
  }

  private set(y: number) {
    this.y = y
    this.shell.style.transform = at(y)
    this.scrim.style.opacity = String(this.dim(y))
    this.docked(y)
  }

  /** Hides the caption buttons while the sheet is (nearly) down at the dock. */
  private docked(y: number) {
    this.shell.classList.toggle("is-docked", this.dockY !== null && y > this.dockY / 2)
  }

  private dim(y: number) {
    return Math.min(1, Math.max(0, 1 - y / this.height))
  }

  private play(frames: number[], duration: number, easing = "linear") {
    this.stop()
    const end = frames[frames.length - 1]
    this.shell.style.transform = at(end)
    this.scrim.style.opacity = String(this.dim(end))
    this.docked(end)
    this.anim = this.shell.animate(
      frames.map((y) => ({ transform: at(y) })),
      { duration, easing },
    )
    this.scrimAnim = this.scrim.animate(
      frames.map((y) => ({ opacity: this.dim(y) })),
      { duration, easing },
    )
    this.y = end
    const anim = this.anim
    return anim.finished.then(
      () => {
        if (this.anim === anim) this.anim = null
        return true
      },
      () => false,
    )
  }

  private springTo0(v0: number, params = SPRING) {
    const frames = spring(this.y, v0, params)
    return this.play(frames, (frames.length - 1) * (1000 / 60))
  }

  /** Rise in from the dock, or from below the screen. */
  enter() {
    this.stop()
    this.measure()
    if (reducedMotion.matches) return this.set(0)
    this.y = this.dockY ?? this.height
    void this.springTo0(0, OPEN_SPRING)
  }

  /** Leave, down into the dock or out through the bottom edge, carrying on
      at `velocity` (px/ms) if it was thrown. Resolves once it's there. */
  exit(velocity = 0): Promise<unknown> {
    this.dragging = false
    this.lifting = false
    if (reducedMotion.matches) return Promise.resolve()
    this.stop()
    const from = this.y
    const h = this.measure()
    const to = this.dockY ?? h + 24
    const dist = Math.max(1, to - from)
    // The curve's opening slope is 3 (0.2 → 0.6), so over 3·dist/v it leaves
    // at exactly the speed it was thrown, then eases into the edge
    const v = Math.max(velocity, 0)
    const duration = v > 0.1 ? Math.min(420, Math.max(180, (3 * dist) / v)) : 340
    return this.play([from, to], duration, v > 0.1 ? "cubic-bezier(0.2, 0.6, 0.35, 1)" : "cubic-bezier(0.32, 0.72, 0, 1)")
  }

  /** Back to rest, instantly, for the next open. */
  reset() {
    this.stop()
    this.dragging = false
    this.lifting = false
    this.shell.style.transform = ""
    this.scrim.style.opacity = ""
    this.shell.classList.remove("is-docked")
    this.y = 0
  }

  /** Picked up off the dock by a finger (or mouse) already on the move: the
      sheet starts there and follows it. The gesture's owner feeds it on
      through move() and end(). */
  lift(y: number, t: number) {
    this.stop()
    this.measure()
    this.set(this.dockY ?? this.height)
    this.begin(y, t)
    this.lifting = true
  }

  /* ── Dragging ── */

  // Times are the input events' own (e.timeStamp), not when their handlers
  // happened to run, so a busy main thread can't distort the fling speed
  private begin(y: number, t: number) {
    this.stop()
    this.measure()
    this.dragging = true
    this.samples = [{ t, y }]
    this.origin = y - this.y
  }

  move(y: number, t: number) {
    if (!this.dragging) return
    this.samples.push({ t, y })
    while (this.samples.length > 2 && t - this.samples[0].t > 100) this.samples.shift()
    this.set(stretch(y - this.origin))
  }

  end(t: number) {
    if (!this.dragging) return
    this.dragging = false
    const lifting = this.lifting
    this.lifting = false
    const s = this.samples
    const first = s[0]
    const last = s[s.length - 1]
    const dt = last.t - first.t
    // A finger held still before letting go has no speed left
    const v = dt > 0 && t - last.t < 80 ? (last.y - first.y) / dt : 0
    const h = this.height
    if (lifting) {
      // Mirror of the dismiss: a flick up, or a pull that has brought it
      // this share of the way up without being thrown back down, opens it
      const from = this.dockY ?? h
      if (v < -FLICK || (this.y < from * (1 - DISTANCE) && v < 0.2)) void this.springTo0(v)
      else this.onDismiss(v)
    } else if (v > FLICK || (this.y > h * DISTANCE && v > -0.2)) this.onDismiss(v)
    else void this.springTo0(v)
  }

  /** The title bar: any press there can become a drag, mouse or touch. */
  private bindHandle(handle: HTMLElement) {
    let id: number | null = null
    let startY = 0
    let live = false
    // A press that turned into a drag isn't a click on whatever it began on;
    // the click (if any) follows its pointerup straight away
    let eatClickUntil = 0

    handle.addEventListener(
      "click",
      (e) => {
        if (performance.now() > eatClickUntil) return
        e.stopPropagation()
        e.preventDefault()
      },
      { capture: true },
    )
    handle.addEventListener("pointerdown", (e) => {
      if (!this.active || e.button !== 0 || id !== null) return
      id = e.pointerId
      startY = e.clientY
      live = false
    })
    handle.addEventListener("pointermove", (e) => {
      if (e.pointerId !== id) return
      if (!live) {
        if (Math.abs(e.clientY - startY) < SLOP) return
        live = true
        handle.setPointerCapture(e.pointerId)
        this.begin(startY, e.timeStamp)
      }
      this.move(e.clientY, e.timeStamp)
    })
    const release = (e: PointerEvent) => {
      if (e.pointerId !== id) return
      id = null
      if (!live) return
      live = false
      eatClickUntil = performance.now() + 100
      this.end(e.timeStamp)
    }
    handle.addEventListener("pointerup", release)
    handle.addEventListener("pointercancel", release)
  }

  /** Content: a downward pull from something already scrolled to its top
      moves the sheet instead. Touch only — a mouse has the handle, and a
      wheel has nothing to pull. Decided on the gesture's first move, the one
      the browser still lets us cancel. */
  private bindContent() {
    let startX = 0
    let startY = 0
    let mode: "undecided" | "sheet" | "native" = "native"
    let scroller: HTMLElement | null = null

    this.shell.addEventListener(
      "touchstart",
      (e) => {
        mode = "native"
        if (!this.active || e.touches.length !== 1) return
        const target = e.target as Element
        // The bar has its own handling; the action buttons fire on press
        if (target.closest(".cz-titlebar, .cz-action, .cz-menu, input, textarea, select")) return
        startX = e.touches[0].clientX
        startY = e.touches[0].clientY
        scroller = scrollerOf(target, this.shell)
        mode = "undecided"
      },
      { passive: true },
    )
    this.shell.addEventListener(
      "touchmove",
      (e) => {
        if (mode === "native") return
        const t = e.touches[0]
        if (mode === "undecided") {
          const dx = t.clientX - startX
          const dy = t.clientY - startY
          if (dx === 0 && dy === 0) return
          const pullDown = dy > 0 && dy >= Math.abs(dx) && (!scroller || scroller.scrollTop <= 0)
          if (!pullDown || !e.cancelable) {
            mode = "native"
            return
          }
          mode = "sheet"
          this.begin(startY, e.timeStamp)
        }
        e.preventDefault()
        this.move(t.clientY, e.timeStamp)
      },
      { passive: false },
    )
    const done = (e: TouchEvent) => {
      if (mode === "sheet") this.end(e.timeStamp)
      mode = "native"
    }
    this.shell.addEventListener("touchend", done)
    this.shell.addEventListener("touchcancel", done)
  }
}

/** The nearest element between `from` and `root` that scrolls vertically. */
function scrollerOf(from: Element | null, root: HTMLElement) {
  for (let n = from; n && n !== root; n = n.parentElement) {
    if (!(n instanceof HTMLElement) || n.scrollHeight <= n.clientHeight + 1) continue
    const o = getComputedStyle(n).overflowY
    if (o === "auto" || o === "scroll") return n
  }
  return null
}
