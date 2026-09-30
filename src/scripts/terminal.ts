/* ── Terminal typing engine ──
   Shared by the hero Header and the footer cap-bar echo. Drives the
   `>_ sudo ./casino.sh` prompt that opens the /dev/null casino: blinking
   cursor, character-by-character typing, and reverse deletion. The consumers own their own
   trigger wiring (hover, viewport, scroll); this module only owns the
   text/cursor animation state. */

export const TYPE_STRING = "sudo ./casino.sh"

export const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches

export interface TState {
  textEl: HTMLElement
  cursorEl: HTMLElement
  visTimer: number | null
  animCancel: { value: boolean } | null
  isInView: boolean
  isHovering: boolean
}

export function makeState(el: HTMLElement): TState {
  return {
    textEl: el.querySelector("[data-terminal-text]") as HTMLElement,
    cursorEl: el.querySelector("[data-terminal-cursor]") as HTMLElement,
    visTimer: null,
    animCancel: null,
    isInView: false,
    isHovering: false,
  }
}

/* The blink itself is CSS ([data-blink] in global.css); these only switch it.
   Starting always restarts it from its visible half, as a fresh timer did. */
export function startBlink(s: TState) {
  if (prefersReducedMotion) return
  const el = s.cursorEl
  el.setAttribute("data-blink", "")
  for (const a of el.getAnimations()) a.currentTime = 0
}

export function stopBlink(s: TState) {
  s.cursorEl.removeAttribute("data-blink")
}

export function cancelAnim(s: TState) {
  if (s.animCancel) {
    s.animCancel.value = true
    s.animCancel = null
  }
}

/** Types on from whatever is already there up to `full`: the prompt and its
    command by default, or any other line a consumer holds (the casino peek
    types the drawer's own title). */
export function typeText(
  s: TState,
  full = ">" + TYPE_STRING,
): Promise<boolean> {
  if (prefersReducedMotion) {
    s.textEl.textContent = full
    return Promise.resolve(true)
  }
  cancelAnim(s)
  const cancel = { value: false }
  s.animCancel = cancel
  startBlink(s)

  let i = s.textEl.textContent!.length

  return new Promise((resolve) => {
    function step() {
      if (cancel.value) {
        resolve(false)
        return
      }
      if (i >= full.length) {
        s.animCancel = null
        resolve(true)
        return
      }
      s.textEl.textContent = full.slice(0, i + 1)
      i++
      setTimeout(step, Math.floor(Math.random() * 46) + 15)
    }
    step()
  })
}

export function deleteText(s: TState): Promise<boolean> {
  if (prefersReducedMotion) {
    s.textEl.textContent = ">"
    return Promise.resolve(true)
  }
  cancelAnim(s)
  const cancel = { value: false }
  s.animCancel = cancel

  return new Promise((resolve) => {
    function step() {
      if (cancel.value) {
        resolve(false)
        return
      }
      const text = s.textEl.textContent!
      if (text.length <= 1) {
        s.animCancel = null
        resolve(true)
        return
      }
      s.textEl.textContent = text.slice(0, -1)
      setTimeout(step, 13)
    }
    step()
  })
}
