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
export function svg(markup: string, size = 16, viewBox = "0 0 24 24") {
  const el = document.createElementNS(SVG_NS, "svg")
  el.setAttribute("width", String(size))
  el.setAttribute("height", String(size))
  el.setAttribute("viewBox", viewBox)
  el.setAttribute("aria-hidden", "true")
  el.innerHTML = markup
  return el
}

export const icons = {
  close: `<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
  soundOn: `<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
  soundOff: `<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
  branch: `<circle cx="6" cy="5.5" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="6" cy="18.5" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 7.5v9M18 10c0 4-6 3.5-11 7" fill="none" stroke="currentColor" stroke-width="1.6"/>`,
  back: `<path d="M14.5 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  reroll: `<path d="M19 12a7 7 0 1 1-2.05-4.95M19 5v4h-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
  user: `<circle cx="12" cy="8.5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 19.5c1.2-3.3 3.8-5 7-5s5.8 1.7 7 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
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

/** Player dot colour, stable per name. */
const DOTS = ["#cef79e", "#f7f7f5", "#ff8a7a", "#9ecff7", "#f7d59e", "#d3a8f5"]
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
export function toast(text: string, kind: "info" | "win" | "loss" = "info") {
  if (!toastHost) return
  const el = h("div", { class: `cz-toast is-${kind}`, role: "status", text })
  toastHost.append(el)
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
        class: "cz-bet-btn",
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
      h("label", { class: "cz-label", text: label }),
      h(
        "div",
        { class: "cz-bet" },
        h("span", { class: "cz-bet-prefix", text: "$" }),
        this.input,
        btn("/2", "Halve", () => this.set(Math.max(MIN_BET, Math.floor(this.cents / 2)))),
        btn("×2", "Double", () => this.set(Math.min(wallet.balance, this.cents * 2))),
        btn("max", "All in", () => this.set(wallet.balance)),
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
    h("span", { class: "cz-label", text: label }),
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

/** A big primary action button with a label and a secondary line. */
export function actionButton(onclick: () => void) {
  const main = h("span", { class: "cz-action-main" })
  const sub = h("span", { class: "cz-action-sub" })
  const el = h("button", { type: "button", class: "cz-action", onclick }, main, sub)
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
