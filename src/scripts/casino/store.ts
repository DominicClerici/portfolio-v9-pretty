/* ── Wallet & preferences ──
   Everything the casino remembers lives under one localStorage key. Money is
   integer cents. Other tabs are kept in step through the storage event, so a
   second window never shows a stale balance. Storage can be missing (private
   windows, blocked site data), in which case the wallet simply lives for the
   visit. */

export const START_CENTS = 100_000
const KEY = "casino:v1"

interface Saved {
  bal: number
  name: string | null
  sound: boolean
  /** Per-game control values (last bet, risk, rows…). */
  prefs: Record<string, unknown>
  /** Lifetime best balance, for bragging. */
  peak: number
  resets: number
}

const fresh = (): Saved => ({
  bal: START_CENTS,
  name: null,
  sound: false,
  prefs: {},
  peak: START_CENTS,
  resets: 0,
})

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return fresh()
    const s = { ...fresh(), ...JSON.parse(raw) } as Saved
    if (!Number.isInteger(s.bal) || s.bal < 0) s.bal = START_CENTS
    return s
  } catch {
    return fresh()
  }
}

let state = load()
type Listener = (bal: number, delta: number) => void
const listeners = new Set<Listener>()

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* the visit keeps it */
  }
}

try {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return
    const before = state.bal
    state = load()
    if (state.bal !== before) listeners.forEach((l) => l(state.bal, state.bal - before))
  })
} catch {
  /* no storage events, no sync */
}

export const wallet = {
  get balance() {
    return state.bal
  },
  get peak() {
    return state.peak
  },
  /** How many times the wallet has been refilled. */
  get resets() {
    return state.resets
  },
  canAfford(cents: number) {
    return cents > 0 && cents <= state.bal
  },
  /** Take a stake. False (and nothing taken) if it can't be covered. */
  debit(cents: number): boolean {
    if (!this.canAfford(cents)) return false
    this.adjust(-cents)
    return true
  },
  credit(cents: number) {
    if (cents > 0) this.adjust(cents)
  },
  adjust(delta: number) {
    if (!delta) return
    state.bal = Math.max(0, state.bal + delta)
    if (state.bal > state.peak) state.peak = state.bal
    persist()
    listeners.forEach((l) => l(state.bal, delta))
  },
  reset() {
    state.resets++
    this.adjust(START_CENTS - state.bal)
  },
  onChange(l: Listener) {
    listeners.add(l)
    return () => listeners.delete(l)
  },
}

export const prefs = {
  get name() {
    return state.name
  },
  set name(v: string | null) {
    state.name = v
    persist()
  },
  get sound() {
    return state.sound
  },
  set sound(v: boolean) {
    state.sound = v
    persist()
  },
  get<T>(key: string, fallback: T): T {
    return (state.prefs[key] as T) ?? fallback
  },
  set(key: string, v: unknown) {
    state.prefs[key] = v
    persist()
  },
}
