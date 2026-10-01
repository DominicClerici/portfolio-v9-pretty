/* ── Casino wire protocol ──
   Shared by the Worker (multiplayer/src/lobby.ts) and the site's casino
   (src/scripts/casino/). Anything both ends must agree on lives here: the
   message shapes, the crash curve, the payload rules for relayed plays, and
   the name filter, so a name the dialog accepts is one the server keeps.

   Money is integer cents everywhere. Multipliers on the wire are ×100
   integers (2.35× is 235) so nothing is ever rounded twice. Balances are the
   visitor's own (localStorage); the server only relays and referees rounds. */

export const PROTOCOL = 1

export type GameId = "crash" | "bigo" | "merge" | "plinko"
export type Place = GameId | "lobby"
export const GAMES: readonly GameId[] = ["crash", "bigo", "merge", "plinko"]
const PLACES: readonly string[] = [...GAMES, "lobby"]
export const isPlace = (v: unknown): v is Place =>
  typeof v === "string" && PLACES.includes(v)

/** Largest stake anything will carry: $10M, comfortably past any balance. */
export const MAX_CENTS = 1_000_000_000

export const isCents = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_CENTS

/* ── Crash ──
   One curve for every client: m(t) = e^(RATE·t). 2× at ~7.7s, 10× at ~25.6s.
   The server only ever sends phase changes; clients draw the curve from the
   shared start time, so nothing streams while a round runs. */

export const CRASH_RATE = 0.09 // per second
export const CRASH_BET_MS = 7000
export const CRASH_POST_MS = 3200
/** 1000× — the curve is still on screen at 77s, which is plenty. */
export const CRASH_MAX = 100_000

/** Multiplier (×100, floored) `ms` into a running round. */
export const crashAt = (ms: number) =>
  Math.floor(100 * Math.exp((CRASH_RATE * Math.max(0, ms)) / 1000))

/** Milliseconds for the curve to reach `x100`. */
export const crashMsTo = (x100: number) =>
  (Math.log(x100 / 100) / CRASH_RATE) * 1000

/** Bust point from a uniform u ∈ [0,1): P(point ≥ x) = 0.97 / x, so every
    cash-out target returns 97% over time. About 4% of rounds die at 1.00×
    (everything that would land in [1.00, 1.01)). */
export const crashPoint = (u: number) =>
  Math.min(CRASH_MAX, Math.max(100, Math.floor(97 / (1 - u))))

export interface CrashBet {
  id: string
  name: string
  amount: number
  /** Auto cash-out target ×100, 0 for none. */
  auto: number
  /** Cashed-out multiplier ×100, set once they're out. */
  out?: number
}

export type CrashState =
  | { phase: "idle" }
  | { phase: "betting"; round: string; endsAt: number; bets: CrashBet[] }
  | { phase: "running"; round: string; startedAt: number; bets: CrashBet[] }
  | {
      phase: "crashed"
      round: string
      startedAt: number
      point: number
      bets: CrashBet[]
    }

/* ── Presence ── */

export interface Player {
  id: string
  name: string
  at: Place
  /** Self-reported balance in cents: this is a leaderboard of honour. */
  bal: number
}

/* ── Relayed plays ──
   Big O, merge roulette and plinko run in each visitor's browser; the
   server just forwards a summary to everyone else at the same table. Each
   payload is rebuilt field by field from these rules, so nothing but the
   listed numbers and flags is ever passed along. */

export type BigOPlay = {
  s: "deal" | "win" | "bust" | "cash"
  bet: number
  card: number // 0–12
  suit: number // 0–3
  mult: number // ×100
  n: number // correct calls so far
}
export type MergePlay = {
  o: number // stake on ours
  t: number // stake on theirs
  c: number // stake on conflict
  r: "o" | "t" | "c"
  ms: number // spin length, so watchers reveal it when the spinner does
  win: number
}
export type PlinkoPlay = {
  bet: number
  rows: number
  risk: number // 0 low, 1 medium, 2 high
  path: number // bit i set = bounced right on row i
  mult: number // ×100
}
export type PlayData = BigOPlay | MergePlay | PlinkoPlay

const int = (v: unknown, lo: number, hi: number) =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi
    ? (v as number)
    : null
const cents = (v: unknown, allowZero = false) =>
  int(v, allowZero ? 0 : 1, MAX_CENTS)

export const PLINKO_ROWS = [8, 12, 16] as const

export function cleanPlay(game: GameId, d: any): PlayData | null {
  if (!d || typeof d !== "object") return null
  if (game === "bigo") {
    const s = ["deal", "win", "bust", "cash"].includes(d.s) ? d.s : null
    const bet = cents(d.bet)
    const card = int(d.card, 0, 12)
    const suit = int(d.suit, 0, 3)
    const mult = int(d.mult, 0, 1e9)
    const n = int(d.n, 0, 10_000)
    if (s == null || bet == null || card == null || suit == null) return null
    if (mult == null || n == null) return null
    return { s, bet, card, suit, mult, n }
  }
  if (game === "merge") {
    const o = cents(d.o, true)
    const t = cents(d.t, true)
    const c = cents(d.c, true)
    const r = ["o", "t", "c"].includes(d.r) ? d.r : null
    const ms = int(d.ms, 0, 15_000)
    const win = cents(d.win, true)
    if (o == null || t == null || c == null || r == null) return null
    if (ms == null || win == null || o + t + c === 0) return null
    return { o, t, c, r, ms, win }
  }
  if (game === "plinko") {
    const bet = cents(d.bet)
    const rows = PLINKO_ROWS.includes(d.rows) ? (d.rows as number) : null
    const risk = int(d.risk, 0, 2)
    const path = rows == null ? null : int(d.path, 0, 2 ** rows - 1)
    const mult = int(d.mult, 0, 1e7)
    if (bet == null || rows == null || risk == null) return null
    if (path == null || mult == null) return null
    return { bet, rows, risk, path, mult }
  }
  return null
}

/* ── Messages ── */

export type ClientMsg =
  | { t: "hi"; v: number; name: string; at: Place; bal: number }
  | { t: "at"; at: Place }
  | { t: "name"; name: string }
  | { t: "bal"; bal: number }
  | { t: "sync"; c: number }
  | { t: "bet"; amount: number; auto: number }
  | { t: "out" }
  | { t: "play"; game: GameId; d: PlayData }

export type ServerMsg =
  | {
      t: "welcome"
      id: string
      name: string
      renamed: boolean
      now: number
      players: Player[]
      crash: CrashState
      history: number[]
    }
  | { t: "sync"; c: number; s: number }
  | { t: "join"; p: Player }
  | { t: "leave"; id: string }
  | { t: "update"; id: string; name?: string; at?: Place; bal?: number }
  | { t: "name"; name: string; renamed: boolean }
  | { t: "crash"; state: CrashState }
  | { t: "cbet"; round: string; bet: CrashBet }
  | { t: "cout"; round: string; id: string; out: number }
  | { t: "reject"; what: "bet" | "out"; why: string }
  | { t: "play"; id: string; name: string; game: GameId; d: PlayData }

/* ── Names ──
   Letters, digits and _ . - only, 2–20 long. The filter is a courtesy, not a
   fortress: a folded, de-leeted copy of the name is checked against a short
   list of things nobody needs to see on a portfolio. Words that hide inside
   innocent ones (the "ass" in "class") only match as whole tokens. The
   stems matched anywhere will still catch the odd innocent name (hello,
   Scunthorpe); on a leaderboard that's the right side to err on. */

export const NAME_MIN = 2
export const NAME_MAX = 20
const NAME_RE = /^[A-Za-z0-9_.-]+$/

const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "l",
}

// Checked anywhere in the folded name. Only stems that don't turn up inside
// ordinary words ("coon" is in raccoon, "rape" in grape; those go below).
const BLOCK_ANY = [
  "nigg", "niga", "faggot", "fagot", "retard", "kike", "chink", "gook",
  "wetback", "tranny", "raghead", "towelhead", "beaner", "fuck", "fuk",
  "phuck", "shit", "cunt", "bitch", "whore", "slut", "pussy", "penis",
  "vagina", "dildo", "jizz", "blowjob", "handjob", "porn", "hentai", "nazi",
  "hitler", "kkk", "molest", "incest", "asshole", "arsehole", "bastard",
  "twat", "killyourself", "cumshot", "testicle", "orgasm", "milf",
]
// Checked only as whole tokens (split on _ . -, edge digits dropped).
const BLOCK_WORD = [
  "ass", "arse", "fag", "spic", "coon", "cum", "sex", "anal", "anus", "tit",
  "tits", "boob", "boobs", "dick", "cock", "negro", "piss", "rape", "rapist",
  "pedo", "paedo", "semen", "wank", "boner", "horny", "kys", "heil", "nude",
]

const fold = (s: string) =>
  s
    .toLowerCase()
    .split("")
    .map((c) => LEET[c] ?? c)
    .join("")

export function isClean(name: string): boolean {
  const folded = fold(name)
  const squashed = folded.replace(/[^a-z]/g, "")
  if (BLOCK_ANY.some((w) => squashed.includes(w))) return false
  const tokens = name
    .toLowerCase()
    .split(/[_.-]+/)
    .map((t) => fold(t.replace(/^\d+|\d+$/g, "")))
  return !tokens.some((t) => BLOCK_WORD.includes(t))
}

export type NameCheck = { ok: true; name: string } | { ok: false; why: string }

export function checkName(raw: unknown): NameCheck {
  if (typeof raw !== "string") return { ok: false, why: "Pick a name." }
  const name = raw.trim()
  if (name.length < NAME_MIN)
    return { ok: false, why: `At least ${NAME_MIN} characters.` }
  if (name.length > NAME_MAX)
    return { ok: false, why: `${NAME_MAX} characters, tops.` }
  if (!NAME_RE.test(name))
    return { ok: false, why: "Letters, numbers, _ . - only." }
  if (!/[A-Za-z0-9]/.test(name))
    return { ok: false, why: "Needs a letter or a number." }
  if (!isClean(name)) return { ok: false, why: "Let's keep it friendly." }
  return { ok: true, name }
}

const ADJ = [
  "null", "async", "lazy", "sudo", "rogue", "dangling", "mutable", "volatile",
  "stale", "greedy", "atomic", "orphan", "headless", "detached", "zombie",
  "cached", "legacy", "hotfix", "unsafe", "static", "sparse", "nested",
]
const NOUN = [
  "pointer", "otter", "gopher", "ferret", "daemon", "goblin", "wizard",
  "monad", "lambda", "kernel", "thread", "closure", "panda", "crab", "sloth",
  "badger", "heap", "mutex", "raccoon", "yak", "cursor", "socket",
]

/** A handle like `dangling_otter42`, always a valid name. */
export function randomName(rand: () => number = Math.random): string {
  const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)]
  const n = Math.floor(rand() * 100)
  return `${pick(ADJ)}_${pick(NOUN)}${n}`.slice(0, NAME_MAX)
}
