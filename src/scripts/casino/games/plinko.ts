/* ── Plinko ──
   Drop a packet through the load balancer. Each row of nodes sends it left
   or right (50/50, decided up front), and the bucket it lands in sets the
   payout. Tables are the standard low / medium / high risk sets for 8, 12
   and 16 rows, every one returning ~99%.

   The path is fixed the moment the packet drops; the animation just shows
   it. Other players' packets fall through your board too, as ghosts with
   their name on, whenever they're on the same number of rows. */

import { PLINKO_ROWS, type PlinkoPlay, type ServerMsg } from "../../../../multiplayer/src/protocol"
import type { Game } from "../game"
import { net } from "../net"
import { sfx } from "../sfx"
import { prefs, wallet } from "../store"
import {
  BetInput,
  actionButton,
  avatar,
  dotColor,
  h,
  money,
  moneyShort,
  mult,
  payout,
  rand,
  reducedMotion,
  segmented,
  signed,
  toast,
} from "../ui"

type Rows = (typeof PLINKO_ROWS)[number]
type Risk = 0 | 1 | 2

const TABLES: Record<Rows, [number[], number[], number[]]> = {
  8: [
    [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
    [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
  ],
  12: [
    [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
    [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
    [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170],
  ],
  16: [
    [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
    [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
    [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
  ],
}

const FALL_MS = 260
const HOP_MS = 128
const TRAIL = 6

interface Ball {
  rows: Rows
  path: number
  bet: number
  mult: number // ×100
  t0: number
  ghost?: { name: string; color: string }
  landed?: boolean
  /** Last row whose node has lit up for this packet. */
  hitRow: number
}

interface Popup {
  x: number
  y: number
  text: string
  color: string
  t0: number
}

const bucketOf = (path: number, rows: number) => {
  let k = 0
  for (let i = 0; i < rows; i++) if (path & (1 << i)) k++
  return k
}

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t))
const GREEN = [58, 163, 58]
const AMBER = [242, 190, 0]
const RED = [217, 56, 30]
/** Bucket fill by distance from the middle: green → amber → red. */
const heat = (t: number) => (t < 0.5 ? mix(GREEN, AMBER, t * 2) : mix(AMBER, RED, (t - 0.5) * 2))
/** Black or white, whichever reads on a fill. */
const inkOn = (c: number[]) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > 150 ? "#000" : "#fff")

// The packet: XP's own blue
const PACKET = "#0054e3"
const UI_FONT = "Tahoma, Verdana, 'Segoe UI', sans-serif"

export class PlinkoGame implements Game {
  readonly id = "plinko" as const
  readonly stage: HTMLElement
  readonly panel: HTMLElement

  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private recent: HTMLElement
  private bet: BetInput
  private riskSeg
  private rowsSeg
  private action: ReturnType<typeof actionButton>
  private rail: HTMLElement
  private railList: HTMLElement

  private rows: Rows = prefs.get<Rows>("plinko:rows", 12)
  private risk: Risk = prefs.get<Risk>("plinko:risk", 1)
  private balls: Ball[] = []
  private popups: Popup[] = []
  private pegHits = new Map<string, number>()
  private bucketHits = new Map<number, number>()
  private raf = 0
  private visible = false
  private lastDrop = 0
  private dpr = 1
  private w = 0
  private hgt = 0

  constructor() {
    this.canvas = h("canvas", { class: "cz-plinko-canvas" })
    this.ctx = this.canvas.getContext("2d")!
    this.recent = h("div", { class: "cz-plinko-recent", "aria-label": "Recent drops" })
    this.stage = h("div", { class: "cz-stage cz-plinko-stage" }, this.canvas, this.recent)

    this.bet = new BetInput("plinko")
    this.riskSeg = segmented<Risk>(
      "Risk",
      [
        { value: 0, label: "Low" },
        { value: 1, label: "Medium" },
        { value: 2, label: "High" },
      ],
      this.risk,
      (v) => {
        this.risk = v
        prefs.set("plinko:risk", v)
        this.bucketHits.clear()
      },
    )
    this.rowsSeg = segmented<Rows>(
      "Rows",
      PLINKO_ROWS.map((r) => ({ value: r, label: String(r) })),
      this.rows,
      (v) => {
        this.rows = v
        prefs.set("plinko:rows", v)
        this.pegHits.clear()
        this.bucketHits.clear()
      },
    )
    this.action = actionButton(() => this.drop())
    this.bet.onChange(() => this.renderControls())
    wallet.onChange(() => this.renderControls())

    this.railList = h("ul", { class: "cz-plinko-feed" })
    this.rail = h(
      "section",
      { class: "cz-rail", hidden: true },
      h("header", { class: "cz-rail-head" }, h("span", { class: "cz-live-dot" }), h("span", { text: "Also dropping" })),
      this.railList,
    )

    this.panel = h(
      "aside",
      { class: "cz-panel" },
      h(
        "div",
        { class: "cz-controls" },
        this.bet.el,
        this.riskSeg.el,
        this.rowsSeg.el,
        this.action.el,
        h("p", { class: "cz-hint", html: "<kbd>Space</kbd> drop · hold to keep dropping" }),
      ),
      this.rail,
    )

    new ResizeObserver(() => this.resize()).observe(this.stage)
    net.on((msg) => this.onNet(msg))
    this.renderControls()
  }

  enter() {
    this.visible = true
    this.loop()
    this.renderRail()
  }

  leave() {
    this.visible = false
    cancelAnimationFrame(this.raf)
    // Pay out anything still falling rather than leave it mid-air
    for (const b of this.balls) if (!b.ghost && !b.landed) this.land(b, false)
    this.balls = []
    this.renderControls()
  }

  key(e: KeyboardEvent) {
    if (e.key === " " || e.key === "Enter") {
      if ((e.target as HTMLElement).closest("button") && !e.repeat) return false
      this.drop()
      return true
    }
    return false
  }

  /* ── Play ── */

  private inFlight() {
    return this.balls.some((b) => !b.ghost && !b.landed)
  }

  private drop() {
    const now = performance.now()
    if (now - this.lastDrop < 110) return
    if (!this.bet.valid) {
      toast(wallet.balance < this.bet.cents ? "Not enough balance for that bet." : "Enter a bet of at least $0.10.")
      return
    }
    const bet = this.bet.cents
    if (!wallet.debit(bet)) return
    this.lastDrop = now
    let path = 0
    for (let i = 0; i < this.rows; i++) if (rand() < 0.5) path |= 1 << i
    const k = bucketOf(path, this.rows)
    const m = Math.round(TABLES[this.rows][this.risk][k] * 100)
    this.balls.push({ rows: this.rows, path, bet, mult: m, t0: now, hitRow: -1 })
    sfx.bet()
    net.send({ t: "play", game: "plinko", d: { bet, rows: this.rows, risk: this.risk, path, mult: m } })
    this.renderControls()
    if (reducedMotion.matches) this.land(this.balls[this.balls.length - 1])
  }

  private land(b: Ball, animate = true) {
    if (b.landed) return
    b.landed = true
    if (b.ghost) return
    const win = payout(b.bet, b.mult)
    wallet.credit(win)
    const k = bucketOf(b.path, b.rows)
    if (animate) {
      this.bucketHits.set(k, performance.now())
      const g = this.geom(b.rows)
      const profit = win - b.bet
      this.popups.push({
        x: g.cx + (k - b.rows / 2) * g.s,
        y: g.bucketY - 8,
        text: profit >= 0 ? `+${moneyShort(profit)}` : `${mult(b.mult)}`,
        color: profit > 0 ? "#1a7a1a" : "rgba(64,64,64,.75)",
        t0: performance.now(),
      })
      if (b.mult >= 1000) sfx.win(true)
      else if (b.mult > 100) sfx.win(false)
      else sfx.tick(0.6)
    }
    this.pushRecent(b.mult)
    if (b.mult >= 1000 && b.bet >= 100) toast(`${mult(b.mult)} bucket! ${signed(win - b.bet)}`, "win")
    this.renderControls()
  }

  /* ── Geometry ──
     Row i has i+3 nodes, one unit apart; the packet starts over the middle
     node of the top row and moves half a unit per bounce, so after all rows
     it sits over bucket k (the number of rightward bounces). */

  private geom(rows: number) {
    const padX = 18
    const padTop = 34
    const bucketH = Math.max(22, Math.min(34, this.w / (rows + 2) * 0.62))
    const padBottom = 18 + bucketH
    const s = Math.min((this.w - padX * 2) / (rows + 2), (this.hgt - padTop - padBottom) / (rows - 0.2))
    const cx = this.w / 2
    const top = padTop
    const rowY = (i: number) => top + i * s
    const bucketY = rowY(rows - 1) + s * 0.72
    return { s, cx, top, rowY, bucketY, bucketH, pegR: Math.max(2, s * 0.085), ballR: Math.max(4, s * 0.2) }
  }

  /** Where a packet is, t ms after it dropped; null once it has landed. */
  private ballAt(b: Ball, t: number): [number, number] | null {
    const g = this.geom(b.rows)
    const lift = g.pegR + g.ballR
    if (t < FALL_MS) {
      const e = (t / FALL_MS) ** 2
      return [g.cx, g.top - g.s * 0.9 + (g.s * 0.9 - lift) * e]
    }
    const k = Math.floor((t - FALL_MS) / HOP_MS)
    if (k >= b.rows) return null
    let off = 0
    for (let i = 0; i < k; i++) off += b.path & (1 << i) ? 0.5 : -0.5
    const dir = b.path & (1 << k) ? 0.5 : -0.5
    const s = (t - FALL_MS - k * HOP_MS) / HOP_MS
    const x0 = g.cx + off * g.s
    const y0 = g.rowY(k) - lift
    const last = k === b.rows - 1
    const y1 = last ? g.bucketY + g.bucketH * 0.35 : g.rowY(k + 1) - lift
    const x = x0 + dir * g.s * s
    const y = y0 + (y1 - y0) * s * s - g.s * 0.42 * 4 * s * (1 - s) * (1 - s * 0.35)
    return [x, y]
  }

  /* ── Loop ── */

  private resize() {
    const r = this.stage.getBoundingClientRect()
    this.dpr = Math.min(2, window.devicePixelRatio || 1)
    this.w = r.width
    this.hgt = r.height
    this.canvas.width = Math.round(r.width * this.dpr)
    this.canvas.height = Math.round(r.height * this.dpr)
    this.draw(performance.now())
  }

  private loop() {
    cancelAnimationFrame(this.raf)
    const frame = (now: number) => {
      if (!this.visible) return
      this.step(now)
      this.draw(now)
      this.raf = requestAnimationFrame(frame)
    }
    this.raf = requestAnimationFrame(frame)
  }

  private step(now: number) {
    for (const b of this.balls) {
      if (b.landed) continue
      const t = now - b.t0
      // Each node lights (and ticks) as the packet bounces off it
      const k = Math.floor((t - FALL_MS) / HOP_MS)
      if (t >= FALL_MS && k < b.rows && k > b.hitRow) {
        b.hitRow = k
        let off = 0
        for (let i = 0; i < k; i++) off += b.path & (1 << i) ? 0.5 : -0.5
        if (b.rows === this.rows) this.pegHits.set(`${k}:${off + (k + 2) / 2}`, now)
        if (!b.ghost) sfx.tick(1 + k * 0.03)
      }
      if (!this.ballAt(b, t)) {
        if (b.ghost && b.rows === this.rows) this.bucketHits.set(bucketOf(b.path, b.rows), now)
        this.land(b)
      }
    }
    this.balls = this.balls.filter((b) => !b.landed)
    this.popups = this.popups.filter((p) => now - p.t0 < 1100)
  }

  private draw(now: number) {
    const { ctx, dpr, w, hgt: H } = this
    if (!w || !H) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, H)
    const rows = this.rows
    const g = this.geom(rows)
    const table = TABLES[rows][this.risk]

    // Nodes
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < i + 3; j++) {
        const x = g.cx + (j - (i + 2) / 2) * g.s
        const y = g.rowY(i)
        const hit = this.pegHits.get(`${i}:${j}`)
        const age = hit ? (now - hit) / 380 : 1
        if (age < 1) {
          ctx.beginPath()
          ctx.arc(x, y, g.pegR + 10 * age, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(47,111,224,${0.28 * (1 - age)})`
          ctx.fill()
        }
        ctx.beginPath()
        ctx.arc(x, y, g.pegR, 0, Math.PI * 2)
        ctx.fillStyle = age < 1 ? `rgba(47,111,224,${0.5 + 0.5 * (1 - age)})` : "rgba(84,98,122,0.75)"
        ctx.fill()
      }
    }

    // Buckets
    const bw = g.s * 0.9
    const fs = Math.max(7.5, Math.min(12, g.s * 0.3))
    ctx.font = `bold ${fs}px ${UI_FONT}`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    for (let k = 0; k <= rows; k++) {
      const m = table[k]
      const t = Math.abs(k - rows / 2) / (rows / 2)
      const x = g.cx + (k - rows / 2) * g.s
      const hit = this.bucketHits.get(k)
      const age = hit ? (now - hit) / 500 : 1
      const bounce = age < 1 ? Math.sin(age * Math.PI) * 6 * (1 - age) : 0
      const glow = age < 1 ? 1 - age : 0
      const y = g.bucketY + bounce
      ctx.beginPath()
      ctx.roundRect(x - bw / 2, y, bw, g.bucketH, Math.min(3, g.s * 0.1))
      const c = m < 1 ? [212, 208, 200] : heat(Math.min(1, t))
      ctx.fillStyle = `rgba(${c.join(",")},${0.85 + 0.15 * glow})`
      if (glow) {
        ctx.shadowColor = `rgba(${c.join(",")},${0.8 * glow})`
        ctx.shadowBlur = 14 * glow
      }
      ctx.fill()
      ctx.shadowBlur = 0
      // A bevel's worth of light along the top, as XP's buttons have
      ctx.fillStyle = "rgba(255,255,255,0.35)"
      ctx.fillRect(x - bw / 2 + 1, y + 1, bw - 2, Math.max(1, g.bucketH * 0.28))
      ctx.fillStyle = m < 1 ? "#55524a" : inkOn(c)
      // Narrow buckets (16 rows on a phone) drop the × before they overflow
      let label = `${m}\u00d7`
      if (ctx.measureText(label).width > bw - 3) label = `${m}`
      ctx.fillText(label, x, y + g.bucketH / 2 + 0.5)
    }

    // Packets
    for (const b of this.balls) {
      if (b.rows !== rows) continue
      const t = now - b.t0
      const p = this.ballAt(b, t)
      if (!p) continue
      const color = b.ghost ? b.ghost.color : PACKET
      const r = g.ballR
      // The trail is where the packet was a few ms ago, not where it was on
      // earlier frames, so it reads the same at 30fps as at 120
      for (let i = TRAIL; i >= 1; i--) {
        const q = this.ballAt(b, Math.max(0, t - i * 16))
        if (!q) continue
        const k = 1 - i / (TRAIL + 1)
        ctx.fillStyle = hexA(color, k * (b.ghost ? 0.14 : 0.24))
        ctx.beginPath()
        ctx.roundRect(q[0] - r * (0.5 + 0.35 * k), q[1] - r * (0.5 + 0.35 * k), r * (1 + 0.7 * k), r * (1 + 0.7 * k), r * 0.4)
        ctx.fill()
      }
      ctx.shadowColor = hexA(color, b.ghost ? 0.3 : 0.7)
      ctx.shadowBlur = b.ghost ? 6 : 14
      ctx.fillStyle = b.ghost ? hexA(color, 0.7) : color
      ctx.beginPath()
      ctx.roundRect(p[0] - r, p[1] - r, r * 2, r * 2, r * 0.45)
      ctx.fill()
      ctx.shadowBlur = 0
      if (b.ghost) {
        ctx.font = `10px ${UI_FONT}`
        ctx.fillStyle = hexA(color, 0.8)
        ctx.textAlign = "left"
        ctx.fillText(b.ghost.name, p[0] + r + 4, p[1] - r - 2)
      }
    }

    // Win pop-ups
    ctx.font = `bold 12px ${UI_FONT}`
    ctx.textAlign = "center"
    for (const pop of this.popups) {
      const t = (now - pop.t0) / 1100
      ctx.globalAlpha = 1 - t * t
      ctx.fillStyle = pop.color
      ctx.fillText(pop.text, pop.x, pop.y - t * 26)
    }
    ctx.globalAlpha = 1
  }

  /* ── Rendering ── */

  private renderControls() {
    const busy = this.inFlight()
    this.rowsSeg.disabled = busy
    const n = this.balls.filter((b) => !b.ghost && !b.landed).length
    this.action.set("Drop packet", this.bet.valid ? `${money(this.bet.cents)}${n ? ` · ${n} in flight` : ""}` : "enter a bet", "go")
    this.action.disabled = !this.bet.valid
  }

  private pushRecent(m: number) {
    const chip = h("span", { class: `cz-plinko-chip ${m >= 1000 ? "is-hot" : m >= 200 ? "is-good" : m >= 100 ? "is-even" : "is-low"}`, text: mult(m) })
    this.recent.prepend(chip)
    while (this.recent.childElementCount > 7) this.recent.lastElementChild?.remove()
  }

  /* ── Other players ── */

  private onNet(msg: ServerMsg) {
    if (msg.t === "leave" || msg.t === "update" || msg.t === "welcome") this.renderRail()
    if (msg.t !== "play" || msg.game !== "plinko") return
    const d = msg.d as PlinkoPlay
    if (this.visible && d.rows === this.rows && this.balls.length < 40) {
      this.balls.push({
        rows: d.rows as Rows,
        path: d.path,
        bet: d.bet,
        mult: d.mult,
        t0: performance.now(),
        ghost: { name: msg.name, color: dotColor(msg.name) },
        hitRow: -1,
      })
    }
    const li = h(
      "li",
      { class: `cz-feed-row${d.mult >= 100 ? " is-win" : ""}` },
      avatar(msg.name),
      h("span", { class: "cz-feed-name", text: msg.name }),
      h("span", { class: "cz-feed-mult", text: mult(d.mult) }),
      h("span", { class: "cz-feed-amt", text: signed(payout(d.bet, d.mult) - d.bet) || "±0" }),
    )
    // Reveal it when their packet lands
    window.setTimeout(() => {
      this.railList.prepend(li)
      while (this.railList.childElementCount > 8) this.railList.lastElementChild?.remove()
    }, FALL_MS + HOP_MS * d.rows)
    this.renderRail()
  }

  private renderRail() {
    this.rail.hidden = net.others("plinko").length === 0
  }
}

function hexA(hex: string, a: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
