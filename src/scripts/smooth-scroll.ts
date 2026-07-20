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
 *
 * Soft barriers: consumers (e.g. the Career scroll-pin) can register the scroll
 * positions where the page visually "locks" (registered in pairs — the two edges
 * of each locked zone). A fast wheel flick that crosses an edge is caught two
 * different ways depending on whether you're entering or leaving the zone:
 *
 *   Entry (crossing in from outside): the engine brakes the real scroll to a stop
 *   *at* the edge — a smooth deceleration into the pin, exactly like easing into
 *   the top of the page — while simultaneously bleeding a quarter of the flick's
 *   speed into the pinned progress (see entryLead) so the lock starts scrubbing
 *   *during* the deceleration. The two overlap into one continuous slow-down with
 *   no dwell between the slide stopping and the progress starting.
 *
 *   Exit (crossing out from inside): no deceleration. Motion coasts at full speed
 *   right up to the edge, is cut instantly to zero there, then re-launches away at
 *   a quarter of the speed it hit the edge with — so leaving the pin reads as a
 *   clean snap-and-accelerate rather than a slow crawl toward the boundary.
 */

const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches

if (!prefersReducedMotion) {
  // Fraction of the remaining distance covered per 60fps frame, expressed as a
  // continuous rate so the feel is identical at 60Hz, 120Hz, or any refresh.
  const LERP = 0.15
  const LAMBDA = -Math.log(1 - LERP) * 60
  const WHEEL_MULTIPLIER = 0.75

  // Soft-barrier tuning.
  // Fraction of the incoming inertia carried past a barrier. On entry it's what
  // survives the brake; on exit it's the fraction of the impact speed you launch
  // away with. Both keep a quarter (a 0.75 inertia loss at the boundary).
  const RETENTION_ENTRY = 1
  const RETENTION_EXIT = 0.3
  // Below this overshoot past a barrier a crossing is ignored — slow/gentle
  // scrolls pass straight through; only fast flicks get caught and eased.
  const MIN_OVERSHOOT = 40
  // How close current must get to the barrier before the brake hands off to the
  // launch. Small enough that velocity has decayed to ~0 (the "stop").
  const BRAKE_EPS = 1

  const maxScroll = () =>
    document.documentElement.scrollHeight - window.innerHeight
  const clamp = (value: number) => Math.max(0, Math.min(value, maxScroll()))

  let target = window.scrollY
  let current = window.scrollY
  let running = false
  let lastTime = 0

  // Hard lock (modal popovers etc.): wheel input is swallowed and programmatic
  // jumps ignored, so the page cannot move until unlocked. The overflow:hidden
  // the locker also applies covers native inputs (touch, keyboard, scrollbar);
  // this covers the engine's own scrollTo-driven motion, which overflow:hidden
  // does not stop.
  let locked = false

  // Registered soft-barrier scroll positions (sorted ascending).
  let barriers: number[] = []
  // Barriers only catch wheel-driven motion; programmatic jumps (tab clicks,
  // anchors) pass through so they land exactly where asked.
  let crossingEnabled = false

  // Crossing state machine: "normal" exponential ease; "brake" easing to a stop
  // at a barrier (entry); "coast" full-speed ease up to a barrier (exit); or
  // "launch" ramping velocity up from zero on the far side.
  let mode: "normal" | "brake" | "coast" | "launch" = "normal"
  let crossB = 0
  let crossDir = 1
  let launchVel = 0
  // Entry only: the speed the flick would carry past the barrier (captured when
  // the brake engages), and the progress advanced ahead of the real scroll while
  // braking. entryLead lets the pinned section scrub its progress *during* the
  // deceleration so the hand-off has no dwell; it's read by consumers via
  // __scrollProgressLead and folded back into the real scroll at the barrier.
  let impactVel = 0
  let entryLead = 0

  // Nearest barrier strictly between current and target in the travel direction,
  // with enough overshoot beyond it to be worth catching.
  const nextBarrier = (c: number, t: number): number | null => {
    let best: number | null = null
    if (t > c) {
      for (const B of barriers) {
        if (
          B - c > BRAKE_EPS &&
          t - B > MIN_OVERSHOOT &&
          (best === null || B < best)
        )
          best = B
      }
    } else if (t < c) {
      for (const B of barriers) {
        if (
          c - B > BRAKE_EPS &&
          B - t > MIN_OVERSHOOT &&
          (best === null || B > best)
        )
          best = B
      }
    }
    return best
  }

  // Barriers are registered in pairs — each pair is the two edges of a locked
  // zone. A position strictly between a pair is "inside": crossing an edge from
  // there is an exit (coast, no brake) rather than an entry (brake to a stop).
  const isInsideZone = (p: number): boolean => {
    for (let i = 0; i + 1 < barriers.length; i += 2) {
      if (p > barriers[i] + BRAKE_EPS && p < barriers[i + 1] - BRAKE_EPS)
        return true
    }
    return false
  }

  const tick = (time: number) => {
    // Clamp dt so a backgrounded tab (paused rAF) can't produce a wild step.
    const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.064) : 0
    lastTime = time

    const alpha = 1 - Math.exp(-LAMBDA * dt)

    // Engage a new crossing before moving (only mid-flight wheel scrolls).
    // Inside a locked zone the crossing is an exit (coast); outside it's an
    // entry (brake).
    if (mode === "normal" && crossingEnabled && dt > 0) {
      const B = nextBarrier(current, target)
      if (B !== null) {
        crossB = B
        crossDir = target > current ? 1 : -1
        mode = isInsideZone(current) ? "coast" : "brake"
        if (mode === "brake") {
          impactVel = LAMBDA * (target - crossB) * crossDir
          entryLead = 0
        }
      }
    }

    if (mode === "brake") {
      // Ease the real scroll to a stop at the barrier (the page/frame slide
      // decelerates smoothly into the lock). Simultaneously bleed progress ahead
      // via entryLead: as the brake sheds speed (vb: impactVel -> 0), progress
      // picks it up (0 -> RETENTION_ENTRY * impactVel), so the two overlap and
      // there's no dwell at zero before progress starts moving.
      const vb = LAMBDA * (crossB - current) * crossDir
      const vLead = RETENTION_ENTRY * Math.max(0, impactVel - vb)
      entryLead += crossDir * vLead * dt

      current += (crossB - current) * alpha

      const overshoot = (target - crossB) * crossDir
      if (overshoot <= MIN_OVERSHOOT) {
        // User eased off or reversed before reaching the edge — resume normally,
        // dropping the (tiny) progress lead accumulated so far.
        entryLead = 0
        mode = "normal"
      } else if (Math.abs(current - crossB) < BRAKE_EPS) {
        // Reached the edge: fold the progress lead into the real scroll (the pin
        // is frozen, so this moves nothing visually) and continue easing to a
        // retained landing, picking up at exactly the speed the lead left off —
        // one continuous decel from the flick speed down to rest.
        current = crossB + entryLead
        const retainedVel = RETENTION_ENTRY * impactVel
        const retainedTarget = current + (crossDir * retainedVel) / LAMBDA
        target =
          crossDir > 0
            ? Math.min(target, retainedTarget)
            : Math.max(target, retainedTarget)
        entryLead = 0
        mode = "normal"
      }
    } else if (mode === "coast") {
      // Exit: keep full-speed easing (no deceleration toward the edge) until we
      // reach it, then cut to zero and launch at half the impact speed.
      current += (target - current) * alpha
      const overshoot = (target - crossB) * crossDir
      if (overshoot <= MIN_OVERSHOOT) {
        // User eased off or reversed before reaching the edge — resume normally.
        mode = "normal"
      } else if ((current - crossB) * crossDir >= 0) {
        current = crossB
        target = crossB + RETENTION_EXIT * (target - crossB)
        launchVel = 0
        mode = "launch"
      }
    } else if (mode === "launch") {
      // vExp is the velocity the plain exponential ease would apply right now;
      // ramp launchVel up toward it so motion accelerates from rest, then merge
      // back into the normal ease once we've caught up to it.
      const vExp = LAMBDA * (target - current)
      launchVel += (vExp - launchVel) * alpha
      current += launchVel * dt
      if (
        Math.abs(launchVel) >= Math.abs(vExp) ||
        Math.abs(target - current) < BRAKE_EPS
      ) {
        mode = "normal"
      }
    } else {
      current += (target - current) * alpha
    }

    // Snap and stop once we're within a sub-pixel of the target.
    if (mode === "normal" && Math.abs(target - current) < 0.1) current = target

    window.scrollTo(0, current)

    if (mode === "normal" && current === target) {
      running = false
      return
    }
    requestAnimationFrame(tick)
  }

  const start = () => {
    if (running) return
    running = true
    lastTime = 0
    requestAnimationFrame(tick)
  }

  // Public scroll-to that rides the same easing. Consumers (e.g. the Career
  // scroll-pin) call this instead of window.scrollTo so programmatic jumps feel
  // identical to wheel scrolling and don't fight the engine's resync. Barriers
  // are bypassed so a jump lands exactly on its target.
  ;(window as any).__smoothScrollTo = (y: number) => {
    if (locked) return
    crossingEnabled = false
    mode = "normal"
    entryLead = 0
    target = clamp(y)
    start()
  }

  // Lock/unlock the engine. Locking freezes any in-flight easing where it is
  // so momentum can't carry the page after the lock engages.
  ;(window as any).__smoothScrollLock = (lock: boolean) => {
    locked = lock
    if (lock) {
      target = current = window.scrollY
      mode = "normal"
      entryLead = 0
    }
  }

  // Register the soft-barrier scroll positions (absolute document Y). Consumers
  // recompute and re-register on layout changes; passing the same values is cheap
  // and harmless.
  ;(window as any).__setScrollBarriers = (ys: number[]) => {
    barriers = ys.filter((y) => Number.isFinite(y)).sort((a, b) => a - b)
  }

  // Progress advanced ahead of the real scroll during an entry brake, in scroll
  // pixels. A pinned consumer adds this to its scroll-derived progress so the
  // lock scrubs *during* the deceleration; it's zero except mid-brake.
  ;(window as any).__scrollProgressLead = () => entryLead

  window.addEventListener(
    "wheel",
    (e) => {
      // Let the browser own zoom gestures and any opted-out scroll region.
      if (e.ctrlKey) return
      if ((e.target as Element)?.closest?.("[data-lenis-prevent]")) return

      e.preventDefault()
      if (locked) return
      crossingEnabled = true
      target = clamp(target + e.deltaY * WHEEL_MULTIPLIER)
      start()
    },
    { passive: false },
  )

  // Any scroll we didn't cause — keyboard, scrollbar drag, find-in-page — resyncs
  // the engine so it never fights the user or snaps back. Movement during our own
  // animation is ignored (running), as is the rounding noise from the final frame.
  window.addEventListener(
    "scroll",
    () => {
      if (running) return
      if (Math.abs(window.scrollY - current) < 2) return
      target = current = window.scrollY
    },
    { passive: true },
  )

  // In-page anchor links ease through the same engine.
  document.addEventListener("click", (e) => {
    if (locked) return
    const link = (e.target as Element)?.closest?.<HTMLAnchorElement>(
      'a[href^="#"]',
    )
    if (!link) return

    const hash = link.getAttribute("href")
    if (!hash || hash === "#") return

    const el = document.querySelector(hash)
    if (!el) return

    e.preventDefault()
    crossingEnabled = false
    mode = "normal"
    entryLead = 0
    target = clamp(window.scrollY + el.getBoundingClientRect().top)
    start()
    history.pushState(null, "", hash)
  })

  // Content reflow (fonts, images, viewport resize) can move the lower bound.
  window.addEventListener("resize", () => {
    target = clamp(target)
  })
} else {
  // No eased engine under reduced motion — still expose the API so consumers can
  // navigate; here it's an instant (accessible) jump, and barriers are a no-op.
  ;(window as any).__smoothScrollTo = (y: number) =>
    window.scrollTo(0, Math.max(0, y))
  ;(window as any).__setScrollBarriers = () => {}
  ;(window as any).__scrollProgressLead = () => 0
  // Native scrolling here; the locker's overflow:hidden is the whole lock.
  ;(window as any).__smoothScrollLock = () => {}
}
