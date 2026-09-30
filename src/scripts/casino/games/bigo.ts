/* ── Big O ──
   Hi-lo, where the deck is thirteen complexity classes, O(1) up to the busy
   beaver. Call whether the next card grows slower or faster (ties count for
   you), the multiplier compounds with every right call, and one wrong call
   takes the lot. Cards are drawn with replacement, so the odds only ever
   depend on the card showing, and each call pays 0.99 ÷ its chance.

   Other players at the table show in a rail: their card, their streak, and
   whether they're still alive. */

import type { BigOPlay, ServerMsg } from "../../../../multiplayer/src/protocol"
import type { Game } from "../game"
import { net } from "../net"
import { sfx } from "../sfx"
import { prefs, wallet } from "../store"
import {
  BetInput,
  actionButton,
  avatar,
  h,
  money,
  moneyShort,
  mult,
  payout,
  rand,
  reducedMotion,
  signed,
  toast,
} from "../ui"

interface Rank {
  html: string
  text: string
  nick: string
  f: (n: number) => number
}

const logStar = (n: number) => {
  let k = 0
  while (n > 1) {
    n = Math.log2(n)
    k++
  }
  return k
}
// Stirling's approximation, so the n! curve is smooth between integers
const fact = (n: number) => Math.sqrt(2 * Math.PI * n) * (n / Math.E) ** n

export const RANKS: Rank[] = [
  { html: "O(1)", text: "O(1)", nick: "hash lookup", f: () => 1 },
  { html: "O(log<sup>*</sup>n)", text: "O(log* n)", nick: "union-find", f: (n) => logStar(n) },
  { html: "O(log log n)", text: "O(log log n)", nick: "van Emde Boas", f: (n) => Math.log2(Math.max(1, Math.log2(n))) + 1 },
  { html: "O(log n)", text: "O(log n)", nick: "binary search", f: (n) => Math.log2(n) + 1 },
  { html: "O(n<sup>1/2</sup>)", text: "O(√n)", nick: "trial division", f: (n) => Math.sqrt(n) },
  { html: "O(n)", text: "O(n)", nick: "linear scan", f: (n) => n },
  { html: "O(n log n)", text: "O(n log n)", nick: "merge sort", f: (n) => n * Math.log2(n) },
  { html: "O(n²)", text: "O(n²)", nick: "bubble sort", f: (n) => n * n },
  { html: "O(n³)", text: "O(n³)", nick: "naive matmul", f: (n) => n ** 3 },
  { html: "O(2<sup>n</sup>)", text: "O(2^n)", nick: "subset sum", f: (n) => 2 ** n },
  { html: "O(n!)", text: "O(n!)", nick: "travelling salesman", f: (n) => fact(n) },
  { html: "O(n<sup>n</sup>)", text: "O(n^n)", nick: "brute force", f: (n) => n ** n },
  { html: "O(BB(n))", text: "O(BB(n))", nick: "busy beaver", f: (n) => (n < 1.6 ? 1 : 1e9) },
]
const SUITS = ["{}", "[]", "()", "<>"]
const LOSS = ["Wrong Answer", "Time Limit Exceeded", "Runtime Error", "Memory Limit Exceeded"]

type Kind = "hi" | "lo" | "hiS" | "loS" | "eq"
interface Option {
  kind: Kind
  label: string
  sub: string
  p: number
}

function options(r: number): [Option, Option] {
  const n = RANKS.length
  if (r === 0)
    return [
      { kind: "hiS", label: "Higher", sub: "strictly", p: (n - 1) / n },
      { kind: "eq", label: "Same", sub: "exactly", p: 1 / n },
    ]
  if (r === n - 1)
    return [
      { kind: "eq", label: "Same", sub: "exactly", p: 1 / n },
      { kind: "loS", label: "Lower", sub: "strictly", p: (n - 1) / n },
    ]
  return [
    { kind: "hi", label: "Higher", sub: "or same", p: (n - r) / n },
    { kind: "lo", label: "Lower", sub: "or same", p: (r + 1) / n },
  ]
}

const wins = (kind: Kind, from: number, to: number) =>
  kind === "hi" ? to >= from : kind === "lo" ? to <= from : kind === "hiS" ? to > from : kind === "loS" ? to < from : to === from

interface Card {
  rank: number
  suit: number
  guess?: Kind
  ok?: boolean
}

interface Hand {
  bet: number
  cards: Card[]
  /** Running multiplier (float; floored only when paid). */
  m: number
  n: number
  state: "live" | "bust" | "cashed"
}

const x100 = (m: number) => Math.floor(m * 100 + 1e-9)

/** Growth curve for a card face: shared axes, square-root scaled so the slow
    classes are still visibly different from each other. */
function sparkline(rank: number) {
  const f = RANKS[rank].f
  const pts: string[] = []
  const N = 40
  for (let i = 0; i <= N; i++) {
    const n = 1 + (15 * i) / N
    const y = Math.min(1, Math.sqrt(Math.max(0, f(n)) / 32))
    pts.push(`${(i / N) * 100},${(58 - y * 54).toFixed(2)}`)
    if (y >= 1) break
  }
  return `<svg class="cz-spark" viewBox="0 0 100 60" preserveAspectRatio="none"><path class="cz-spark-axis" d="M0 58H100M0 4V58"/><polyline points="${pts.join(" ")}"/></svg>`
}

function tier(rank: number) {
  // green (fast) → amber → red (slow): inks that read on a white card face
  const t = rank / (RANKS.length - 1)
  const stops = [
    [0, 122, 20],
    [196, 120, 0],
    [204, 0, 0],
  ]
  const [a, b, k] = t < 0.5 ? [stops[0], stops[1], t * 2] : [stops[1], stops[2], (t - 0.5) * 2]
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * k))
  return `rgb(${c.join(",")})`
}

function cardEl(card: Card, faceDown = false) {
  const r = RANKS[card.rank]
  return h(
    "div",
    { class: `cz-pcard${faceDown ? " is-down" : ""}`, style: `--tier:${tier(card.rank)}` },
    h(
      "div",
      { class: "cz-pcard-inner" },
      h(
        "div",
        { class: "cz-pcard-face cz-pcard-front" },
        h("span", { class: "cz-pcard-corner is-tl", html: r.html }),
        h("span", { class: "cz-pcard-art", html: sparkline(card.rank) }),
        h("span", { class: "cz-pcard-big", html: r.html }),
        h("span", { class: "cz-pcard-nick", text: r.nick }),
        h("span", { class: "cz-pcard-corner is-br", html: r.html }),
      ),
      h("div", { class: "cz-pcard-face cz-pcard-back" }, h("span", { text: "O( )" })),
    ),
  )
}

const draw = (): Card => ({
  rank: Math.floor(rand() * RANKS.length),
  suit: Math.floor(rand() * SUITS.length),
})

interface Seat {
  name: string
  play: BigOPlay
  at: number
}

export class BigOGame implements Game {
  readonly id = "bigo" as const
  readonly stage: HTMLElement
  readonly panel: HTMLElement

  private slot: HTMLElement
  private deck: HTMLElement
  private trail: HTMLElement
  private verdict: HTMLElement
  private multEl: HTMLElement
  private profitEl: HTMLElement
  private bet: BetInput
  private optA: HTMLButtonElement
  private optB: HTMLButtonElement
  private skipBtn: HTMLButtonElement
  private spaceHint: HTMLElement
  private action: ReturnType<typeof actionButton>
  private rail: HTMLElement
  private railList: HTMLElement
  private hand: Hand | null = prefs.get<Hand | null>("bigo:hand", null)
  private animating = false
  private seats = new Map<string, Seat>()

  constructor() {
    this.slot = h("div", { class: "cz-bigo-slot" })
    this.deck = h(
      "div",
      { class: "cz-bigo-deck", "aria-hidden": "true" },
      h("span", { class: "cz-bigo-deckcard" }),
      h("span", { class: "cz-bigo-deckcard" }),
      h("span", { class: "cz-bigo-deckcard" }, h("span", { text: "O( )" })),
    )
    this.verdict = h("div", { class: "cz-verdict", "aria-live": "polite" })
    this.trail = h("div", { class: "cz-bigo-trail", "aria-label": "Cards this hand" })
    this.multEl = h("strong", { text: "1.00×" })
    this.profitEl = h("strong", { text: "$0.00" })

    this.stage = h(
      "div",
      { class: "cz-stage cz-bigo-stage" },
      h(
        "div",
        { class: "cz-bigo-scale", "aria-hidden": "true" },
        ...RANKS.map((r, i) => h("span", { style: `--tier:${tier(i)}`, "data-rank": String(i), html: r.html })),
      ),
      h("div", { class: "cz-bigo-table" }, this.deck, h("div", { class: "cz-bigo-slotwrap" }, this.slot, this.verdict)),
      h(
        "div",
        { class: "cz-bigo-readout" },
        h("span", { class: "cz-readout" }, h("span", { class: "cz-label", text: "Multiplier" }), this.multEl),
        h("span", { class: "cz-readout" }, h("span", { class: "cz-label", text: "Profit" }), this.profitEl),
      ),
      this.trail,
    )

    this.bet = new BetInput("bigo")
    const opt = (i: 0 | 1) =>
      h("button", { type: "button", class: `cz-guess ${i ? "is-lo" : "is-hi"}`, onclick: () => this.guess(i) })
    this.optA = opt(0)
    this.optB = opt(1)
    this.spaceHint = h("span", { text: "deal" })
    this.skipBtn = h("button", { type: "button", class: "cz-ghost-btn", text: "Skip", title: "Swap this card for a fresh one (S)", onclick: () => this.skip() })
    this.action = actionButton(() => (this.hand?.state === "live" ? this.cashOut() : this.deal()))
    this.bet.onChange(() => this.renderControls())
    wallet.onChange(() => this.renderControls())

    this.railList = h("ul", { class: "cz-bigo-seats" })
    this.rail = h(
      "section",
      { class: "cz-rail", hidden: true },
      h("header", { class: "cz-rail-head" }, h("span", { class: "cz-live-dot" }), h("span", { text: "Other tables" })),
      this.railList,
    )

    this.panel = h(
      "aside",
      { class: "cz-panel" },
      h(
        "div",
        { class: "cz-controls" },
        this.bet.el,
        h("div", { class: "cz-guesses" }, this.optA, this.optB),
        h("div", { class: "cz-action-row" }, this.skipBtn, this.action.el),
        h(
          "p",
          { class: "cz-hint" },
          h("kbd", { text: "↑" }), " ", h("kbd", { text: "↓" }), " call · ",
          h("kbd", { text: "S" }), " skip · ",
          h("kbd", { text: "Space" }), " ", this.spaceHint,
        ),
      ),
      this.rail,
    )

    net.on((msg) => this.onNet(msg))
    this.restore()
  }

  enter() {
    this.renderSeats()
  }

  leave() {}

  key(e: KeyboardEvent) {
    const k = e.key.toLowerCase()
    if (k === "arrowup") return this.guess(0), true
    if (k === "arrowdown") return this.guess(1), true
    if (k === "s") return this.skip(), true
    if (k === " " || k === "enter") {
      if ((e.target as HTMLElement).closest("button")) return false
      this.hand?.state === "live" ? this.cashOut() : this.deal()
      return true
    }
    return false
  }

  /* ── Play ── */

  private current() {
    const c = this.hand?.cards
    return c ? c[c.length - 1] : null
  }

  private save() {
    prefs.set("bigo:hand", this.hand?.state === "live" ? this.hand : null)
  }

  private deal() {
    if (this.animating) return
    if (!this.bet.valid) {
      toast(wallet.balance < this.bet.cents ? "Not enough balance for that bet." : "Enter a bet of at least $0.10.")
      return
    }
    const bet = this.bet.cents
    if (!wallet.debit(bet)) return
    this.hand = { bet, cards: [draw()], m: 1, n: 0, state: "live" }
    this.trail.replaceChildren()
    this.setVerdict("")
    this.save()
    sfx.bet()
    this.place(this.current()!, true)
    this.broadcast("deal")
    this.renderAll()
  }

  private async guess(i: 0 | 1) {
    const hand = this.hand
    if (!hand || hand.state !== "live" || this.animating) return
    const cur = this.current()!
    const opt = options(cur.rank)[i]
    const next = draw()
    cur.guess = opt.kind
    const ok = wins(opt.kind, cur.rank, next.rank)
    cur.ok = ok
    hand.cards.push(next)
    this.pushTrail(cur)
    await this.place(next, false)
    if (ok) {
      hand.m *= 0.99 / opt.p
      hand.n++
      this.setVerdict("Accepted", "ok")
      sfx.win(hand.n >= 5)
      this.broadcast("win")
    } else {
      hand.state = "bust"
      this.setVerdict(LOSS[Math.floor(rand() * LOSS.length)], "bad")
      sfx.lose()
      this.broadcast("bust")
      toast(`${money(hand.bet)} lost after ${hand.n} ${hand.n === 1 ? "call" : "calls"}.`, "loss")
      if (!reducedMotion.matches) {
        this.slot.classList.remove("is-shake")
        void this.slot.offsetWidth
        this.slot.classList.add("is-shake")
      }
    }
    this.save()
    this.renderAll()
  }

  private async skip() {
    const hand = this.hand
    if (!hand || hand.state !== "live" || this.animating) return
    const cur = this.current()!
    const next = draw()
    hand.cards.push(next)
    this.pushTrail(cur, true)
    this.setVerdict("")
    await this.place(next, false)
    this.save()
    this.broadcast("deal")
    this.renderAll()
  }

  private cashOut() {
    const hand = this.hand
    if (!hand || hand.state !== "live" || hand.n === 0 || this.animating) return
    hand.state = "cashed"
    const win = payout(hand.bet, x100(hand.m))
    wallet.credit(win)
    this.setVerdict("Submitted", "ok")
    sfx.cashout()
    toast(`Cashed out at ${mult(x100(hand.m))}: ${signed(win - hand.bet)}`, "win")
    this.broadcast("cash")
    this.save()
    this.renderAll()
  }

  /** Deal a card from the deck into the slot: slide, flip, settle. */
  private place(card: Card, first: boolean): Promise<void> {
    const el = cardEl(card, true)
    const old = this.slot.firstElementChild as HTMLElement | null
    this.slot.append(el)
    sfx.flip()
    if (reducedMotion.matches) {
      old?.remove()
      el.classList.remove("is-down")
      return Promise.resolve()
    }
    this.animating = true
    const from = this.deck.getBoundingClientRect()
    const to = this.slot.getBoundingClientRect()
    const dx = from.left + from.width / 2 - (to.left + to.width / 2)
    const dy = from.top + from.height / 2 - (to.top + to.height / 2)
    const s = from.width / to.width
    if (old) {
      old.animate(
        [
          { transform: "none", opacity: 1 },
          { transform: "translate(0, 40px) scale(0.6) rotate(-6deg)", opacity: 0 },
        ],
        { duration: 320, easing: "cubic-bezier(.4,0,.8,.4)", fill: "forwards" },
      ).onfinish = () => old.remove()
    }
    const slide = el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(-8deg)` },
        { transform: "translate(0,0) scale(1.04) rotate(1deg)", offset: 0.75 },
        { transform: "none" },
      ],
      { duration: first ? 520 : 460, easing: "cubic-bezier(.22,1,.36,1)" },
    )
    window.setTimeout(() => el.classList.remove("is-down"), first ? 170 : 140)
    return new Promise((res) => {
      slide.onfinish = () => {
        this.animating = false
        res()
      }
    })
  }

  private pushTrail(card: Card, skipped = false) {
    const r = RANKS[card.rank]
    const mark = skipped ? "skip" : card.guess === "hi" || card.guess === "hiS" ? "↑" : card.guess === "eq" ? "=" : "↓"
    const chip = h(
      "span",
      { class: `cz-trail-chip${skipped ? " is-skip" : card.ok ? " is-ok" : " is-bad"}`, style: `--tier:${tier(card.rank)}` },
      h("span", { class: "cz-trail-rank", html: r.html }),
      h("span", { class: "cz-trail-mark", text: mark }),
    )
    this.trail.append(chip)
    this.trail.scrollTo({ left: this.trail.scrollWidth, behavior: reducedMotion.matches ? "auto" : "smooth" })
  }

  private setVerdict(text: string, tone: "ok" | "bad" = "ok") {
    const v = this.verdict
    v.textContent = text
    v.dataset.tone = tone
    v.classList.remove("is-in")
    if (!text) return
    void v.offsetWidth
    v.classList.add("is-in")
  }

  private restore() {
    const hand = this.hand
    if (hand?.state === "live" && hand.cards.length) {
      const c = cardEl(this.current()!)
      this.slot.append(c)
      hand.cards.slice(0, -1).forEach((card) => this.pushTrail(card, card.guess == null))
    } else {
      this.hand = null
      this.slot.append(cardEl({ rank: 5, suit: 0 }, true))
    }
    this.renderAll()
  }

  /* ── Rendering ── */

  private renderAll() {
    const hand = this.hand
    const m = hand ? hand.m : 1
    this.multEl.textContent = mult(x100(m))
    const profit = hand ? (hand.state === "bust" ? -hand.bet : payout(hand.bet, x100(m)) - hand.bet) : 0
    this.profitEl.textContent = signed(profit) || "$0.00"
    this.profitEl.dataset.tone = profit > 0 ? "up" : profit < 0 ? "down" : ""
    const cur = this.current()
    this.stage.querySelectorAll<HTMLElement>(".cz-bigo-scale span").forEach((s) => {
      s.classList.toggle("is-on", hand?.state === "live" && cur?.rank === Number(s.dataset.rank))
    })
    this.renderControls()
  }

  private renderControls() {
    const hand = this.hand
    const live = hand?.state === "live"
    const cur = this.current()
    this.bet.disabled = !!live
    const [a, b] = live && cur ? options(cur.rank) : options(5)
    const fill = (btn: HTMLButtonElement, o: Option, arrow: string) => {
      btn.replaceChildren(
        h(
          "span",
          { class: "cz-guess-top" },
          h("span", { class: "cz-guess-arrow", text: arrow }),
          h("span", { class: "cz-guess-label" }, h("span", { text: o.label }), h("span", { class: "cz-guess-or", text: o.sub })),
        ),
        h("span", { class: "cz-guess-sub" }, h("span", { text: `${(o.p * 100).toFixed(1)}%` }), h("strong", { text: mult(x100(0.99 / o.p)) })),
      )
      btn.disabled = !live
      btn.title = `${o.label} ${o.sub}: ${o.kind.startsWith("hi") ? "grows faster" : o.kind.startsWith("lo") ? "grows slower" : "the same class again"}`
    }
    fill(this.optA, a, a.kind === "eq" ? "=" : "↑")
    fill(this.optB, b, b.kind === "eq" ? "=" : "↓")
    this.skipBtn.disabled = !live
    this.spaceHint.textContent = live ? "cash" : "deal"
    if (live && hand) {
      const win = payout(hand.bet, x100(hand.m))
      this.action.set("Cash out", hand.n ? `${money(win)} · ${mult(x100(hand.m))}` : "make a call first", "cash")
      this.action.disabled = hand.n === 0
    } else {
      this.action.set("Deal", this.bet.valid ? `${money(this.bet.cents)} to play` : "enter a bet", "go")
      this.action.disabled = !this.bet.valid
    }
  }

  /* ── Other tables ── */

  private broadcast(s: BigOPlay["s"]) {
    const hand = this.hand
    const cur = this.current()
    if (!hand || !cur) return
    net.send({ t: "play", game: "bigo", d: { s, bet: hand.bet, card: cur.rank, suit: cur.suit, mult: x100(hand.m), n: hand.n } })
  }

  private onNet(msg: ServerMsg) {
    if (msg.t === "play" && msg.game === "bigo") {
      this.seats.set(msg.id, { name: msg.name, play: msg.d as BigOPlay, at: Date.now() })
      this.renderSeats(msg.id)
    } else if (msg.t === "leave" || msg.t === "update" || msg.t === "welcome") {
      this.renderSeats()
    }
  }

  private renderSeats(flash?: string) {
    const here = net.others("bigo")
    this.rail.hidden = here.length === 0
    if (!here.length) return
    this.railList.replaceChildren(
      ...here.map((p) => {
        const seat = this.seats.get(p.id)
        const play = seat?.play
        const state = !play ? "idle" : play.s === "bust" ? "bust" : play.s === "cash" ? "cash" : "live"
        return h(
          "li",
          { class: `cz-seat is-${state}${flash === p.id ? " is-flash" : ""}` },
          avatar(p.name),
          h("span", { class: "cz-seat-name", text: p.name }),
          play
            ? h("span", { class: "cz-seat-card", style: `--tier:${tier(play.card)}`, html: RANKS[play.card].html })
            : h("span", { class: "cz-seat-card is-empty", text: "—" }),
          h("span", {
            class: "cz-seat-res",
            text: !play
              ? "watching"
              : state === "bust"
                ? `bust · ${moneyShort(play.bet)}`
                : state === "cash"
                  ? `${mult(play.mult)} · +${moneyShort(payout(play.bet, play.mult) - play.bet)}`
                  : `${mult(play.mult)} · ${play.n} ${play.n === 1 ? "call" : "calls"}`,
          }),
        )
      }),
    )
  }
}
