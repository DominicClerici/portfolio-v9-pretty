/* ── Small UI kit ──
   A DOM builder and the handful of controls every game shares: the bet
   field, segmented pickers, money and multiplier formatting, count-ups and
   toasts. No framework; each game owns its elements and updates them. */

import { sfx } from "./sfx"
import { prefs, wallet } from "./store"

type Child = Node | string | number | null | undefined | false
type Props = Record<string, unknown> | null

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue
      if (k === "class") el.className = v as string
      else if (k === "text") el.textContent = String(v)
      else if (k === "html") el.innerHTML = v as string
      else if (k.startsWith("on") && typeof v === "function")
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
      else el.setAttribute(k, v === true ? "" : String(v))
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue
    el.append(c instanceof Node ? c : String(c))
  }
  return el
}

const SVG_NS = "http://www.w3.org/2000/svg"
export function svg(markup: string, size = 16, viewBox = "0 0 16 16") {
  const el = document.createElementNS(SVG_NS, "svg")
  el.setAttribute("width", String(size))
  el.setAttribute("height", String(size))
  el.setAttribute("viewBox", viewBox)
  el.setAttribute("aria-hidden", "true")
  el.innerHTML = markup
  return el
}

/* XP-style icons, drawn on a 16px grid. Gradients carry fixed ids: every copy
   of an icon defines the same one, so whichever the page finds first serves. */
export const icons = {
  app: `<defs><linearGradient id="czi-die" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#cfcfcf"/></linearGradient></defs><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="url(#czi-die)" stroke="#5d5d5d" stroke-width=".9"/><g fill="#c1121f"><circle cx="5" cy="5" r="1.35"/><circle cx="11" cy="5" r="1.35"/><circle cx="8" cy="8" r="1.35"/><circle cx="5" cy="11" r="1.35"/><circle cx="11" cy="11" r="1.35"/></g>`,
  back: `<defs><radialGradient id="czi-go" cx="35%" cy="28%" r="80%"><stop offset="0" stop-color="#c4f5ae"/><stop offset=".5" stop-color="#3fae2a"/><stop offset="1" stop-color="#17700e"/></radialGradient></defs><circle cx="8" cy="8" r="7.3" fill="url(#czi-go)" stroke="#16640d" stroke-width=".8"/><path d="M9.3 4.4 5.7 8l3.6 3.6M6 8h5.8" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`,
  folder: `<path d="M1.5 4v8.8c0 .6.4 1 1 1h11c.6 0 1-.4 1-1V5.6c0-.6-.4-1-1-1H7.4L6 3H2.5c-.6 0-1 .4-1 1z" fill="#f7d774" stroke="#c49a2c" stroke-width=".8"/><path d="M1.5 6.3h13" stroke="#dfb343" stroke-width=".8"/>`,
  drop: `<path d="M4.5 6.5h7L8 10z" fill="#4d6185"/>`,
  net: `<rect x="1" y="1.5" width="8.5" height="6.5" rx=".8" fill="#e3ebf8" stroke="#35599f" stroke-width=".8"/><rect class="czi-screen" x="2.3" y="2.8" width="5.9" height="3.9" fill="#3a78d8"/><rect x="6" y="7" width="8.5" height="6.5" rx=".8" fill="#e3ebf8" stroke="#35599f" stroke-width=".8"/><rect class="czi-screen" x="7.3" y="8.3" width="5.9" height="3.9" fill="#3a78d8"/><path d="M3.5 8.4v2.1H5.6M10.2 13.6V15" stroke="#35599f" stroke-width=".8" fill="none"/>`,
  soundOn: `<path d="M1.8 6h2.6L8 3v10L4.4 10H1.8z" fill="#d3dbe8" stroke="#4d5c78" stroke-width=".8" stroke-linejoin="round"/><path d="M10.4 5.6a3.4 3.4 0 0 1 0 4.8M12.2 3.9a5.8 5.8 0 0 1 0 8.2" fill="none" stroke="#4d5c78" stroke-width="1.1" stroke-linecap="round"/>`,
  soundOff: `<path d="M1.8 6h2.6L8 3v10L4.4 10H1.8z" fill="#d3dbe8" stroke="#4d5c78" stroke-width=".8" stroke-linejoin="round"/><circle cx="11.6" cy="10.6" r="3.4" fill="#fff" stroke="#d4120c" stroke-width="1.3"/><path d="M9.2 13 14 8.2" stroke="#d4120c" stroke-width="1.3"/>`,
  user: `<circle cx="8" cy="5.2" r="3" fill="#f4c89c" stroke="#a36f3c" stroke-width=".7"/><path d="M2.5 14.6c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5z" fill="#3d80da" stroke="#1d4d9b" stroke-width=".7"/>`,
  error: `<defs><radialGradient id="czi-err" cx="35%" cy="28%" r="80%"><stop offset="0" stop-color="#ffa394"/><stop offset=".55" stop-color="#e0261b"/><stop offset="1" stop-color="#980d07"/></radialGradient></defs><circle cx="8" cy="8" r="7.2" fill="url(#czi-err)" stroke="#830b06" stroke-width=".6"/><path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/>`,
  info: `<defs><radialGradient id="czi-info" cx="35%" cy="28%" r="80%"><stop offset="0" stop-color="#c3dbff"/><stop offset=".55" stop-color="#2f6fe0"/><stop offset="1" stop-color="#173f9e"/></radialGradient></defs><circle cx="8" cy="8" r="7.2" fill="url(#czi-info)" stroke="#173f9e" stroke-width=".6"/><circle cx="8" cy="4.6" r="1.15" fill="#fff"/><path d="M8 7.2v4.9" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`,
  ok: `<defs><radialGradient id="czi-ok" cx="35%" cy="28%" r="80%"><stop offset="0" stop-color="#c4f5ae"/><stop offset=".55" stop-color="#3fae2a"/><stop offset="1" stop-color="#17700e"/></radialGradient></defs><circle cx="8" cy="8" r="7.2" fill="url(#czi-ok)" stroke="#16640d" stroke-width=".6"/><path d="M4.6 8.3 7 10.6l4.4-5" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`,
  warn: `<defs><linearGradient id="czi-warn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffeb8a"/><stop offset="1" stop-color="#f2b705"/></linearGradient></defs><path d="M8 1.4 15 14.2H1z" fill="url(#czi-warn)" stroke="#9c7300" stroke-width=".7" stroke-linejoin="round"/><path d="M8 5.6v4.3" stroke="#1a1a1a" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="12" r=".95" fill="#1a1a1a"/>`,
  cmd: `<rect x="1" y="2" width="14" height="12" fill="#000" stroke="#6d6d6d" stroke-width=".8"/><rect x="1" y="2" width="14" height="2.6" fill="#2a63d6"/><path d="M3.2 7.3 5.2 9l-2 1.7M6.4 11.4h3.2" stroke="#c0c0c0" stroke-width="1" fill="none"/>`,
  chevron: `<path d="M5 7.2 8 4.2l3 3M5 11.2l3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  capMin: `<rect x="4" y="10.4" width="6.5" height="2.3" fill="#fff"/>`,
  capMax: `<path d="M3.6 3.6h8.8v8.8H3.6z" fill="none" stroke="#fff" stroke-width="1.2"/><path d="M3.6 3.6h8.8v2.1H3.6z" fill="#fff"/>`,
  capRestore: `<path d="M6 2.8h7.2V10H6z" fill="none" stroke="#fff" stroke-width="1.1"/><path d="M6 2.8h7.2v1.9H6z" fill="#fff"/><path d="M2.8 6h7.2v7.2H2.8z" fill="#2a63d6" stroke="#fff" stroke-width="1.1"/><path d="M2.8 6H10v1.9H2.8z" fill="#fff"/>`,
  capClose: `<path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" stroke="#fff" stroke-width="2" stroke-linecap="square"/>`,
}

/* ── Formatting ── */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
})

export const money = (cents: number) => usd.format(cents / 100)
/** Full precision up to $100k, compact past it so columns stay narrow. */
export const moneyShort = (cents: number) =>
  Math.abs(cents) >= 10_000_000 ? usdCompact.format(cents / 100) : money(cents)
export const signed = (cents: number) =>
  (cents > 0 ? "+" : cents < 0 ? "−" : "") + moneyShort(Math.abs(cents))
export const mult = (x100: number) =>
  (x100 >= 100_000 ? Math.round(x100 / 100).toLocaleString("en-US") : (x100 / 100).toFixed(2)) +
  "×"

/** Stake × multiplier, floored to the cent. */
export const payout = (cents: number, x100: number) => Math.floor((cents * x100) / 100)

/** Player colour, stable per name: dark enough to carry a white initial, and
    to read on the white and black stages alike. */
const DOTS = ["#2f6fe0", "#3a9a3a", "#e0781c", "#c9302c", "#8e44ad", "#0f8a8a"]
export function dotColor(name: string) {
  let hsh = 0
  for (let i = 0; i < name.length; i++) hsh = (hsh * 31 + name.charCodeAt(i)) | 0
  return DOTS[Math.abs(hsh) % DOTS.length]
}

export function avatar(name: string, extra = "") {
  return h("span", {
    class: `cz-avatar ${extra}`,
    style: `--dot:${dotColor(name)}`,
    title: name,
    text: name.replace(/[^A-Za-z0-9]/g, "").charAt(0).toUpperCase() || "?",
  })
}

export const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

/* ── Count-up ── */

const counters = new WeakMap<HTMLElement, number>()
export function countTo(
  el: HTMLElement,
  from: number,
  to: number,
  format: (n: number) => string,
  dur = 520,
) {
  cancelAnimationFrame(counters.get(el) ?? 0)
  if (reducedMotion.matches || from === to) {
    el.textContent = format(to)
    return
  }
  const t0 = performance.now()
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / dur)
    const e = 1 - (1 - t) ** 3
    el.textContent = format(Math.round(from + (to - from) * e))
    if (t < 1) counters.set(el, requestAnimationFrame(step))
  }
  counters.set(el, requestAnimationFrame(step))
}

/* ── Toasts ── */

let toastHost: HTMLElement | null = null
export function setToastHost(el: HTMLElement) {
  toastHost = el
}
/** A balloon tip, rising out of the status bar's tray. */
export function toast(text: string, kind: "info" | "win" | "loss" = "info") {
  if (!toastHost) return
  const icon = kind === "win" ? icons.ok : kind === "loss" ? icons.warn : icons.info
  const el = h("div", { class: `cz-toast is-${kind}`, role: "status" }, svg(icon, 16), h("span", { text }))
  toastHost.append(el)
  while (toastHost.childElementCount > 3) toastHost.firstElementChild?.remove()
  window.setTimeout(() => {
    el.classList.add("is-out")
    el.addEventListener("animationend", () => el.remove(), { once: true })
  }, 2600)
}

/* ── Bet field ──
   Dollar input with halve / double / max. The value is remembered per game,
   and the field flags itself when it asks for more than the wallet holds. */

export const MIN_BET = 10 // $0.10

export class BetInput {
  el: HTMLElement
  input: HTMLInputElement
  private listeners = new Set<() => void>()

  constructor(
    private key: string,
    label = "Bet",
  ) {
    const saved = prefs.get<number>(`${key}:bet`, 1000)
    this.input = h("input", {
      class: "cz-bet-input",
      type: "text",
      inputmode: "decimal",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": `${label} amount in dollars`,
      value: (saved / 100).toFixed(2),
    })
    const btn = (text: string, title: string, fn: () => void) =>
      h("button", {
        type: "button",
        class: "cz-btn cz-bet-btn",
        title,
        text,
        onclick: () => {
          fn()
          sfx.click()
        },
      })
    this.el = h(
      "div",
      { class: "cz-field" },
      h("label", { class: "cz-label", text: `${label}:` }),
      h(
        "div",
        { class: "cz-bet" },
        h("span", { class: "cz-textbox" }, h("span", { class: "cz-bet-prefix", text: "$" }), this.input),
        btn("½", "Halve", () => this.set(Math.max(MIN_BET, Math.floor(this.cents / 2)))),
        btn("×2", "Double", () => this.set(Math.min(wallet.balance, this.cents * 2))),
        btn("Max", "All in", () => this.set(wallet.balance)),
      ),
    )
    this.input.addEventListener("input", () => this.changed())
    this.input.addEventListener("blur", () => {
      if (Number.isFinite(this.cents)) this.set(this.cents)
    })
    wallet.onChange(() => this.validate())
    this.validate()
  }

  /** Parsed stake in cents; NaN when the field doesn't hold a number. */
  get cents() {
    const v = this.input.value.replace(/[$,\s]/g, "")
    if (!/^\d*\.?\d*$/.test(v) || v === "" || v === ".") return NaN
    return Math.round(parseFloat(v) * 100)
  }

  get valid() {
    const c = this.cents
    return Number.isFinite(c) && c >= MIN_BET && c <= wallet.balance
  }

  set(cents: number) {
    const c = Math.max(0, Math.floor(cents))
    this.input.value = (c / 100).toFixed(2)
    this.changed()
  }

  onChange(fn: () => void) {
    this.listeners.add(fn)
  }

  set disabled(v: boolean) {
    this.el.classList.toggle("is-disabled", v)
    this.el.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((e) => {
      e.disabled = v
    })
  }

  private changed() {
    if (Number.isFinite(this.cents)) prefs.set(`${this.key}:bet`, this.cents)
    this.validate()
    this.listeners.forEach((l) => l())
  }

  private validate() {
    const c = this.cents
    const over = Number.isFinite(c) && c > wallet.balance
    const bad = !Number.isFinite(c) || c < MIN_BET
    this.el.classList.toggle("is-invalid", over || (bad && this.input.value !== ""))
    this.el.title = over ? "More than you've got" : bad ? "Minimum bet is $0.10" : ""
  }
}

/* ── Segmented picker ── */

export function segmented<T extends string | number>(
  label: string,
  options: { value: T; label: string }[],
  value: T,
  onChange: (v: T) => void,
) {
  let current = value
  const buttons = options.map((o) =>
    h("button", {
      type: "button",
      class: "cz-seg-btn",
      role: "radio",
      "aria-checked": String(o.value === value),
      text: o.label,
      onclick: () => {
        if (current === o.value) return
        api.set(o.value)
        sfx.click()
        onChange(o.value)
      },
    }),
  )
  const el = h(
    "div",
    { class: "cz-field cz-seg-field" },
    h("span", { class: "cz-label", text: `${label}:` }),
    h("div", { class: "cz-seg", role: "radiogroup", "aria-label": label }, buttons),
  )
  const api = {
    el,
    get value() {
      return current
    },
    set(v: T) {
      current = v
      buttons.forEach((b, i) => b.setAttribute("aria-checked", String(options[i].value === v)))
    },
    set disabled(d: boolean) {
      buttons.forEach((b) => (b.disabled = d))
    },
  }
  return api
}

/** A big primary action button with a label and a secondary line. With
    `onPress`, a mouse or touch fires it on pointerdown; keyboard activation
    still comes through as a click. */
export function actionButton(onclick: () => void, onPress = false) {
  const main = h("span", { class: "cz-action-main" })
  const sub = h("span", { class: "cz-action-sub" })
  const el = h("button", { type: "button", class: "cz-action" }, main, sub)
  let pressedAt = -Infinity
  if (onPress)
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || el.disabled) return
      pressedAt = performance.now()
      onclick()
    })
  el.addEventListener("click", (e) => {
    // The click that follows a handled press (keyboard clicks have no detail)
    if (e.detail !== 0 && performance.now() - pressedAt < 1000) return
    onclick()
  })
  return {
    el,
    set(text: string, detail = "", tone: "go" | "cash" | "idle" | "wait" = "go") {
      main.textContent = text
      sub.textContent = detail
      sub.hidden = !detail
      el.dataset.tone = tone
    },
    set disabled(d: boolean) {
      el.disabled = d
    },
  }
}

/** Random float in [0,1) from the platform CSPRNG. */
export function rand() {
  const b = new Uint32Array(1)
  crypto.getRandomValues(b)
  return b[0] / 2 ** 32
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
