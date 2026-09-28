/* ── Casino lobby ──
   One Worker, one Durable Object. Every visitor's socket lands on the same
   object (idFromName("global")), which keeps the player list, relays plays
   from the browser-run games, and referees the shared crash rounds.

   Built for the Workers free plan: sockets use the hibernation API, so the
   object sleeps between messages and costs nothing while nobody talks, and
   crash rounds are driven by storage alarms rather than timers (a pending
   setTimeout would hold the object awake). Anything that must survive a
   hibernation lives in storage or in each socket's attachment. */

import { DurableObject } from "cloudflare:workers"
import {
  CRASH_BET_MS,
  CRASH_POST_MS,
  PROTOCOL,
  checkName,
  cleanPlay,
  crashAt,
  crashMsTo,
  crashPoint,
  isCents,
  isPlace,
  randomName,
  type ClientMsg,
  type CrashBet,
  type CrashState,
  type GameId,
  type Place,
  type Player,
  type ServerMsg,
} from "./protocol"

export interface Env {
  LOBBY: DurableObjectNamespace<Lobby>
  /** Comma-separated origins allowed to connect. `*` in a host is a wildcard. */
  ALLOWED_ORIGINS: string
}

const MAX_SOCKETS = 250
const MAX_MSG_BYTES = 1024
const HISTORY = 24

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === "/health") return new Response("ok")
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 })
    if (req.headers.get("Upgrade") !== "websocket")
      return new Response("expected a websocket", { status: 426 })
    if (!originAllowed(req.headers.get("Origin"), env.ALLOWED_ORIGINS))
      return new Response("forbidden", { status: 403 })

    const stub = env.LOBBY.get(env.LOBBY.idFromName("global"))
    return stub.fetch(req)
  },
} satisfies ExportedHandler<Env>

function originAllowed(origin: string | null, list: string) {
  if (!origin) return false
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((pattern) => {
      const re = new RegExp(
        "^" +
          pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") +
          "$",
      )
      return re.test(origin)
    })
}

/** What each socket carries through hibernation. */
interface Seat {
  id: string
  name: string
  at: Place
  bal: number
  /** False until the client's hello, so half-open sockets never show up. */
  ready: boolean
}

interface Round {
  id: string
  phase: "betting" | "running" | "crashed"
  endsAt: number // betting only
  startedAt: number // running / crashed
  point: number // ×100; secret until it happens
  bets: Record<string, CrashBet>
}

const rand = () => {
  const b = new Uint32Array(1)
  crypto.getRandomValues(b)
  return b[0] / 2 ** 32
}
const hex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

export class Lobby extends DurableObject<Env> {
  private round: Round | null | undefined // undefined = not loaded yet
  private history: number[] | undefined
  // Per-socket message budget. Held in memory only: a hibernation resets it,
  // which is fine, since hibernating means the socket has been quiet.
  private buckets = new WeakMap<WebSocket, { tokens: number; at: number }>()

  async fetch(): Promise<Response> {
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS)
      return new Response("the table is full", { status: 503 })

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)
    const seat: Seat = { id: hex(6), name: "", at: "lobby", bal: 0, ready: false }
    server.serializeAttachment(seat)
    return new Response(null, { status: 101, webSocket: client })
  }

  /* ── Socket events ── */

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > MAX_MSG_BYTES) return
    if (!this.spend(ws)) return
    let msg: ClientMsg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (!msg || typeof msg !== "object") return
    const seat = ws.deserializeAttachment() as Seat

    if (msg.t === "sync") {
      if (typeof msg.c === "number")
        this.send(ws, { t: "sync", c: msg.c, s: Date.now() })
      return
    }

    if (msg.t === "hi") {
      if (seat.ready || msg.v !== PROTOCOL) return
      const checked = checkName(msg.name)
      seat.name = checked.ok ? checked.name : randomName(rand)
      seat.at = isPlace(msg.at) ? msg.at : "lobby"
      seat.bal = isCents(msg.bal) ? msg.bal : 0
      seat.ready = true
      ws.serializeAttachment(seat)
      await this.ensureLoaded()
      this.send(ws, {
        t: "welcome",
        id: seat.id,
        name: seat.name,
        renamed: !checked.ok,
        now: Date.now(),
        players: this.players(),
        crash: this.crashState(),
        history: this.history!,
      })
      this.broadcast({ t: "join", p: toPlayer(seat) }, ws)
      if (seat.at === "crash") await this.wakeCrash()
      return
    }

    if (!seat.ready) return

    switch (msg.t) {
      case "at": {
        if (!isPlace(msg.at) || msg.at === seat.at) return
        seat.at = msg.at
        ws.serializeAttachment(seat)
        this.broadcast({ t: "update", id: seat.id, at: seat.at }, ws)
        if (seat.at === "crash") await this.wakeCrash()
        return
      }
      case "name": {
        const checked = checkName(msg.name)
        if (checked.ok) {
          seat.name = checked.name
          ws.serializeAttachment(seat)
          this.broadcast({ t: "update", id: seat.id, name: seat.name }, ws)
        }
        this.send(ws, { t: "name", name: seat.name, renamed: !checked.ok })
        return
      }
      case "bal": {
        if (!Number.isInteger(msg.bal) || msg.bal < 0 || msg.bal === seat.bal)
          return
        seat.bal = Math.min(msg.bal, Number.MAX_SAFE_INTEGER)
        ws.serializeAttachment(seat)
        this.broadcast({ t: "update", id: seat.id, bal: seat.bal }, ws)
        return
      }
      case "bet":
        return this.crashBet(ws, seat, msg.amount, msg.auto)
      case "out":
        return this.crashOut(ws, seat)
      case "play": {
        const game = msg.game as GameId
        if (game === "crash" || !isPlace(game) || game !== seat.at) return
        const d = cleanPlay(game, msg.d)
        if (!d) return
        this.broadcast({ t: "play", id: seat.id, name: seat.name, game, d }, ws)
        return
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.depart(ws)
    try {
      ws.close(code === 1005 ? 1000 : code, reason)
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket) {
    this.depart(ws)
  }

  private depart(ws: WebSocket) {
    const seat = ws.deserializeAttachment() as Seat | null
    if (seat?.ready) this.broadcast({ t: "leave", id: seat.id }, ws)
  }

  /* ── Crash rounds ──
     betting (7s) → running (until the bust point) → crashed (3.2s) → betting…
     Each hand-off is an alarm. The loop stops at the end of a round when
     nobody is at the crash table, and restarts when someone sits down. */

  private async ensureLoaded() {
    if (this.round === undefined) {
      this.round = (await this.ctx.storage.get<Round>("round")) ?? null
      this.history = (await this.ctx.storage.get<number[]>("history")) ?? []
    }
  }

  private async save() {
    if (this.round) await this.ctx.storage.put("round", this.round)
    else await this.ctx.storage.delete("round")
  }

  private atCrash() {
    return this.seats().some((s) => s.at === "crash")
  }

  private async wakeCrash() {
    await this.ensureLoaded()
    if (this.round) return
    await this.startBetting()
  }

  private async startBetting() {
    const now = Date.now()
    this.round = {
      id: hex(3),
      phase: "betting",
      endsAt: now + CRASH_BET_MS,
      startedAt: 0,
      point: crashPoint(rand()),
      bets: {},
    }
    await this.save()
    await this.ctx.storage.setAlarm(this.round.endsAt)
    this.broadcast({ t: "crash", state: this.crashState() })
  }

  async alarm() {
    await this.ensureLoaded()
    const r = this.round
    if (!r) return
    const now = Date.now()

    if (r.phase === "betting") {
      r.phase = "running"
      r.startedAt = now
      await this.save()
      await this.ctx.storage.setAlarm(now + crashMsTo(r.point))
      this.broadcast({ t: "crash", state: this.crashState() })
      return
    }

    if (r.phase === "running") {
      r.phase = "crashed"
      // Anyone whose auto target sat below the bust point is out at it, even
      // if their own client never got the request in.
      for (const bet of Object.values(r.bets)) {
        if (bet.out == null && bet.auto > 0 && bet.auto < r.point) bet.out = bet.auto
      }
      this.history = [r.point, ...this.history!].slice(0, HISTORY)
      await this.ctx.storage.put("history", this.history)
      await this.save()
      await this.ctx.storage.setAlarm(now + CRASH_POST_MS)
      this.broadcast({ t: "crash", state: this.crashState() })
      return
    }

    // crashed → next round, or rest
    if (this.atCrash()) {
      await this.startBetting()
    } else {
      this.round = null
      await this.save()
      this.broadcast({ t: "crash", state: { phase: "idle" } })
    }
  }

  private async crashBet(ws: WebSocket, seat: Seat, amount: unknown, auto: unknown) {
    await this.ensureLoaded()
    const r = this.round
    const reject = (why: string) => this.send(ws, { t: "reject", what: "bet", why })
    if (!r || r.phase !== "betting") return reject("Betting is closed.")
    if (r.bets[seat.id]) return reject("You're already in this round.")
    if (!isCents(amount)) return reject("That's not a bet.")
    const target =
      Number.isInteger(auto) && (auto as number) >= 101 && (auto as number) <= 100_000
        ? (auto as number)
        : 0
    const bet: CrashBet = { id: seat.id, name: seat.name, amount, auto: target }
    r.bets[seat.id] = bet
    await this.save()
    this.broadcast({ t: "cbet", round: r.id, bet })
  }

  private async crashOut(ws: WebSocket, seat: Seat) {
    await this.ensureLoaded()
    const r = this.round
    const reject = (why: string) => this.send(ws, { t: "reject", what: "out", why })
    const bet = r?.bets[seat.id]
    if (!r || !bet) return reject("You're not in this round.")
    if (bet.out != null) return reject("Already cashed out.")
    if (r.phase !== "running") return reject("Too late.")
    let m = crashAt(Date.now() - r.startedAt)
    if (m >= r.point) return reject("Too late.")
    if (bet.auto > 0 && m > bet.auto) m = bet.auto
    bet.out = m
    await this.save()
    this.broadcast({ t: "cout", round: r.id, id: seat.id, out: m })
  }

  /** The round as clients may see it: the bust point only once it's happened. */
  private crashState(): CrashState {
    const r = this.round
    if (!r) return { phase: "idle" }
    const bets = Object.values(r.bets)
    if (r.phase === "betting")
      return { phase: "betting", round: r.id, endsAt: r.endsAt, bets }
    if (r.phase === "running")
      return { phase: "running", round: r.id, startedAt: r.startedAt, bets }
    return {
      phase: "crashed",
      round: r.id,
      startedAt: r.startedAt,
      point: r.point,
      bets,
    }
  }

  /* ── Plumbing ── */

  private seats(): Seat[] {
    const out: Seat[] = []
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Seat | null
      if (s?.ready) out.push(s)
    }
    return out
  }

  private players(): Player[] {
    return this.seats().map(toPlayer)
  }

  /** 20 messages a second sustained, bursts of 40. */
  private spend(ws: WebSocket) {
    const now = Date.now()
    const b = this.buckets.get(ws) ?? { tokens: 40, at: now }
    b.tokens = Math.min(40, b.tokens + ((now - b.at) / 1000) * 20)
    b.at = now
    if (b.tokens < 1) {
      this.buckets.set(ws, b)
      return false
    }
    b.tokens -= 1
    this.buckets.set(ws, b)
    return true
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      /* closing */
    }
  }

  private broadcast(msg: ServerMsg, except?: WebSocket) {
    const data = JSON.stringify(msg)
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue
      const s = ws.deserializeAttachment() as Seat | null
      if (!s?.ready) continue
      try {
        ws.send(data)
      } catch {
        /* closing */
      }
    }
  }
}

const toPlayer = (s: Seat): Player => ({ id: s.id, name: s.name, at: s.at, bal: s.bal })
