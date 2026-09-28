/* ── /dev/null casino ──
   The easter egg behind the site's >_ prompts. Loaded on first click (see
   trigger.ts), so none of this is paid for by visitors who never find it.

   A native modal <dialog> holding a lobby and four games. The shell owns the
   chrome (title, wallet, name, sound, connection status) and the page-scroll
   lock; each game owns its own stage and controls (games/*.ts). */

// As a string, injected on first open: a plain import would have Astro hoist
// it into the page's <head> as a render-blocking stylesheet
import css from "./casino.css?inline"
import {
  GAMES,
  PROTOCOL,
  checkName,
  randomName,
  type GameId,
  type Place,
  type Player,
} from "../../../multiplayer/src/protocol"
import { GAME_INFO, type Game } from "./game"
import { net, type NetStatus } from "./net"
import { sfx } from "./sfx"
import { holdScroll } from "../scroll-hold"
import { Sheet } from "./sheet"
import { START_CENTS, prefs, wallet } from "./store"
import {
  MIN_BET,
  avatar,
  countTo,
  h,
  icons,
  money,
  moneyShort,
  reducedMotion,
  setToastHost,
  signed,
  svg,
  toast,
} from "./ui"
import { CrashGame } from "./games/crash"
import { BigOGame } from "./games/bigo"
import { MergeGame } from "./games/merge"
import { PlinkoGame } from "./games/plinko"

const QUIPS = [
  "It works on my machine.",
  "The house always wins. The house is O(1).",
  "Past performance is not indicative of future segfaults.",
  "No real money was harmed in the making of this dialog.",
  "Have you tried turning your luck off and on again?",
  "Gambling responsibly: git stash your winnings.",
  "99 little bugs in the code, 99 little bugs…",
  "Your balance is eventually consistent.",
  "This casino is 100% serverless*. *Except the server.",
  "rm -rf / is also technically a strategy.",
]

const TITLE = "/dev/null/casino.sh"

// The status bar's colour: its 25% black over the shell's --cz-bg
const STATUS_BG = "#080808"
const SCRIPT = "casino.sh"

const FACTORIES: Record<GameId, () => Game> = {
  crash: () => new CrashGame(),
  bigo: () => new BigOGame(),
  merge: () => new MergeGame(),
  plinko: () => new PlinkoGame(),
}

class Casino {
  dialog: HTMLDialogElement
  private views = new Map<Place, HTMLElement>()
  private games = new Map<GameId, Game>()
  private place: Place = prefs.get<Place>("place", "lobby")
  private brand!: HTMLButtonElement
  private promptEl!: HTMLElement
  private pathEl!: HTMLElement
  private flagEl!: HTMLElement
  private flagRun = 0
  private pageTitle = ""
  private balanceEl!: HTMLElement
  private balanceWrap!: HTMLElement
  private shownBalance = wallet.balance
  private nameChip!: HTMLElement
  private soundBtn!: HTMLButtonElement
  private statusConn!: HTMLElement
  private statusQuip!: HTMLElement
  private main!: HTMLElement
  private broke!: HTMLElement
  private lobby!: Lobby
  private quipTimer = 0
  private balTimer = 0
  private lingerTimer = 0
  private closing = false
  private sheet!: Sheet
  private shell!: HTMLElement
  // What opened it, when that was the drawer's peek at the foot of the page:
  // the sheet rises out of it and settles back into it (see sheet.ts)
  private dock: HTMLElement | null = null
  private releaseScroll: (() => void) | null = null
  // The page's own root colour, while the sheet has it (holdEdge)
  private heldEdge: string | null = null

  constructor() {
    if (!prefs.name) prefs.name = randomName()
    document.head.append(h("style", { "data-casino": true, text: css }))
    this.dialog = this.build()
    document.body.append(this.dialog)

    wallet.onChange((bal, delta) => this.onBalance(bal, delta))
    net.onStatus((s) => this.onStatus(s))
    net.on((msg) => {
      if (msg.t === "welcome" || msg.t === "join" || msg.t === "leave" || msg.t === "update")
        this.refreshPresence()
      if (msg.t === "welcome" || msg.t === "name") {
        if (msg.renamed) toast(`Name rejected, you're ${msg.name} for now.`)
        if (msg.name !== prefs.name) {
          prefs.name = msg.name
          this.renderName()
        }
      }
    })
  }

  /* ── Open / close ── */

  /** `dock` is the peek it was opened from, if it was. `rise` false leaves
      the sheet where it is, for lift() to pick up. */
  open(dock: HTMLElement | null = null, rise = true) {
    if (this.dialog.open) return
    clearTimeout(this.lingerTimer)
    this.closing = false
    this.dock = dock
    this.dialog.classList.remove("is-closing")
    this.sheet.reset()
    this.dialog.showModal()
    // Before the sheet measures the dock, in case holding the page moves it
    // Before the page is held, while where it's scrolled to still reads true
    this.holdEdge(true)
    this.lockPage(true)
    if (this.sheet.active && rise) this.sheet.enter()
    // For the page's own animations to stand down while it's covered
    window.dispatchEvent(new CustomEvent("casino", { detail: true }))
    this.pageTitle = document.title
    document.title = this.titleText()
    // Connect first, so a game that can go either way (crash) sees the socket
    // on its way up rather than deciding it's alone
    net.connect(() => ({
      t: "hi",
      v: PROTOCOL,
      name: prefs.name ?? randomName(),
      at: this.place,
      bal: wallet.balance,
    }))
    // The peek shows the lobby's title, so out of it the title starts there
    // and retypes itself to wherever the casino was left
    if (dock) this.typeTitle("lobby", true)
    this.go(this.place, true)
    this.onStatus(net.status)
    this.rotateQuip()
    this.quipTimer = window.setInterval(() => this.rotateQuip(), 9000)
  }

  /** Opened by a drag on the dock: the sheet comes up under the finger and
      follows it. Returns the sheet for the gesture's owner to feed, or null
      if it's already open or not a sheet at this width. */
  lift(dock: HTMLElement, y: number, t: number) {
    if (this.dialog.open || !this.sheet.active) return null
    this.open(dock, false)
    this.sheet.lift(y, t)
    return this.sheet
  }

  /** The dock's offset from the sheet's resting place, while it's on screen. */
  private dockOffset() {
    const el = this.dock
    if (!el?.isConnected) return null
    const r = el.getBoundingClientRect()
    const d = this.dialog.getBoundingClientRect()
    if (!r.height || r.top >= d.bottom) return null
    return r.top - d.top - this.shell.offsetTop
  }

  /** `velocity` is the speed (px/ms) a sheet was flung down at, if it was. */
  close(velocity = 0) {
    if (!this.dialog.open || this.closing) return
    this.closing = true
    clearInterval(this.quipTimer)
    this.currentGame()?.leave()
    const done = () => {
      this.dialog.close()
      this.dialog.classList.remove("is-closing")
      this.sheet.reset()
      this.closing = false
      this.dock = null
      this.lockPage(false)
      this.holdEdge(false)
      window.dispatchEvent(new CustomEvent("casino", { detail: false }))
      document.title = this.pageTitle
      this.releaseNet()
    }
    if (reducedMotion.matches) return done()
    this.dialog.classList.add("is-closing")
    if (this.sheet.active) void this.sheet.exit(velocity).then(done)
    else window.setTimeout(done, 240)
  }

  /** Close the socket, unless a crash bet is still riding: then hold it open
      until the round settles, so closing the dialog can't dodge a bust. */
  private releaseNet() {
    const crash = this.games.get("crash")
    if (crash?.busy?.()) {
      this.lingerTimer = window.setTimeout(() => this.releaseNet(), 1000)
      return
    }
    if (!this.dialog.open) net.disconnect()
  }

  /** Where scrollbars take up room (desktop), the page keeps its scrollbar
      and is held still instead: hiding it would widen the viewport, and the
      usual padding that makes up for that leaves a strip at the right edge
      where the sections stop short and the fixed footer photo behind them
      shows through. Where they overlay the page (phones, macOS by default)
      there is nothing to lose, and overflow: hidden also stops the touch
      scrolling nothing else can. */
  private lockPage(on: boolean) {
    const html = document.documentElement
    ;(window as unknown as { __smoothScrollLock?: (l: boolean) => void }).__smoothScrollLock?.(on)
    this.releaseScroll?.()
    this.releaseScroll = null
    html.style.overflow = ""
    if (!on) return
    if (window.innerWidth > html.clientWidth) this.releaseScroll = holdScroll(this.dialog)
    else html.style.overflow = "hidden"
  }

  /** A sheet opened at the very end of the page sits right on it, and on
      iOS all there is under Safari's toolbar below it is the root colour
      (Layout's page ends). While it's up that takes the colour of the
      sheet's own foot, the status bar, so the sheet runs on under the
      toolbar; closed, the page's comes back. Anywhere else the end isn't
      on screen, so it's left alone. */
  private holdEdge(on: boolean) {
    const root = document.documentElement
    if (!on) {
      if (this.heldEdge !== null) root.style.backgroundColor = this.heldEdge
      this.heldEdge = null
      delete root.dataset.casinoHeld
      return
    }
    const atEnd = !!this.dock || window.scrollY + window.innerHeight >= root.scrollHeight - 8
    if (!this.sheet.active || !atEnd) return
    this.heldEdge = root.style.backgroundColor
    root.style.backgroundColor = STATUS_BG
    // For the page's own end to match too (the footer's peek)
    root.dataset.casinoHeld = ""
  }

  /* ── Navigation ── */

  private currentGame() {
    return this.place === "lobby" ? null : (this.games.get(this.place) ?? null)
  }

  private ensureGame(id: GameId) {
    let g = this.games.get(id)
    if (!g) {
      g = FACTORIES[id]()
      this.games.set(id, g)
      const view = this.views.get(id)!
      view.append(g.stage, g.panel)
    }
    return g
  }

  go(place: Place, force = false) {
    if (place === this.place && !force) return
    const prev = this.place
    if (prev !== place) this.currentGame()?.leave()
    this.place = place
    prefs.set("place", place)

    for (const [p, view] of this.views) {
      const on = p === place
      view.hidden = !on
      view.classList.toggle("is-entering", on && prev !== place)
    }
    // Focus left inside a view that just hid would fall out of the dialog
    // (and take its keyboard shortcuts with it)
    const active = document.activeElement
    if (!active || active === document.body || active.closest("[hidden]"))
      this.dialog.querySelector<HTMLElement>(".cz-shell")?.focus({ preventScroll: true })
    this.dialog.dataset.place = place
    this.brand.disabled = place === "lobby"
    this.typeTitle(place, force && !this.dock)
    if (place === "lobby") this.lobby.enter()
    else this.ensureGame(place).enter()
    net.send({ t: "at", at: place })
    this.refreshPresence()
    this.updateBroke()
  }

  /* ── Chrome ── */

  private build() {
    const dialog = h("dialog", {
      class: "cz",
      "aria-label": TITLE,
      "data-lenis-prevent": true,
    }) as HTMLDialogElement

    dialog.addEventListener("cancel", (e) => {
      e.preventDefault()
      this.close()
    })
    // A click on the backdrop lands on the dialog itself (or, as a sheet,
    // on the scrim above it)
    const scrim = h("div", { class: "cz-scrim", "aria-hidden": "true" })
    dialog.append(scrim)
    dialog.addEventListener("mousedown", (e) => {
      if (e.target === dialog || e.target === scrim) this.close()
    })
    // On the document, not the dialog: a button that disables itself when
    // pressed (deal, deploy) drops focus to <body>, and its keys with it
    document.addEventListener("keydown", (e) => {
      if (this.dialog.open && !this.closing && !e.defaultPrevented) this.onKey(e)
    })

    // Title: the command. In a game it's retyped as a local run with the
    // game as a flag, and doubles as the way back to the lobby.
    this.promptEl = h("span", { class: "cz-brand-prompt" })
    this.pathEl = h("span", { class: "cz-brand-path" })
    this.flagEl = h("span", { class: "cz-brand-flag" })
    this.brand = h(
      "button",
      {
        type: "button",
        class: "cz-brand",
        title: "Back to the lobby (0)",
        onclick: () => this.go("lobby"),
      },
      svg(icons.back, 14),
      this.promptEl,
      h("span", { class: "cz-brand-name" }, this.pathEl, SCRIPT),
      this.flagEl,
      h("span", { class: "cz-brand-caret", text: "_" }),
    )

    // Wallet, name, sound, close
    this.balanceEl = h("strong", { class: "cz-balance-value", text: money(wallet.balance) })
    this.balanceWrap = h(
      "div",
      { class: "cz-balance", "aria-live": "polite" },
      this.balanceEl,
    )
    this.nameChip = h("span", { class: "cz-chip-name" })
    const nameBtn = h(
      "button",
      {
        type: "button",
        class: "cz-chip",
        title: "Change your name",
        onclick: () => {
          this.go("lobby")
          this.lobby.focusName()
        },
      },
      svg(icons.user, 14),
      this.nameChip,
    )
    this.soundBtn = h("button", {
      type: "button",
      class: "cz-icon-btn",
      onclick: () => {
        prefs.sound = !prefs.sound
        this.renderSound()
        sfx.click()
      },
    })
    const closeBtn = h(
      "button",
      { type: "button", class: "cz-icon-btn", "aria-label": "Close", title: "Close (Esc)", onclick: () => this.close() },
      svg(icons.close, 18),
    )

    const top = h(
      "header",
      { class: "cz-top" },
      h("span", { class: "cz-grabber", "aria-hidden": "true" }),
      this.brand,
      h(
        "div",
        { class: "cz-top-end" },
        h("div", { class: "cz-top-game" }, this.balanceWrap, nameBtn),
        this.soundBtn,
        closeBtn,
      ),
    )

    // Views
    this.main = h("main", { class: "cz-main" })
    this.lobby = new Lobby(this)
    const lobbyView = h("section", { class: "cz-view cz-view-lobby", id: "cz-view-lobby" }, this.lobby.el)
    this.views.set("lobby", lobbyView)
    this.main.append(lobbyView)
    for (const id of GAMES) {
      const view = h("section", {
        class: `cz-view cz-game cz-game-${id}`,
        id: `cz-view-${id}`,
        "aria-label": GAME_INFO[id].title,
        hidden: true,
      })
      view.addEventListener("animationend", () => view.classList.remove("is-entering"))
      this.views.set(id, view)
      this.main.append(view)
    }

    // Out of money
    this.broke = h(
      "div",
      { class: "cz-broke", hidden: true },
      h(
        "div",
        { class: "cz-broke-text" },
        h("strong", { text: "Out of memory." }),
        h("span", { text: " Your balance has been garbage collected." }),
      ),
      h("button", {
        type: "button",
        class: "cz-broke-btn",
        text: "git reset --hard",
        onclick: () => {
          wallet.reset()
          sfx.win()
          toast(`Restored ${money(START_CENTS)}. HEAD is now at a fresh start.`, "win")
        },
      }),
    )
    this.main.append(this.broke)

    // Status bar
    this.statusConn = h("span", { class: "cz-status-conn" })
    this.statusQuip = h("span", { class: "cz-status-quip" })
    const status = h("footer", { class: "cz-status" }, this.statusConn, this.statusQuip)

    const toasts = h("div", { class: "cz-toasts" })
    setToastHost(toasts)

    // Focus lands on the shell itself when the dialog opens, not the first
    // button, so nothing wears a focus ring until the keyboard asks for one
    const glow = h("div", { class: "cz-glow", "aria-hidden": "true" })
    const shell = h("div", { class: "cz-shell", tabindex: "-1", autofocus: true }, glow, top, this.main, status, toasts)
    dialog.append(shell)
    this.shell = shell
    this.sheet = new Sheet(
      shell,
      scrim,
      top,
      (v) => this.close(v),
      () => this.dockOffset(),
    )

    this.renderName()
    this.renderSound()
    return dialog
  }

  renderName() {
    this.nameChip.textContent = prefs.name ?? ""
    this.lobby?.renderName()
  }

  setName(name: string) {
    prefs.name = name
    this.renderName()
    net.send({ t: "name", name })
  }

  private renderSound() {
    this.soundBtn.replaceChildren(svg(prefs.sound ? icons.soundOn : icons.soundOff, 18))
    this.soundBtn.setAttribute("aria-label", prefs.sound ? "Mute sound" : "Turn sound on")
    this.soundBtn.title = prefs.sound ? "Sound on" : "Sound off"
    this.soundBtn.setAttribute("aria-pressed", String(prefs.sound))
  }

  private onBalance(bal: number, delta: number) {
    countTo(this.balanceEl, this.shownBalance, bal, money, 600)
    this.shownBalance = bal
    if (delta && this.dialog.open) {
      const d = h("span", {
        class: `cz-balance-delta ${delta > 0 ? "is-up" : "is-down"}`,
        text: signed(delta),
      })
      this.balanceWrap.append(d)
      d.addEventListener("animationend", () => d.remove(), { once: true })
      this.balanceWrap.classList.remove("is-up", "is-down")
      void this.balanceWrap.offsetWidth
      this.balanceWrap.classList.add(delta > 0 ? "is-up" : "is-down")
    }
    this.updateBroke()
    // Tell the lobby, at most every 800ms
    clearTimeout(this.balTimer)
    this.balTimer = window.setTimeout(() => net.send({ t: "bal", bal: wallet.balance }), 800)
    this.lobby.renderBoard()
    this.lobby.renderBalance()
  }

  private updateBroke() {
    this.broke.hidden = wallet.balance >= MIN_BET
  }

  private onStatus(s: NetStatus) {
    this.statusConn.dataset.state = s
    this.refreshPresence()
  }

  private refreshPresence() {
    const s = net.status
    const others = net.others().length
    this.statusConn.textContent =
      s === "live"
        ? others
          ? `online · ${others + 1}`
          : "online"
        : s === "connecting"
          ? "connecting…"
          : "offline"
    this.lobby.renderBoard()
    this.lobby.renderCounts()
  }

  /** Retypes the title for a place: each part backs over whatever it
      doesn't share with its new text, then types forward. Going in, the
      prompt and path go first; coming back, the flag does. */
  private typeTitle(place: Place, instant = false) {
    const run = ++this.flagRun
    const lobby = place === "lobby"
    const parts: [HTMLElement, string][] = [
      [this.promptEl, lobby ? "> " : ""],
      [this.pathEl, lobby ? "/dev/null/" : "./"],
      [this.flagEl, lobby ? "" : ` --${place}`],
    ]
    if (lobby) parts.reverse()
    const done = () => {
      for (const [el, text] of parts) el.textContent = text
      if (this.dialog.open) document.title = this.titleText()
    }
    if (instant || reducedMotion.matches || !this.dialog.open) return done()
    const step = () => {
      if (run !== this.flagRun) return
      const next = parts.find(([el, text]) => el.textContent !== text)
      if (!next) return done()
      const [el, text] = next
      const cur = el.textContent ?? ""
      if (!text.startsWith(cur)) {
        el.textContent = cur.slice(0, -1)
        window.setTimeout(step, 28)
      } else {
        el.textContent = text.slice(0, cur.length + 1)
        window.setTimeout(step, 19 + Math.floor(Math.random() * 57))
      }
    }
    step()
  }

  private titleText() {
    return this.place === "lobby" ? TITLE : `./${SCRIPT} --${this.place}`
  }

  private rotateQuip() {
    const q = QUIPS[Math.floor(Math.random() * QUIPS.length)]
    this.statusQuip.classList.remove("is-in")
    void this.statusQuip.offsetWidth
    this.statusQuip.textContent = q
    this.statusQuip.classList.add("is-in")
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement
    if (t.closest("input, textarea, select")) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (/^[0-4]$/.test(e.key)) {
      const n = Number(e.key)
      this.go(n === 0 ? "lobby" : GAMES[n - 1])
      e.preventDefault()
      return
    }
    if (this.currentGame()?.key?.(e)) e.preventDefault()
  }
}

/* ── Lobby ──
   The landing view: who you are, the four games (with live previews and how
   many people are at each), and, when anyone else is around, the table of
   who's online and how they're doing. */

class Lobby {
  el: HTMLElement
  private nameInput: HTMLInputElement
  private nameMsg: HTMLElement
  private board: HTMLElement
  private boardList: HTMLElement
  private boardCount: HTMLElement
  private counts = new Map<GameId, HTMLElement>()
  private balanceEl = h("h2", { class: "cz-lobby-balance", "aria-label": "Balance", text: money(wallet.balance) })
  private shownBalance = wallet.balance

  constructor(private casino: Casino) {
    this.nameInput = h("input", {
      class: "cz-name-input",
      type: "text",
      maxlength: "20",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "Your name",
    })
    this.nameMsg = h("p", { class: "cz-name-msg", "aria-live": "polite" })
    const say = (text: string, tone: "ok" | "err" | "" = "") => {
      this.nameMsg.textContent = text && `> ${text}`
      this.nameMsg.dataset.tone = tone
    }
    const save = () => {
      const res = checkName(this.nameInput.value)
      if (!res.ok) return say(res.why, "err")
      if (res.name !== prefs.name) this.casino.setName(res.name)
      this.nameInput.value = res.name
      this.fitName()
      say(`Committed as ${res.name}.`, "ok")
      sfx.click()
    }
    const nameForm = h(
      "form",
      {
        class: "cz-name",
        onsubmit: (e: Event) => {
          e.preventDefault()
          save()
          this.nameInput.blur()
        },
      },
      h("span", { class: "cz-name-prompt", text: "$ git config user.name" }),
      h("span", { class: "cz-name-field" }, h("span", { class: "cz-name-q", text: '"' }), this.nameInput, h("span", { class: "cz-name-q", text: '"' })),
      h(
        "button",
        {
          type: "button",
          class: "cz-icon-btn cz-name-reroll",
          title: "Random name",
          "aria-label": "Random name",
          // Suggests a name; it only sticks once committed
          onclick: () => {
            this.nameInput.value = randomName()
            this.fitName()
            say("")
            sfx.click()
          },
        },
        svg(icons.reroll, 16),
      ),
      h("button", { type: "submit", class: "cz-name-save", text: "commit" }),
    )
    this.nameInput.addEventListener("input", () => {
      say("")
      this.fitName()
    })

    const cards = GAMES.map((id, i) => {
      const count = h("span", { class: "cz-card-count", hidden: true })
      this.counts.set(id, count)
      return h(
        "button",
        {
          type: "button",
          class: `cz-card cz-card-${id}`,
          style: `--i:${i}`,
          onclick: () => {
            sfx.click()
            this.casino.go(id)
          },
        },
        h("span", { class: `cz-art cz-art-${id}`, "aria-hidden": "true", html: ART[id] }),
        h(
          "span",
          { class: "cz-card-body" },
          h("span", { class: "cz-card-top" }, h("span", { class: "cz-card-title", text: GAME_INFO[id].title }), count, h("kbd", { class: "cz-kbd", text: String(i + 1) })),
          h("span", { class: "cz-card-tag", text: GAME_INFO[id].tag }),
        ),
      )
    })

    this.boardCount = h("span", { class: "cz-board-count" })
    this.boardList = h("ol", { class: "cz-board-list" })
    this.board = h(
      "section",
      { class: "cz-board", hidden: true, "aria-label": "Online now" },
      h("header", { class: "cz-board-head" }, h("span", { class: "cz-live-dot" }), h("span", { text: "Online now" }), this.boardCount),
      this.boardList,
    )

    this.el = h(
      "div",
      { class: "cz-lobby" },
      h(
        "div",
        { class: "cz-lobby-main" },
        h(
          "div",
          { class: "cz-lobby-hero" },
          this.balanceEl,
          nameForm,
          this.nameMsg,
        ),
        h("div", { class: "cz-cards" }, cards),
      ),
      this.board,
    )
    this.renderName()
  }

  renderBalance() {
    countTo(this.balanceEl, this.shownBalance, wallet.balance, money, 600)
    this.shownBalance = wallet.balance
  }

  enter() {
    this.renderBoard()
    this.renderCounts()
  }

  focusName() {
    this.nameInput.focus()
    this.nameInput.select()
  }

  renderName() {
    if (document.activeElement !== this.nameInput) this.nameInput.value = prefs.name ?? ""
    this.fitName()
  }

  /** Sizes the input to its text (the font is mono), so the closing quote
      hugs it. field-sizing would do this, but not everywhere yet. */
  private fitName() {
    const n = Math.min(Math.max(this.nameInput.value.length, 1), 21)
    this.nameInput.style.width = `calc(${n}ch + 2px)`
  }

  renderCounts() {
    for (const [id, el] of this.counts) {
      const n = net.others(id).length
      el.hidden = n === 0
      el.textContent = `${n} playing`
    }
  }

  renderBoard() {
    const others = net.others()
    this.board.hidden = others.length === 0
    if (!others.length) return
    const me: Player = { id: net.id ?? "me", name: prefs.name ?? "you", at: "lobby", bal: wallet.balance }
    const rows = [...others, me].sort((a, b) => b.bal - a.bal)
    this.boardCount.textContent = String(rows.length)
    this.boardList.replaceChildren(
      ...rows.map((p, i) =>
        h(
          "li",
          { class: `cz-board-row${p === me ? " is-me" : ""}` },
          h("span", { class: "cz-board-rank", text: String(i + 1).padStart(2, "0") }),
          avatar(p.name),
          h("span", { class: "cz-board-name", text: p.name }),
          h("span", { class: "cz-board-at", text: p === me ? "you" : p.at === "lobby" ? "lobby" : GAME_INFO[p.at].short }),
          h("span", { class: "cz-board-bal", text: moneyShort(p.bal) }),
        ),
      ),
    )
  }
}

/* Lobby card previews: tiny looping animations, pure SVG + CSS. */
const ART: Record<GameId, string> = {
  crash: `<svg viewBox="0 0 200 110" preserveAspectRatio="none"><defs><linearGradient id="cz-ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".28"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><g class="cz-art-grid"><path d="M0 27.5h200M0 55h200M0 82.5h200M50 0v110M100 0v110M150 0v110"/></g><g class="cz-art-plot"><path class="cz-art-fill" d="M0 104C60 102 110 92 150 64S190 18 200 8V110H0z" fill="url(#cz-ag)"/><path class="cz-art-line" d="M0 104C60 102 110 92 150 64S190 18 200 8"/></g></svg><span class="cz-art-mult">2.41&times;</span>`,
  bigo: `<span class="cz-art-cardstack"><span class="cz-art-minicard is-a">O(1)</span><span class="cz-art-minicard is-b">O(n&sup2;)</span><span class="cz-art-minicard is-c">O(n!)</span></span>`,
  merge: `<span class="cz-art-reel"><span class="cz-art-strip">${Array.from(
    { length: 20 },
    (_, i) => `<i class="${i % 15 === 7 ? "c" : i % 2 ? "t" : "o"}"></i>`,
  ).join("")}</span></span><span class="cz-art-marker"></span>`,
  plinko: `<svg viewBox="0 0 200 110"><g class="cz-art-pegs">${(() => {
    let s = ""
    for (let r = 0; r < 6; r++)
      for (let c = 0; c <= r + 2; c++) s += `<circle cx="${100 + (c - (r + 2) / 2) * 20}" cy="${14 + r * 15}" r="2"/>`
    return s
  })()}</g><rect class="cz-art-ball" x="-4" y="-4" width="8" height="8" rx="2"/></svg>`,
}

let casino: Casino | null = null

export function open(dock?: HTMLElement) {
  casino ??= new Casino()
  casino.open(dock)
}

export function lift(dock: HTMLElement, y: number, t: number) {
  casino ??= new Casino()
  return casino.lift(dock, y, t)
}
