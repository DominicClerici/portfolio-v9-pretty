/* ── Terminal typing engine ──
   Shared by the hero Header and the footer cap-bar echo. Drives the
   `>_ ssh dev.dominicclerici.com` prompt: blinking cursor, character-by-
   character typing, and reverse deletion. The consumers own their own
   trigger wiring (hover, viewport, scroll); this module only owns the
   text/cursor animation state. */

export const TYPE_STRING = "ssh dev.dominicclerici.com"

export const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches

export interface TState {
  textEl: HTMLElement
  cursorEl: HTMLElement
  blinkInterval: number | null
  visTimer: number | null
  animCancel: { value: boolean } | null
  isInView: boolean
  isHovering: boolean
}

export function makeState(el: HTMLElement): TState {
  return {
    textEl: el.querySelector("[data-terminal-text]") as HTMLElement,
    cursorEl: el.querySelector("[data-terminal-cursor]") as HTMLElement,
    blinkInterval: null,
    visTimer: null,
    animCancel: null,
    isInView: false,
    isHovering: false,
  }
}

export function startBlink(s: TState) {
  if (prefersReducedMotion) return
  stopBlink(s)
  s.cursorEl.style.visibility = "visible"
  s.blinkInterval = window.setInterval(() => {
    s.cursorEl.style.visibility =
      s.cursorEl.style.visibility === "hidden" ? "visible" : "hidden"
  }, 530)
}

export function stopBlink(s: TState) {
  if (s.blinkInterval !== null) {
    clearInterval(s.blinkInterval)
    s.blinkInterval = null
  }
  s.cursorEl.style.visibility = "visible"
}

export function cancelAnim(s: TState) {
  if (s.animCancel) {
    s.animCancel.value = true
    s.animCancel = null
  }
}

export function typeText(s: TState): Promise<boolean> {
  if (prefersReducedMotion) {
    s.textEl.textContent = ">" + TYPE_STRING
    return Promise.resolve(true)
  }
  cancelAnim(s)
  const cancel = { value: false }
  s.animCancel = cancel
  startBlink(s)

  const full = ">" + TYPE_STRING
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
