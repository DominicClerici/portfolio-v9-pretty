/* ── Roulette ──
   A reel of numbered tiles, fifteen to a cycle: seven red, seven black, and
   a green zero. Put chips on any mix of the three, spin, and the reel winds
   down to whichever tile lands under the head. Red and black pay 2×, green
   pays 14×.

   Other players' spins show up as chips on the colors they backed, revealed
   when their own reel would stop, and as lines in the shared log. */

import type { MergePlay, ServerMsg } from "../../../../multiplayer/src/protocol"
import type { Game } from "../game"
import { net } from "../net"
import { sfx } from "../sfx"
import { prefs, wallet } from "../store"
import {
  BetInput,
  MIN_BET,
  actionButton,
  avatar,
  h,
  icons,
  money,
  moneyShort,
  rand,
  reducedMotion,
  signed,
  svg,
  toast,
} from "../ui"

type Side = "o" | "t" | "c"
const CYCLE: Side[] = ["c", "o", "t", "o", "t", "o", "t", "o", "t", "o", "t", "o", "t", "o", "t"]
const PAYS: Record<Side, number> = { o: 2, t: 2, c: 14 }
const CYCLES = 9
const SPIN_MS = 5200

const SIDE_INFO: Record<Side, { name: string }> = {
  o: { name: "Red" },
  t: { name: "Black" },
  c: { name: "Green" },
}
const KEYS: Record<string, Side> = { r: "o", b: "t", g: "c" }

const PROMPT = "C:\\Program Files\\Casino>"

interface Spin {
  stakes: Record<Side, number>
  result: Side
  target: number
  from: number
  start: number
  raf: number
  done: boolean
}

export class MergeGame implements Game {
  readonly id = "merge" as const
  readonly stage: HTMLElement
  readonly panel: HTMLElement

  private reel: HTMLElement
  private strip: HTMLElement
  private tiles: HTMLElement[] = []
  private log: HTMLElement
  private historyEl: HTMLElement
  private boxes = {} as Record<Side, { el: HTMLButtonElement; stake: HTMLElement; others: HTMLElement }>
  private stakes: Record<Side, number> = prefs.get("merge:stakes", { o: 0, t: 0, c: 0 })
  private bet: BetInput
  private action: ReturnType<typeof actionButton>
  private clearBtn: HTMLButtonElement
  private pos = CYCLE.length + 7.5 // tile index under the head, fractional
  private pitch = 0
  private spin: Spin | null = null
  private history: Side[] = prefs.get<Side[]>("merge:history", [])

  constructor() {
    this.strip = h("div", { class: "cz-reel-strip" })
    for (let c = 0; c < CYCLES; c++)
      for (const [i, side] of CYCLE.entries()) {
        const tile = h("div", { class: `cz-tile is-${side}`, "aria-label": `${i} ${SIDE_INFO[side].name}` }, String(i))
        this.tiles.push(tile)
        this.strip.append(tile)
      }
    this.reel = h(
      "div",
      { class: "cz-reel" },
      this.strip,
      h("div", { class: "cz-reel-head", "aria-hidden": "true" }),
    )
    this.historyEl = h("div", { class: "cz-merge-history", "aria-label": "Recent spins" })
    this.log = h("div", { class: "cz-term", role: "log", "aria-live": "polite" })

    const box = (side: Side) => {
      const stake = h("span", { class: "cz-box-stake" })
      const others = h("span", { class: "cz-box-others" })
      const el = h(
        "button",
        {
          type: "button",
          class: `cz-box is-${side}`,
          title: `Add a chip to ${SIDE_INFO[side].name.toLowerCase()} (right-click to clear)`,
          onclick: () => this.add(side),
          oncontextmenu: (e: Event) => {
            e.preventDefault()
            this.clear(side)
          },
        },
        h("span", { class: "cz-box-flag", text: SIDE_INFO[side].name }),
        h("span", { class: "cz-box-pays", text: `${PAYS[side]}×` }),
        stake,
        others,
      )
      this.boxes[side] = { el, stake, others }
      return el
    }

    this.stage = h(
      "div",
      { class: "cz-stage cz-merge-stage" },
      this.historyEl,
      this.reel,
      h("div", { class: "cz-boxes" }, box("o"), box("c"), box("t")),
      h(
        "div",
        { class: "cz-cmd" },
        h("div", { class: "cz-cmd-title" }, svg(icons.cmd, 14), h("span", { text: "C:\\WINDOWS\\system32\\cmd.exe" })),
        this.log,
      ),
    )

    this.bet = new BetInput("merge", "Chip")
    this.action = actionButton(() => this.spinNow())
    this.clearBtn = h("button", { type: "button", class: "cz-ghost-btn", text: "Clear bets", onclick: () => this.clear() })
    this.bet.onChange(() => this.renderControls())
    wallet.onChange(() => this.renderControls())

    this.panel = h(
      "aside",
      { class: "cz-panel" },
      h(
        "div",
        { class: "cz-controls" },
        this.bet.el,
        h("p", { class: "cz-panel-note", text: "Click a color to put a chip on it. Back as many as you like." }),
        h(
          "div",
          { class: "cz-quick" },
          ...(["o", "c", "t"] as Side[]).map((s) =>
            h("button", { type: "button", class: `cz-quick-btn is-${s}`, text: `+ ${SIDE_INFO[s].name.toLowerCase()}`, onclick: () => this.add(s) }),
          ),
        ),
        this.clearBtn,
        this.action.el,
        h("p", { class: "cz-hint", html: "<kbd>R</kbd> <kbd>G</kbd> <kbd>B</kbd> add a chip · <kbd>Space</kbd> spin" }),
      ),
    )

    this.line("Casino [Version 5.1.2600]", "dim")

    new ResizeObserver(() => this.measure()).observe(this.reel)
    net.on((msg) => this.onNet(msg))
    this.renderHistory()
    this.renderBoxes()
  }

  enter() {
    this.measure()
  }

  leave() {
    // Don't leave a spin hanging on a hidden reel: land it now
    if (this.spin && !this.spin.done) this.finish(this.spin)
  }

  key(e: KeyboardEvent) {
    const k = e.key.toLowerCase()
    if (KEYS[k]) return this.add(KEYS[k]), true
    if (k === " " || k === "enter") {
      if ((e.target as HTMLElement).closest("button")) return false
      this.spinNow()
      return true
    }
    return false
  }

  /* ── Stakes ── */

  private total() {
    return this.stakes.o + this.stakes.t + this.stakes.c
  }

  private add(side: Side) {
    if (this.spin && !this.spin.done) return
    const chip = this.bet.cents
    if (!Number.isFinite(chip) || chip < MIN_BET) return toast("Chips start at $0.10.")
    if (this.total() + chip > wallet.balance) return toast("That's more than your balance.")
    this.stakes[side] += chip
    prefs.set("merge:stakes", this.stakes)
    sfx.bet()
    const el = this.boxes[side].el
    el.classList.remove("is-bump")
    void el.offsetWidth
    el.classList.add("is-bump")
    this.renderBoxes()
  }

  private clear(side?: Side) {
    if (this.spin && !this.spin.done) return
    if (side) this.stakes[side] = 0
    else this.stakes = { o: 0, t: 0, c: 0 }
    prefs.set("merge:stakes", this.stakes)
    sfx.click()
    this.renderBoxes()
  }

  /* ── Spin ── */

  private spinNow() {
    if (this.spin && !this.spin.done) return
    const total = this.total()
    if (!total) return toast("Put a chip on red, black or green first.")
    if (!wallet.debit(total)) return toast("Your chips add up to more than your balance.")

    // Start from the same tile in the first cycle, so any spin has room
    this.pos = (Math.floor(this.pos) % CYCLE.length) + CYCLE.length + (this.pos % 1)
    const slot = Math.floor(rand() * CYCLE.length)
    const result = CYCLE[slot]
    // Land at least four full cycles on, somewhere inside the tile
    const base = Math.floor(this.pos)
    let target = base - (base % CYCLE.length) + slot + CYCLE.length * 5
    if (target - this.pos < CYCLE.length * 4) target += CYCLE.length
    const jitter = 0.12 + rand() * 0.76
    this.tiles.forEach((t) => t.classList.remove("is-win"))

    const spin: Spin = {
      stakes: { ...this.stakes },
      result,
      target: target + jitter,
      from: this.pos,
      start: performance.now(),
      raf: 0,
      done: false,
    }
    this.spin = spin
    this.line(`${PROMPT}spin`, "cmd")
    sfx.click()
    net.send({ t: "play", game: "merge", d: { ...spin.stakes, r: result, ms: SPIN_MS, win: this.winOf(spin) } })
    this.renderControls()

    if (reducedMotion.matches) {
      this.finish(spin)
      return
    }
    let lastTile = Math.floor(this.pos)
    const frame = (now: number) => {
      if (spin.done) return
      const t = Math.min(1, (now - spin.start) / SPIN_MS)
      const e = 1 - (1 - t) ** 4
      this.pos = spin.from + (spin.target - spin.from) * e
      this.place()
      const tile = Math.floor(this.pos)
      if (tile !== lastTile) {
        lastTile = tile
        sfx.tick(0.8 + (1 - t) * 0.5)
      }
      if (t < 1) spin.raf = requestAnimationFrame(frame)
      else this.finish(spin)
    }
    spin.raf = requestAnimationFrame(frame)
  }

  private winOf(spin: Pick<Spin, "stakes" | "result">) {
    return spin.stakes[spin.result] * PAYS[spin.result]
  }

  private finish(spin: Spin) {
    if (spin.done) return
    spin.done = true
    cancelAnimationFrame(spin.raf)
    this.pos = spin.target
    this.place()
    const landed = this.tiles[Math.floor(spin.target)]
    landed?.classList.add("is-win")

    const win = this.winOf(spin)
    const staked = spin.stakes.o + spin.stakes.t + spin.stakes.c
    wallet.credit(win)
    const n = Math.floor(spin.target) % CYCLE.length
    this.line(`${n} ${SIDE_INFO[spin.result].name.toLowerCase()}`, spin.result === "o" ? "red" : spin.result === "c" ? "green" : "black")
    const net_ = win - staked
    this.line(
      net_ > 0 ? `  ${signed(net_)}  (${money(win)} back)` : net_ === 0 ? `  even  (${money(win)} back)` : `  ${signed(net_)}`,
      net_ > 0 ? "ok" : net_ < 0 ? "bad" : "dim",
    )
    if (net_ > 0) sfx.win(spin.result === "c")
    else sfx.lose()
    if (win > 0 && spin.result === "c") toast(`Green! ${signed(net_)}`, "win")

    this.history = [spin.result, ...this.history].slice(0, 30)
    prefs.set("merge:history", this.history)
    this.renderHistory()

    // Re-seat the reel on the same tile near the front, so it never runs out
    window.setTimeout(() => {
      if (this.spin !== spin) return
      const idx = Math.floor(this.pos)
      const frac = this.pos - idx
      const same = (idx % CYCLE.length) + CYCLE.length
      const winClass = landed?.classList.contains("is-win")
      landed?.classList.remove("is-win")
      this.pos = same + frac
      this.place()
      if (winClass) this.tiles[same].classList.add("is-win")
    }, 900)

    // Keep the stakes for a quick re-run, unless they're no longer affordable
    if (this.total() > wallet.balance) this.stakes = { o: 0, t: 0, c: 0 }
    this.renderBoxes()
  }

  /* ── Rendering ── */

  private measure() {
    const first = this.tiles[0]
    if (!first) return
    const second = this.tiles[1]
    this.pitch = second.offsetLeft - first.offsetLeft || first.offsetWidth
    this.place()
  }

  private place() {
    if (!this.pitch) return
    const x = this.reel.clientWidth / 2 - this.pos * this.pitch
    this.strip.style.transform = `translate3d(${x}px,0,0)`
  }

  private renderHistory() {
    this.historyEl.replaceChildren(
      h("span", { class: "cz-label", text: "History" }),
      ...this.history.slice(0, 20).map((s) => h("span", { class: `cz-hist is-${s}`, title: SIDE_INFO[s].name })),
    )
  }

  private renderBoxes() {
    for (const side of ["o", "t", "c"] as Side[]) {
      const v = this.stakes[side]
      this.boxes[side].stake.textContent = v ? moneyShort(v) : ""
      this.boxes[side].el.classList.toggle("has-stake", v > 0)
    }
    this.renderControls()
  }

  private renderControls() {
    const spinning = !!this.spin && !this.spin.done
    const total = this.total()
    this.bet.disabled = spinning
    this.clearBtn.disabled = spinning || !total
    this.panel.querySelectorAll<HTMLButtonElement>(".cz-quick-btn").forEach((b) => (b.disabled = spinning))
    for (const side of ["o", "t", "c"] as Side[]) this.boxes[side].el.disabled = spinning
    if (spinning) {
      this.action.set("Spinning…", `${money(total)} riding`, "wait")
      this.action.disabled = true
    } else {
      this.action.set("Spin", total ? `${money(total)} on the table` : "add a chip first", "go")
      this.action.disabled = !total || total > wallet.balance
    }
  }

  private line(text: string, tone: "cmd" | "ok" | "bad" | "dim" | "red" | "black" | "green" | "peer" = "dim") {
    const el = h("div", { class: `cz-term-line is-${tone}`, text })
    this.log.append(el)
    while (this.log.childElementCount > 40) this.log.firstElementChild?.remove()
    this.log.scrollTop = this.log.scrollHeight
  }

  /* ── Other players ── */

  private onNet(msg: ServerMsg) {
    if (msg.t !== "play" || msg.game !== "merge") return
    const d = msg.d as MergePlay
    const chips: HTMLElement[] = []
    for (const side of ["o", "t", "c"] as Side[]) {
      const amt = d[side]
      if (!amt) continue
      const chip = h("span", { class: "cz-peer-chip", title: `${msg.name}: ${money(amt)}` }, avatar(msg.name), h("span", { text: moneyShort(amt) }))
      chip.dataset.side = side
      this.boxes[side].others.append(chip)
      chips.push(chip)
    }
    window.setTimeout(() => {
      chips.forEach((c) => c.classList.add(c.dataset.side === d.r ? "is-win" : "is-lose"))
      const staked = d.o + d.t + d.c
      const net_ = d.win - staked
      this.line(`${msg.name}: ${SIDE_INFO[d.r].name.toLowerCase()}  ${signed(net_) || "±0"}`, "peer")
      window.setTimeout(() => {
        chips.forEach((c) => {
          c.classList.add("is-out")
          window.setTimeout(() => c.remove(), 400)
        })
      }, 2600)
    }, d.ms)
  }
}
