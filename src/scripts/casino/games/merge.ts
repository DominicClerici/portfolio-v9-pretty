/* ── Merge Conflict ──
   Roulette as a reel of commits. Fifteen to a cycle: seven resolve --ours,
   seven --theirs, one is a conflict. Stake any mix of the three, run
   `git merge`, and the reel spins down to whichever commit lands under the
   head. Ours and theirs pay 2×, a conflict pays 14×.

   Other players' spins show up as chips on the boxes they backed, revealed
   when their own reel would stop, and as lines in the shared merge log. */

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
  money,
  moneyShort,
  rand,
  reducedMotion,
  signed,
  toast,
} from "../ui"

type Side = "o" | "t" | "c"
const CYCLE: Side[] = ["c", "o", "t", "o", "t", "o", "t", "o", "t", "o", "t", "o", "t", "o", "t"]
const PAYS: Record<Side, number> = { o: 2, t: 2, c: 14 }
const CYCLES = 9
const SPIN_MS = 5200

const SIDE_INFO: Record<Side, { flag: string; name: string; tile: string }> = {
  o: { flag: "--ours", name: "ours", tile: "ours" },
  t: { flag: "--theirs", name: "theirs", tile: "theirs" },
  c: { flag: "CONFLICT", name: "conflict", tile: "<<<<<<<" },
}

const BRANCHES = [
  "feature/yolo",
  "hotfix/please-work",
  "feat/all-in",
  "fix/typo-final-FINAL",
  "refactor/everything",
  "wip/do-not-merge",
  "chore/bump-deps",
  "feat/add-blockchain",
  "fix/works-on-my-machine",
  "experiment/vibes",
]
const FILES = ["src/wallet.ts", "package-lock.json", "src/index.ts", "README.md", "src/utils/luck.ts"]

const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)]
const hash = () => Math.floor(rand() * 0xfffffff).toString(16).padStart(7, "0")

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
      for (const side of CYCLE) {
        const tile = h(
          "div",
          { class: `cz-tile is-${side}` },
          h("span", { class: "cz-tile-name", text: SIDE_INFO[side].tile }),
          h("span", { class: "cz-tile-hash", text: hash() }),
        )
        this.tiles.push(tile)
        this.strip.append(tile)
      }
    this.reel = h(
      "div",
      { class: "cz-reel" },
      this.strip,
      h("div", { class: "cz-reel-head", "aria-hidden": "true" }),
    )
    this.historyEl = h("div", { class: "cz-merge-history", "aria-label": "Recent merges" })
    this.log = h("div", { class: "cz-term", role: "log", "aria-live": "polite" })

    const box = (side: Side) => {
      const stake = h("span", { class: "cz-box-stake" })
      const others = h("span", { class: "cz-box-others" })
      const el = h(
        "button",
        {
          type: "button",
          class: `cz-box is-${side}`,
          title: `Add your bet to ${SIDE_INFO[side].name} (right-click to clear)`,
          onclick: () => this.add(side),
          oncontextmenu: (e: Event) => {
            e.preventDefault()
            this.clear(side)
          },
        },
        h("span", { class: "cz-box-flag", text: SIDE_INFO[side].flag }),
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
      this.log,
    )

    this.bet = new BetInput("merge", "Chip")
    this.action = actionButton(() => this.merge())
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
        h("p", { class: "cz-panel-note", text: "Click a box to stake a chip on it. Back as many as you like." }),
        h(
          "div",
          { class: "cz-quick" },
          ...(["o", "c", "t"] as Side[]).map((s) =>
            h("button", { type: "button", class: `cz-quick-btn is-${s}`, text: `+ ${SIDE_INFO[s].name}`, onclick: () => this.add(s) }),
          ),
        ),
        this.clearBtn,
        this.action.el,
        h("p", { class: "cz-hint", html: "<kbd>O</kbd> <kbd>C</kbd> <kbd>T</kbd> stake · <kbd>Space</kbd> merge" }),
      ),
    )

    this.line(`$ git status`, "cmd")
    this.line(`On branch main. Your balance is up to date with 'origin/main'.`, "dim")

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
    if (k === "o" || k === "t" || k === "c") return this.add(k), true
    if (k === " " || k === "enter") {
      if ((e.target as HTMLElement).closest("button")) return false
      this.merge()
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

  private merge() {
    if (this.spin && !this.spin.done) return
    const total = this.total()
    if (!total) return toast("Stake a chip on ours, theirs or conflict first.")
    if (!wallet.debit(total)) return toast("Your stakes add up to more than your balance.")

    // Start from the same commit in the first cycle, so any spin has room
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
    const branch = pick(BRANCHES)
    this.line(`$ git merge ${branch}`, "cmd")
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
    const file = pick(FILES)
    if (spin.result === "c") {
      this.line(`CONFLICT (content): Merge conflict in ${file}`, "bad")
      this.line("Automatic merge failed; fix conflicts and then commit the result.", "dim")
    } else if (spin.result === "o") {
      this.line(`Merge made by the 'ours' strategy.`, "ok")
      this.line(` ${file} | 2 +-`, "dim")
    } else {
      this.line(`Merge made by the 'ort' strategy, -X theirs.`, "theirs")
      this.line(` ${file} | 5 +++--`, "dim")
    }
    const net_ = win - staked
    this.line(
      net_ > 0 ? `  ${signed(net_)}  (${money(win)} back)` : net_ === 0 ? `  even  (${money(win)} back)` : `  ${signed(net_)}`,
      net_ > 0 ? "ok" : net_ < 0 ? "bad" : "dim",
    )
    if (net_ > 0) sfx.win(spin.result === "c")
    else sfx.lose()
    if (win > 0 && spin.result === "c") toast(`Conflict! ${signed(net_)}`, "win")

    this.history = [spin.result, ...this.history].slice(0, 30)
    prefs.set("merge:history", this.history)
    this.renderHistory()

    // Re-seat the reel on the same commit near the front, so it never runs out
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
      h("span", { class: "cz-label", text: "git log" }),
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
      this.action.set("Merging…", `${money(total)} riding`, "wait")
      this.action.disabled = true
    } else {
      this.action.set("git merge", total ? `${money(total)} staked` : "stake a chip first", "go")
      this.action.disabled = !total || total > wallet.balance
    }
  }

  private line(text: string, tone: "cmd" | "ok" | "bad" | "dim" | "theirs" | "peer" = "dim") {
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
      this.line(`${msg.name} merged -> ${SIDE_INFO[d.r].name}  ${signed(net_) || "±0"}`, "peer")
      window.setTimeout(() => {
        chips.forEach((c) => {
          c.classList.add("is-out")
          window.setTimeout(() => c.remove(), 400)
        })
      }, 2600)
    }, d.ms)
  }
}
