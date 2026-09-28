/* ── Crash ──
   A memory graph that climbs until the process dies. Cash out before it does.

   With the lobby connected, rounds are the server's: everyone watches the
   same curve from the same start time, sees each other's stakes come in
   during the countdown, and sees each cash-out land on the line with a name
   on it. Alone with no connection, an identical round loop runs locally, so
   the game never waits on a network it doesn't have.

   Either way the round reaches this file as one model (phase, times in local
   epoch ms, bets), and everything below the engines only ever reads that. */

import {
  CRASH_BET_MS,
  CRASH_POST_MS,
  CRASH_RATE,
  crashAt,
  crashMsTo,
  crashPoint,
  type CrashBet,
  type CrashState,
  type ServerMsg,
} from "../../../../multiplayer/src/protocol"
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
  signed,
  toast,
} from "../ui"

type Phase = "idle" | "betting" | "running" | "crashed"

interface Model {
  mode: "local" | "remote"
  phase: Phase
  round: string
  endsAt: number
  startedAt: number
  point: number
  bets: CrashBet[]
}

interface MyBet {
  round: string
  amount: number
  auto: number
  /** Waiting on the server to accept it. */
  pending: boolean
  out?: number
  outSent?: boolean
  settled?: boolean
}

const CRASH_LINES = [
  "Segmentation fault (core dumped)",
  "Killed: out of memory",
  "java.lang.StackOverflowError",
  "panic: runtime error: index out of range",
  "TypeError: undefined is not a function",
  "Kernel panic - not syncing",
  "RecursionError: maximum recursion depth exceeded",
  "Process exited with code 139",
  "FATAL ERROR: JavaScript heap out of memory",
  "thread 'main' panicked at 'called unwrap() on None'",
  "Bus error (core dumped)",
  "NullPointerException at Main.java:1",
]

function flavour(m: number) {
  if (m < 1.3) return "allocating…"
  if (m < 2) return "heap growing"
  if (m < 3) return "memory leak detected"
  if (m < 5) return "GC can't keep up"
  if (m < 10) return "swap thrashing"
  if (m < 25) return "the OOM killer is watching"
  if (m < 100) return "how is this still running"
  return "this is a cosmic ray, surely"
}

const hex3 = () => Math.floor(rand() * 0xffffff).toString(16).padStart(6, "0")

export class CrashGame implements Game {
  readonly id = "crash" as const
  readonly stage: HTMLElement
  readonly panel: HTMLElement

  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private multEl: HTMLElement
  private subEl: HTMLElement
  private barEl: HTMLElement
  private historyEl: HTMLElement
  private table: HTMLElement
  private tableBody: HTMLElement
  private tableHead: HTMLElement
  private bet: BetInput
  private autoInput: HTMLInputElement
  private action: ReturnType<typeof actionButton>

  private model: Model = {
    mode: "local",
    phase: "idle",
    round: "",
    endsAt: 0,
    startedAt: 0,
    point: 0,
    bets: [],
  }
  private localHistory: number[] = prefs.get<number[]>("crash:history", [])
  private remoteHistory: number[] = []
  /** The server's latest word on the round, kept even while playing locally. */
  private remoteState: CrashState = { phase: "idle" }
  private mine: MyBet | null = null
  private queued = false
  private visible = false
  private raf = 0
  private localTimer = 0
  private dpr = 1
  private w = 0
  private hgt = 0
  // View scale, eased toward its target each frame so the axes glide
  private xMax = 8
  private yMax = 1.8
  private crashLine = CRASH_LINES[0]
  private crashFlash = 0
  private seenOut = new Map<string, number>()
  private colors = { lime: "#cef79e", coral: "#ff7a6b" }

  constructor() {
    this.canvas = h("canvas", { class: "cz-crash-canvas" })
    this.ctx = this.canvas.getContext("2d")!
    this.multEl = h("div", { class: "cz-crash-mult", text: "1.00×" })
    this.subEl = h("div", { class: "cz-crash-sub" })
    this.barEl = h("div", { class: "cz-crash-bar" }, h("span"))
    this.historyEl = h("div", { class: "cz-crash-history", "aria-label": "Recent rounds" })

    this.stage = h(
      "div",
      { class: "cz-stage cz-crash-stage" },
      this.canvas,
      this.historyEl,
      h("div", { class: "cz-crash-center" }, this.multEl, this.subEl),
      this.barEl,
    )

    this.bet = new BetInput("crash")
    this.autoInput = h("input", {
      class: "cz-bet-input",
      type: "text",
      inputmode: "decimal",
      placeholder: "off",
      autocomplete: "off",
      "aria-label": "Auto cash-out multiplier",
      value: prefs.get<string>("crash:auto", ""),
    })
    this.autoInput.addEventListener("input", () => prefs.set("crash:auto", this.autoInput.value))
    // On press, not release: a cash-out is a race, and a click can go
    // missing when the button re-enables under a cursor that hasn't moved
    this.action = actionButton(() => this.onAction(), true)
    this.bet.onChange(() => this.renderControls())
    wallet.onChange(() => this.renderControls())

    this.tableHead = h("span", { class: "cz-rail-count" })
    this.tableBody = h("ul", { class: "cz-crash-bets" })
    this.table = h(
      "section",
      { class: "cz-rail", hidden: true },
      h("header", { class: "cz-rail-head" }, h("span", { class: "cz-live-dot" }), h("span", { text: "This round" }), this.tableHead),
      this.tableBody,
    )

    this.panel = h(
      "aside",
      { class: "cz-panel" },
      h(
        "div",
        { class: "cz-controls" },
        this.bet.el,
        h(
          "div",
          { class: "cz-field" },
          h("label", { class: "cz-label", text: "Auto cash-out" }),
          h("div", { class: "cz-bet" }, this.autoInput, h("span", { class: "cz-bet-suffix", text: "×" })),
        ),
        this.action.el,
        h("p", { class: "cz-hint", html: "<kbd>Space</kbd> deploy / cash out" }),
      ),
      this.table,
    )

    new ResizeObserver(() => this.resize()).observe(this.stage)
    net.on((msg) => this.onNet(msg))
    net.onStatus(() => this.syncMode())
    this.renderHistory()
    this.renderControls()
  }

  /* ── Lifecycle ── */

  enter() {
    this.visible = true
    this.syncMode()
    if (this.model.mode === "local" && this.model.phase === "idle" && net.status !== "connecting")
      this.localBetting()
    this.loop()
  }

  leave() {
    this.visible = false
    cancelAnimationFrame(this.raf)
  }

  busy() {
    return !!this.mine && !this.mine.settled && this.model.mode === "remote"
  }

  key(e: KeyboardEvent) {
    if (e.key === " " || e.key === "Enter") {
      if ((e.target as HTMLElement).closest("button")) return false
      this.onAction()
      return true
    }
    return false
  }

  /** Remote whenever the lobby is live; local otherwise. Never mid-bet. */
  private syncMode() {
    // Still connecting and nothing on screen yet: wait for the verdict rather
    // than start a solo round the lobby would replace a second later
    if (net.status === "connecting" && this.model.phase === "idle") return
    const want = net.live ? "remote" : "local"
    if (want === this.model.mode) {
      // The connection attempt failed before anything started: go solo now
      if (want === "local" && this.model.phase === "idle" && this.visible) this.localBetting()
      return
    }
    if (this.model.mode === "remote" && this.mine && !this.mine.settled) {
      // The server is gone with our stake: give it back rather than guess
      if (this.mine.out == null) {
        wallet.credit(this.mine.amount)
        toast("Connection lost, your bet was refunded.")
      }
      this.mine = null
    }
    // A local round with our money in it plays out first; its end re-checks
    if (this.model.mode === "local" && this.mine && !this.mine.settled) return
    clearTimeout(this.localTimer)
    this.model = { mode: want, phase: "idle", round: "", endsAt: 0, startedAt: 0, point: 0, bets: [] }
    if (want === "remote") this.applyRemote(this.remoteState)
    else if (this.visible) this.localBetting()
    this.renderAll()
  }

  /* ── Remote engine ── */

  private onNet(msg: ServerMsg) {
    if (msg.t === "welcome") {
      this.remoteHistory = msg.history
      this.remoteState = msg.crash
      // The server's history already counts a round that has just crashed
      this.remoteHistoryRound = msg.crash.phase === "crashed" ? msg.crash.round : ""
      if (this.model.mode === "remote") this.applyRemote(msg.crash)
      else this.syncMode()
      return
    }
    if (msg.t === "crash") {
      this.remoteState = msg.state
      if (msg.state.phase === "crashed" && msg.state.round !== this.remoteHistoryRound) {
        this.remoteHistoryRound = msg.state.round
        this.remoteHistory = [msg.state.point, ...this.remoteHistory].slice(0, 24)
      }
    }
    if (this.model.mode !== "remote") return
    switch (msg.t) {
      case "crash":
        this.applyRemote(msg.state)
        break
      case "cbet":
        if (msg.round !== this.model.round) return
        this.model.bets = [...this.model.bets.filter((b) => b.id !== msg.bet.id), msg.bet]
        if (msg.bet.id === net.id && this.mine?.round === msg.round) {
          this.mine.pending = false
          sfx.bet()
        }
        this.renderTable()
        this.renderControls()
        break
      case "cout": {
        if (msg.round !== this.model.round) return
        const b = this.model.bets.find((x) => x.id === msg.id)
        if (b) b.out = msg.out
        if (msg.id === net.id) this.cashedOut(msg.out)
        this.renderTable()
        break
      }
      case "reject":
        if (msg.what === "bet" && this.mine?.pending) {
          wallet.credit(this.mine.amount)
          this.mine = null
          toast(msg.why)
        }
        if (msg.what === "out" && this.mine) this.mine.outSent = false
        this.renderControls()
        break
    }
  }

  private get history() {
    return this.model.mode === "remote" ? this.remoteHistory : this.localHistory
  }

  private remoteHistoryRound = ""

  private applyRemote(s: CrashState) {
    if (!net.live || this.model.mode !== "remote") return
    const m = this.model
    m.mode = "remote"
    if (s.phase === "idle") {
      m.phase = "idle"
      m.bets = []
    } else {
      const newRound = s.round !== m.round
      m.round = s.round
      m.bets = s.bets
      if (s.phase === "betting") {
        m.endsAt = net.toLocal(s.endsAt)
      } else {
        m.startedAt = net.toLocal(s.startedAt)
      }
      if (s.phase === "crashed") m.point = s.point
      const was = m.phase
      m.phase = s.phase
      if (newRound || was !== s.phase) this.onPhase(was)
    }
    this.renderAll()
  }

  /* ── Local engine ── */

  private localBetting() {
    clearTimeout(this.localTimer)
    const now = Date.now()
    this.model = {
      mode: "local",
      phase: "betting",
      round: hex3(),
      endsAt: now + CRASH_BET_MS,
      startedAt: 0,
      point: crashPoint(rand()),
      bets: [],
    }
    this.onPhase("idle")
    this.renderAll()
    this.localTimer = window.setTimeout(() => this.localRun(), CRASH_BET_MS)
  }

  private localRun() {
    const m = this.model
    m.phase = "running"
    m.startedAt = Date.now()
    this.onPhase("betting")
    this.renderAll()
    this.localTimer = window.setTimeout(() => this.localCrash(), crashMsTo(m.point))
  }

  private localCrash() {
    const m = this.model
    for (const b of m.bets) if (b.out == null && b.auto > 0 && b.auto < m.point) b.out = b.auto
    m.phase = "crashed"
    this.localHistory = [m.point, ...this.localHistory].slice(0, 24)
    prefs.set("crash:history", this.localHistory)
    this.onPhase("running")
    this.renderAll()
    this.localTimer = window.setTimeout(() => {
      if (net.live) {
        this.syncMode()
        return
      }
      if (this.visible) this.localBetting()
      else {
        this.model.phase = "idle"
        this.renderAll()
      }
    }, CRASH_POST_MS)
  }

  /* ── Round events ── */

  private onPhase(prev: Phase) {
    const m = this.model
    if (m.phase === "betting") {
      this.seenOut.clear()
      if (this.mine && this.mine.round !== m.round) this.mine = null
      if (this.queued) {
        this.queued = false
        this.placeBet()
      }
    }
    if (m.phase === "running" && prev !== "running") {
      // A pending bet the server never confirmed didn't make it in
      if (this.mine?.pending && m.mode === "remote" && !m.bets.some((b) => b.id === net.id)) {
        wallet.credit(this.mine.amount)
        this.mine = null
      }
    }
    if (m.phase === "crashed") {
      this.crashLine = CRASH_LINES[Math.floor(rand() * CRASH_LINES.length)]
      this.crashFlash = performance.now()
      this.settle()
      sfx.crash()
      if (prev === "running" && !reducedMotion.matches) {
        this.stage.classList.remove("is-crashing")
        void this.stage.offsetWidth
        this.stage.classList.add("is-crashing")
      }
    }
  }

  /** At the bust: pay an auto target the server honoured, or take the loss. */
  private settle() {
    const my = this.mine
    if (!my || my.settled || my.round !== this.model.round) return
    const id = this.model.mode === "remote" ? net.id : "me"
    const b = this.model.bets.find((x) => x.id === id)
    if (my.out == null && b?.out != null) this.cashedOut(b.out)
    if (my.out == null) {
      my.settled = true
      sfx.lose()
      toast(`Crashed at ${mult(this.model.point)}. ${money(my.amount)} sent to /dev/null.`, "loss")
    }
    this.renderControls()
  }

  private cashedOut(out: number) {
    const my = this.mine
    if (!my || my.out != null) return
    my.out = out
    my.settled = true
    const win = payout(my.amount, out)
    wallet.credit(win)
    sfx.cashout()
    toast(`Cashed out at ${mult(out)}: ${signed(win - my.amount)}`, "win")
    this.renderControls()
  }

  /* ── Actions ── */

  private readAuto() {
    const v = parseFloat(this.autoInput.value.replace(/[x×\s]/gi, ""))
    return Number.isFinite(v) && v >= 1.01 ? Math.min(100_000, Math.round(v * 100)) : 0
  }

  private onAction() {
    const m = this.model
    const my = this.mine
    if (m.phase === "running" && my && my.round === m.round && !my.settled && my.out == null) {
      this.cashOut()
      return
    }
    if (m.phase === "betting" && !(my && my.round === m.round)) {
      this.placeBet()
      return
    }
    if (m.phase !== "betting") {
      this.queued = !this.queued
      sfx.click()
      this.renderControls()
    }
  }

  private placeBet() {
    const m = this.model
    if (m.phase !== "betting") return
    if (!this.bet.valid) {
      toast(wallet.balance < this.bet.cents ? "Not enough balance for that bet." : "Enter a bet of at least $0.10.")
      return
    }
    const amount = this.bet.cents
    const auto = this.readAuto()
    if (!wallet.debit(amount)) return
    if (m.mode === "remote") {
      this.mine = { round: m.round, amount, auto, pending: true }
      net.send({ t: "bet", amount, auto })
    } else {
      this.mine = { round: m.round, amount, auto, pending: false }
      m.bets.push({ id: "me", name: prefs.name ?? "you", amount, auto })
      sfx.bet()
    }
    this.renderControls()
    this.renderTable()
  }

  private cashOut() {
    const m = this.model
    const my = this.mine
    if (!my || my.out != null || my.settled) return
    if (m.mode === "remote") {
      if (my.outSent) return
      my.outSent = true
      net.send({ t: "out" })
      this.renderControls()
      return
    }
    const now = crashAt(Date.now() - m.startedAt)
    if (now >= m.point) return
    const out = my.auto && now > my.auto ? my.auto : now
    const b = m.bets.find((x) => x.id === "me")
    if (b) b.out = out
    this.cashedOut(out)
    this.renderTable()
  }

  /* ── Rendering ── */

  private renderAll() {
    this.renderHistory()
    this.renderTable()
    this.renderControls()
    this.renderText(Date.now())
  }

  private renderControls() {
    const m = this.model
    const my = this.mine && this.mine.round === m.round ? this.mine : null
    const locked = !!my && !my.settled
    this.bet.disabled = locked
    this.autoInput.disabled = locked
    const a = this.action

    if (m.phase === "running" && my && !my.settled && my.out == null) {
      const cur = crashAt(Date.now() - m.startedAt)
      a.set(my.outSent ? "Cashing out…" : "Cash out", money(payout(my.amount, cur)), "cash")
      a.disabled = !!my.outSent
      return
    }
    if (m.phase === "betting" && my) {
      a.set(my.pending ? "Deploying…" : "Deployed", `${money(my.amount)} riding${my.auto ? ` · auto ${mult(my.auto)}` : ""}`, "wait")
      a.disabled = true
      return
    }
    if (m.phase === "betting") {
      a.set("Deploy", this.bet.valid ? `${money(this.bet.cents)} on this round` : "enter a bet", "go")
      a.disabled = !this.bet.valid
      return
    }
    if (my?.out != null && m.phase === "running") {
      a.set(this.queued ? "Queued" : "Queue next round", `out at ${mult(my.out)} · ${signed(payout(my.amount, my.out) - my.amount)}`, this.queued ? "wait" : "idle")
      a.disabled = false
      return
    }
    a.set(this.queued ? "Queued · cancel" : "Queue next round", this.queued ? "deploys when betting opens" : "this round is already running", this.queued ? "wait" : "idle")
    a.disabled = !this.queued && !this.bet.valid
  }

  private renderHistory() {
    this.historyEl.replaceChildren(
      ...this.history.slice(0, 12).map((p) =>
        h("span", { class: `cz-crash-chip ${p >= 1000 ? "is-moon" : p >= 200 ? "is-good" : "is-bad"}`, text: mult(p) }),
      ),
    )
  }

  private renderTable() {
    const m = this.model
    const others = m.mode === "remote" ? net.others("crash").length : 0
    const hasOthers = others > 0 || m.bets.some((b) => b.id !== (m.mode === "remote" ? net.id : "me"))
    this.table.hidden = !hasOthers
    if (!hasOthers) return
    const myId = m.mode === "remote" ? net.id : "me"
    const bets = [...m.bets].sort((a, b) => b.amount - a.amount)
    this.tableHead.textContent = `${bets.length} ${bets.length === 1 ? "bet" : "bets"} · ${others + 1} here`
    if (!bets.length) {
      this.tableBody.replaceChildren(h("li", { class: "cz-rail-empty", text: m.phase === "betting" ? "Waiting for bets…" : "Nobody's in this one." }))
      return
    }
    this.tableBody.replaceChildren(
      ...bets.map((b) => {
        const busted = m.phase === "crashed" && b.out == null
        return h(
          "li",
          { class: `cz-crash-bet${b.id === myId ? " is-me" : ""}${b.out != null ? " is-out" : ""}${busted ? " is-bust" : ""}` },
          avatar(b.name),
          h("span", { class: "cz-crash-bet-name", text: b.name }),
          h("span", { class: "cz-crash-bet-amt", text: moneyShort(b.amount) }),
          h("span", {
            class: "cz-crash-bet-res",
            text: b.out != null ? `${mult(b.out)}` : busted ? "bust" : m.phase === "running" ? "…" : "",
          }),
        )
      }),
    )
  }

  private renderText(now: number) {
    const m = this.model
    const stage = this.stage
    stage.dataset.phase = m.phase
    if (m.phase === "betting") {
      const left = Math.max(0, m.endsAt - now)
      this.multEl.textContent = `${(left / 1000).toFixed(1)}s`
      this.subEl.textContent = "compiling · next deploy in"
      ;(this.barEl.firstChild as HTMLElement).style.transform = `scaleX(${left / CRASH_BET_MS})`
    } else if (m.phase === "running") {
      const x = Math.exp((CRASH_RATE * Math.max(0, now - m.startedAt)) / 1000)
      this.multEl.textContent = `${(Math.floor(x * 100) / 100).toFixed(2)}×`
      this.subEl.textContent = flavour(x)
    } else if (m.phase === "crashed") {
      this.multEl.textContent = mult(m.point)
      this.subEl.textContent = this.crashLine
    } else {
      this.multEl.textContent = "1.00×"
      this.subEl.textContent = net.live || net.status === "connecting" ? "joining the lobby…" : "idle"
    }
  }

  private resize() {
    const r = this.stage.getBoundingClientRect()
    this.dpr = Math.min(2, window.devicePixelRatio || 1)
    this.w = r.width
    this.hgt = r.height
    this.canvas.width = Math.round(r.width * this.dpr)
    this.canvas.height = Math.round(r.height * this.dpr)
    const css = getComputedStyle(this.stage)
    this.colors = {
      lime: css.getPropertyValue("--cz-lime").trim() || this.colors.lime,
      coral: css.getPropertyValue("--cz-coral").trim() || this.colors.coral,
    }
    this.draw(Date.now())
  }

  private loop = () => {
    cancelAnimationFrame(this.raf)
    const frame = () => {
      if (!this.visible) return
      const now = Date.now()
      const m = this.model
      // Auto cash-out: ask the moment our own curve crosses the target
      const my = this.mine
      if (m.phase === "running" && my && my.auto && my.out == null && !my.settled && my.round === m.round) {
        if (crashAt(now - m.startedAt) >= my.auto) this.cashOut()
      }
      this.renderText(now)
      if (m.phase === "running" && my && my.out == null && !my.settled) this.renderControls()
      this.draw(now)
      this.raf = requestAnimationFrame(frame)
    }
    this.raf = requestAnimationFrame(frame)
  }

  private draw(now: number) {
    const { ctx, dpr, w, hgt: H } = this
    if (!w || !H) return
    const m = this.model
    const { lime, coral } = this.colors
    const grid = "rgba(247,247,245,0.06)"
    const label = "rgba(247,247,245,0.38)"

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, H)

    // Elapsed time and height of the curve's head
    let t = 0
    if (m.phase === "running") t = Math.max(0, now - m.startedAt) / 1000
    if (m.phase === "crashed") t = crashMsTo(m.point) / 1000
    const x = Math.exp(CRASH_RATE * t)

    const targetX = m.phase === "running" || m.phase === "crashed" ? Math.max(8, t * 1.18 + 0.5) : 8
    const targetY = m.phase === "running" || m.phase === "crashed" ? Math.max(1.8, 1 + (x - 1) * 1.22) : 1.8
    const ease = m.phase === "betting" || m.phase === "idle" ? 0.08 : 0.25
    this.xMax += (targetX - this.xMax) * ease
    this.yMax += (targetY - this.yMax) * ease

    const padL = 52
    const padR = 22
    const padT = 56
    const padB = 34
    const gw = w - padL - padR
    const gh = H - padT - padB
    const px = (s: number) => padL + (s / this.xMax) * gw
    const py = (v: number) => padT + gh - ((v - 1) / (this.yMax - 1)) * gh

    // Grid + labels
    ctx.font = "11px 'Roboto Mono Casino', 'Roboto Mono', ui-monospace, monospace"
    ctx.lineWidth = 1
    ctx.strokeStyle = grid
    ctx.fillStyle = label
    ctx.textAlign = "right"
    ctx.textBaseline = "middle"
    const yStep = niceStep(this.yMax - 1, 4)
    for (let v = 1; v <= this.yMax + 1e-9; v += yStep) {
      const yy = Math.round(py(v)) + 0.5
      ctx.beginPath()
      ctx.moveTo(padL, yy)
      ctx.lineTo(w - padR, yy)
      ctx.stroke()
      ctx.fillText(`${v >= 10 ? v.toFixed(0) : v.toFixed(yStep < 0.5 ? 1 : 1)}×`, padL - 10, yy)
    }
    ctx.textAlign = "center"
    ctx.textBaseline = "top"
    const xStep = niceStep(this.xMax, 5)
    for (let s = 0; s <= this.xMax + 1e-9; s += xStep) {
      const xx = Math.round(px(s)) + 0.5
      ctx.beginPath()
      ctx.moveTo(xx, padT)
      ctx.lineTo(xx, padT + gh)
      ctx.stroke()
      ctx.fillText(`${Math.round(s)}s`, xx, padT + gh + 10)
    }

    if (m.phase === "running" || m.phase === "crashed") {
      const crashed = m.phase === "crashed"
      const color = crashed ? coral : lime
      const steps = Math.max(24, Math.min(160, Math.ceil(t * 12)))
      const pts: [number, number][] = []
      for (let i = 0; i <= steps; i++) {
        const s = (t * i) / steps
        pts.push([px(s), py(Math.exp(CRASH_RATE * s))])
      }

      // Fill
      const g = ctx.createLinearGradient(0, padT, 0, padT + gh)
      g.addColorStop(0, hexA(color, crashed ? 0.16 : 0.26))
      g.addColorStop(1, hexA(color, 0))
      ctx.beginPath()
      ctx.moveTo(pts[0][0], padT + gh)
      for (const [a, b] of pts) ctx.lineTo(a, b)
      ctx.lineTo(pts[pts.length - 1][0], padT + gh)
      ctx.closePath()
      ctx.fillStyle = g
      ctx.fill()

      // Line, with a soft glow
      ctx.beginPath()
      pts.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b)))
      ctx.lineJoin = "round"
      ctx.lineCap = "round"
      ctx.strokeStyle = color
      ctx.shadowColor = hexA(color, 0.6)
      ctx.shadowBlur = 14
      ctx.lineWidth = 3
      ctx.stroke()
      ctx.shadowBlur = 0

      // Head
      const [hx, hy] = pts[pts.length - 1]
      if (!crashed) {
        const pulse = (now % 1000) / 1000
        ctx.beginPath()
        ctx.arc(hx, hy, 5 + pulse * 12, 0, Math.PI * 2)
        ctx.strokeStyle = hexA(color, 0.5 * (1 - pulse))
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(hx, hy, 5, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
      } else {
        // A burst where it died
        const age = Math.min(1, (performance.now() - this.crashFlash) / 700)
        ctx.beginPath()
        ctx.arc(hx, hy, 6 + age * 28, 0, Math.PI * 2)
        ctx.strokeStyle = hexA(coral, 0.7 * (1 - age))
        ctx.lineWidth = 2.5
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(hx, hy, 5, 0, Math.PI * 2)
        ctx.fillStyle = coral
        ctx.fill()
      }

      // Cash-outs, pinned where they happened
      const myId = m.mode === "remote" ? net.id : "me"
      const outs = m.bets.filter((b) => b.out != null).sort((a, b) => a.out! - b.out!)
      let lastX = -Infinity
      let lane = 0
      for (const b of outs) {
        const bs = crashMsTo(b.out!) / 1000
        if (bs > t + 0.05) continue
        const bx = px(bs)
        const by = py(b.out! / 100)
        if (!this.seenOut.has(b.id)) this.seenOut.set(b.id, performance.now())
        const age = Math.min(1, (performance.now() - this.seenOut.get(b.id)!) / 350)
        lane = bx - lastX < 90 ? (lane + 1) % 3 : 0
        lastX = bx
        const c = b.id === myId ? lime : dotColor(b.name)
        ctx.globalAlpha = age
        ctx.beginPath()
        ctx.arc(bx, by, 4, 0, Math.PI * 2)
        ctx.fillStyle = "#0a0a0a"
        ctx.fill()
        ctx.lineWidth = 2
        ctx.strokeStyle = c
        ctx.stroke()
        const text = `${b.id === myId ? "you" : b.name} ${mult(b.out!)}`
        ctx.font = "11px 'Roboto Mono Casino', 'Roboto Mono', ui-monospace, monospace"
        const tw = ctx.measureText(text).width
        const lx = Math.min(w - padR - tw - 12, Math.max(padL, bx - tw / 2 - 6))
        const ly = by - 30 - lane * 22 - (1 - age) * 8
        ctx.beginPath()
        ctx.moveTo(bx, by - 5)
        ctx.lineTo(bx, ly + 18)
        ctx.strokeStyle = hexA(c, 0.35)
        ctx.lineWidth = 1
        ctx.stroke()
        roundRect(ctx, lx, ly, tw + 12, 18, 5)
        ctx.fillStyle = "rgba(16,16,16,0.92)"
        ctx.fill()
        ctx.strokeStyle = hexA(c, 0.5)
        ctx.stroke()
        ctx.fillStyle = c
        ctx.textAlign = "left"
        ctx.textBaseline = "middle"
        ctx.fillText(text, lx + 6, ly + 9.5)
        ctx.globalAlpha = 1
      }
    } else {
      // Idle line along 1.00×, breathing while the next build compiles
      const yy = py(1)
      const phase = (now % 1600) / 1600
      const g = ctx.createLinearGradient(padL, 0, w - padR, 0)
      g.addColorStop(Math.max(0, phase - 0.25), hexA(lime, 0.05))
      g.addColorStop(phase, hexA(lime, 0.55))
      g.addColorStop(Math.min(1, phase + 0.25), hexA(lime, 0.05))
      ctx.strokeStyle = g
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(padL, yy)
      ctx.lineTo(w - padR, yy)
      ctx.stroke()
    }

    // The frame after a bust flashes the whole chart red, briefly
    if (m.phase === "crashed" && !reducedMotion.matches) {
      const age = (performance.now() - this.crashFlash) / 400
      if (age < 1) {
        ctx.fillStyle = hexA(coral, 0.12 * (1 - age))
        ctx.fillRect(0, 0, w, H)
      }
    }
  }
}

function niceStep(range: number, target: number) {
  const raw = range / target
  const pow = 10 ** Math.floor(Math.log10(raw))
  for (const n of [1, 2, 2.5, 5, 10]) if (n * pow >= raw) return n * pow
  return 10 * pow
}

function hexA(hex: string, a: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
