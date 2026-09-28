/* ── Holding the page still, scrollbar and all ──
   A scroll lock that leaves the scrollbar where it is. Everything that would
   move the page is refused at the source instead: the wheel (unless it's
   over something inside `within` that can still take it, which then keeps
   it, rather than handing the rest on to the page when it runs out), and
   the keyboard's scrolling keys (on the same terms). Whatever gets past both
   (a drag on the scrollbar itself, middle-click autoscroll) is put straight
   back. Returns the release. */

const KEYS: Record<string, [dx: number, dy: number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  PageUp: [0, -1],
  PageDown: [0, 1],
  Home: [0, -1],
  End: [0, 1],
  " ": [0, 1],
}

/** Whether anything from `from` up to (and not including) `root` can scroll
    further in the direction given. */
function canScroll(from: Element | null, root: Element, dx: number, dy: number) {
  const horizontal = Math.abs(dx) > Math.abs(dy)
  for (let n = from; n && n !== root; n = n.parentElement) {
    if (!(n instanceof HTMLElement)) continue
    const cs = getComputedStyle(n)
    if (horizontal) {
      if (n.scrollWidth <= n.clientWidth + 1 || !/auto|scroll/.test(cs.overflowX)) continue
      if (dx > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0) return true
    } else {
      if (n.scrollHeight <= n.clientHeight + 1 || !/auto|scroll/.test(cs.overflowY)) continue
      if (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0) return true
    }
  }
  return false
}

export function holdScroll(within: Element) {
  const x = window.scrollX
  const y = window.scrollY

  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return // pinch zoom
    const t = e.target as Element
    if (within.contains(t) && canScroll(t, within, e.deltaX, e.deltaY)) return
    e.preventDefault()
  }

  const onKey = (e: KeyboardEvent) => {
    const dir = KEYS[e.key]
    if (!dir || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target as Element
    if (t.closest?.("input, textarea, select, [contenteditable]")) return
    // Space on a button presses it; it only scrolls from anywhere else
    if (e.key === " " && t.closest?.("button, a, summary, [role=button]")) return
    if (within.contains(t) && canScroll(t, within, dir[0], dir[1])) return
    e.preventDefault()
  }

  const onScroll = () => {
    if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y)
  }

  window.addEventListener("wheel", onWheel, { passive: false, capture: true })
  window.addEventListener("keydown", onKey)
  window.addEventListener("scroll", onScroll, { passive: true })
  return () => {
    window.removeEventListener("wheel", onWheel, { capture: true })
    window.removeEventListener("keydown", onKey)
    window.removeEventListener("scroll", onScroll)
  }
}
