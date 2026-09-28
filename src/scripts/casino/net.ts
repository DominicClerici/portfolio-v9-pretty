/* ── Lobby connection ──
   One socket to the casino Worker (multiplayer/), opened while the dialog is
   up and closed with it. Without PUBLIC_CASINO_WS, or while the socket is
   down, the casino runs solo: every game works offline, and the multiplayer
   bits simply stay hidden because nobody else is there to show.

   Server times are converted with a clock offset measured NTP-style from a
   few sync round trips (best of the lowest-latency samples), so everyone's
   crash curve starts on the same frame to within a few milliseconds. */

import {
  PROTOCOL,
  type ClientMsg,
  type Place,
  type Player,
  type ServerMsg,
} from "../../../multiplayer/src/protocol"
import { PUBLIC_CASINO_WS } from "astro:env/client"

export type NetStatus = "off" | "connecting" | "live" | "down"

type Handler = (msg: ServerMsg) => void

const URL_ = PUBLIC_CASINO_WS?.trim()

class Net {
  status: NetStatus = URL_ ? "down" : "off"
  id: string | null = null
  players = new Map<string, Player>()
  /** serverTime − localTime, in ms. */
  offset = 0
  rtt = 0

  private ws: WebSocket | null = null
  private handlers = new Set<Handler>()
  private statusListeners = new Set<(s: NetStatus) => void>()
  private wanted = false
  private retry = 0
  private retryTimer = 0
  private syncTimer = 0
  private samples: { rtt: number; offset: number }[] = []
  private hello: () => ClientMsg = () => ({
    t: "hi",
    v: PROTOCOL,
    name: "",
    at: "lobby",
    bal: 0,
  })

  get enabled() {
    return !!URL_
  }

  get live() {
    return this.status === "live"
  }

  /** Server epoch ms → local performance-free epoch ms. */
  toLocal(serverMs: number) {
    return serverMs - this.offset
  }

  serverNow() {
    return Date.now() + this.offset
  }

  others(at?: Place): Player[] {
    const out: Player[] = []
    for (const p of this.players.values()) {
      if (p.id === this.id) continue
      if (at && p.at !== at) continue
      out.push(p)
    }
    return out
  }

  on(h: Handler) {
    this.handlers.add(h)
    return () => this.handlers.delete(h)
  }

  onStatus(l: (s: NetStatus) => void) {
    this.statusListeners.add(l)
    return () => this.statusListeners.delete(l)
  }

  connect(hello: () => ClientMsg) {
    this.hello = hello
    if (!URL_) return
    this.wanted = true
    if (!this.ws) this.open()
  }

  disconnect() {
    this.wanted = false
    clearTimeout(this.retryTimer)
    clearInterval(this.syncTimer)
    const ws = this.ws
    this.ws = null
    ws?.close(1000)
    this.reset("down")
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN && this.live)
      this.ws.send(JSON.stringify(msg))
  }

  private open() {
    this.setStatus("connecting")
    let ws: WebSocket
    try {
      ws = new WebSocket(URL_!)
    } catch {
      this.scheduleRetry()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      ws.send(JSON.stringify(this.hello()))
      this.samples = []
      this.sync()
    }
    ws.onmessage = (e) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      this.receive(msg)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      clearInterval(this.syncTimer)
      this.reset("down")
      if (this.wanted) this.scheduleRetry()
    }
    ws.onerror = () => ws.close()
  }

  private scheduleRetry() {
    clearTimeout(this.retryTimer)
    const wait = [1000, 2000, 4000, 8000, 15000, 30000][Math.min(this.retry, 5)]
    this.retry++
    this.retryTimer = window.setTimeout(() => {
      if (this.wanted && !this.ws) this.open()
    }, wait)
  }

  private reset(status: NetStatus) {
    this.id = null
    this.players.clear()
    this.setStatus(status)
  }

  private setStatus(s: NetStatus) {
    if (s === this.status) return
    this.status = s
    this.statusListeners.forEach((l) => l(s))
  }

  private sync() {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ t: "sync", c: Date.now() } satisfies ClientMsg))
  }

  private receive(msg: ServerMsg) {
    switch (msg.t) {
      case "sync": {
        const now = Date.now()
        const rtt = now - msg.c
        this.samples.push({ rtt, offset: msg.s - (msg.c + rtt / 2) })
        if (this.samples.length > 8) this.samples.shift()
        const best = [...this.samples].sort((a, b) => a.rtt - b.rtt)[0]
        this.offset = best.offset
        this.rtt = best.rtt
        // A quick burst at connect, then a slow keep-alive
        if (this.samples.length < 4) window.setTimeout(() => this.sync(), 150)
        return
      }
      case "welcome":
        this.id = msg.id
        this.retry = 0
        this.players = new Map(msg.players.map((p) => [p.id, p]))
        this.offset = this.samples.length ? this.offset : msg.now - Date.now()
        clearInterval(this.syncTimer)
        this.syncTimer = window.setInterval(() => this.sync(), 25_000)
        this.setStatus("live")
        break
      case "join":
        this.players.set(msg.p.id, msg.p)
        break
      case "name": {
        const me = this.id ? this.players.get(this.id) : null
        if (me) me.name = msg.name
        break
      }
      case "leave":
        this.players.delete(msg.id)
        break
      case "update": {
        const p = this.players.get(msg.id)
        if (p) {
          if (msg.name != null) p.name = msg.name
          if (msg.at != null) p.at = msg.at
          if (msg.bal != null) p.bal = msg.bal
        }
        break
      }
    }
    this.handlers.forEach((h) => h(msg))
  }
}

export const net = new Net()
