/* ── /dev/null casino ──
   The easter egg behind the site's >_ prompts. Loaded on first click (see
   trigger.ts), so none of this is paid for by visitors who never find it.

   A native modal <dialog> holding a lobby and four games. The shell owns the
   chrome (tabs, wallet, name, sound, connection status) and the page-scroll
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
  private tabs = new Map<Place, HTMLButtonElement>()
  private tabBadges = new Map<GameId, HTMLElement>()
  private balanceEl!: HTMLElement
  private balanceWrap!: HTMLElement
  private shownBalance = wallet.balance
  private nameChip!: HTMLElement
  private soundBtn!: HTMLButtonElement
  private statusConn!: HTMLElement
  private statusPing!: HTMLElement
  private statusQuip!: HTMLElement
  private statusPlace!: HTMLElement
  private main!: HTMLElement
  private broke!: HTMLElement
  private lobby!: Lobby
  private quipTimer = 0
  private balTimer = 0
  private lingerTimer = 0
  private closing = false

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

  open() {
    if (this.dialog.open) return
    clearTimeout(this.lingerTimer)
    this.closing = false
    this.dialog.classList.remove("is-closing")
    this.dialog.showModal()
    this.lockPage(true)
    // Connect first, so a game that can go either way (crash) sees the socket
    // on its way up rather than deciding it's alone
    net.connect(() => ({
      t: "hi",
      v: PROTOCOL,
      name: prefs.name ?? randomName(),
      at: this.place,
      bal: wallet.balance,
    }))
    this.go(this.place, true)
    this.onStatus(net.status)
    this.rotateQuip()
    this.quipTimer = window.setInterval(() => this.rotateQuip(), 9000)
  }

  close() {
    if (!this.dialog.open || this.closing) return
    this.closing = true
    clearInterval(this.quipTimer)
    this.currentGame()?.leave()
    const done = () => {
      this.dialog.close()
      this.dialog.classList.remove("is-closing")
      this.closing = false
      this.lockPage(false)
      this.releaseNet()
    }
    if (reducedMotion.matches) return done()
    this.dialog.classList.add("is-closing")
    window.setTimeout(done, 240)
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

  private lockPage(on: boolean) {
    const html = document.documentElement
    ;(window as unknown as { __smoothScrollLock?: (l: boolean) => void }).__smoothScrollLock?.(on)
    if (on) {
      const gap = window.innerWidth - html.clientWidth
      html.style.overflow = "hidden"
      if (gap > 0) html.style.paddingRight = `${gap}px`
    } else {
      html.style.overflow = ""
      html.style.paddingRight = ""
    }
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
    for (const [p, tab] of this.tabs) {
      tab.setAttribute("aria-selected", String(p === place))
      tab.tabIndex = p === place ? 0 : -1
    }
    if (place === "lobby") this.lobby.enter()
    else this.ensureGame(place).enter()
    this.statusPlace.textContent =
      place === "lobby" ? "lobby" : `${place}.ts`
    net.send({ t: "at", at: place })
    this.refreshPresence()
    this.updateBroke()
  }

  /* ── Chrome ── */

  private build() {
    const dialog = h("dialog", {
      class: "cz",
      "aria-label": "/dev/null casino",
      "data-lenis-prevent": true,
    }) as HTMLDialogElement

    dialog.addEventListener("cancel", (e) => {
      e.preventDefault()
      this.close()
    })
    // A click on the backdrop lands on the dialog itself
    dialog.addEventListener("mousedown", (e) => {
      if (e.target === dialog) this.close()
    })
    dialog.addEventListener("keydown", (e) => this.onKey(e))

    // Brand + tabs
    const brand = h(
      "button",
      { type: "button", class: "cz-brand", onclick: () => this.go("lobby") },
      h("span", { class: "cz-brand-prompt", text: ">" }),
      h("span", { class: "cz-brand-caret", text: "_" }),
      h("span", { class: "cz-brand-name", text: "/dev/null" }),
      h("span", { class: "cz-brand-sub", text: "casino" }),
    )
    const tabList = h("div", { class: "cz-tabs", role: "tablist", "aria-label": "Games" })
    GAMES.forEach((id, i) => {
      const badge = h("span", { class: "cz-tab-badge", hidden: true })
      const tab = h(
        "button",
        {
          type: "button",
          class: "cz-tab",
          role: "tab",
          "aria-controls": `cz-view-${id}`,
          title: `${GAME_INFO[id].title} (${i + 1})`,
          onclick: () => {
            sfx.click()
            this.go(id)
          },
        },
        h("span", { class: "cz-tab-key", text: String(i + 1) }),
        h("span", { text: GAME_INFO[id].short }),
        badge,
      )
      this.tabs.set(id, tab)
      this.tabBadges.set(id, badge)
      tabList.append(tab)
    })
    tabList.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
      const i = GAMES.indexOf(this.place as GameId)
      const next = GAMES[(i + (e.key === "ArrowRight" ? 1 : GAMES.length - 1)) % GAMES.length]
      this.go(next)
      this.tabs.get(next)?.focus()
      e.stopPropagation()
    })

    // Wallet, name, sound, close
    this.balanceEl = h("strong", { class: "cz-balance-value", text: money(wallet.balance) })
    this.balanceWrap = h(
      "div",
      { class: "cz-balance", "aria-live": "polite" },
      h("span", { class: "cz-balance-label", text: "balance" }),
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
      brand,
      tabList,
      h("div", { class: "cz-top-end" }, this.balanceWrap, nameBtn, this.soundBtn, closeBtn),
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
        role: "tabpanel",
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
    this.statusPing = h("span", { class: "cz-status-ping" })
    this.statusQuip = h("span", { class: "cz-status-quip" })
    this.statusPlace = h("span", { class: "cz-status-place" })
    const status = h(
      "footer",
      { class: "cz-status" },
      h("span", { class: "cz-status-branch" }, svg(icons.branch, 12), "main"),
      this.statusConn,
      this.statusQuip,
      h("span", { class: "cz-status-end" }, this.statusPing, this.statusPlace, h("span", { text: "UTF-8" })),
    )

    const toasts = h("div", { class: "cz-toasts" })
    setToastHost(toasts)

    // Focus lands on the shell itself when the dialog opens, not the first
    // button, so nothing wears a focus ring until the keyboard asks for one
    const shell = h("div", { class: "cz-shell", tabindex: "-1", autofocus: true }, top, this.main, status, toasts)
    dialog.append(shell)

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
  }

  private updateBroke() {
    this.broke.hidden = wallet.balance >= MIN_BET
  }

  private onStatus(s: NetStatus) {
    const others = net.others().length
    const text =
      s === "live"
        ? others
          ? `live · ${others + 1} online`
          : "live · just you"
        : s === "connecting"
          ? "connecting…"
          : s === "off"
            ? "solo mode"
            : "offline · solo mode"
    this.statusConn.textContent = text
    this.statusConn.dataset.state = s
    this.statusPing.textContent = s === "live" && net.rtt ? `${Math.round(net.rtt)}ms` : ""
    this.refreshPresence()
  }

  private refreshPresence() {
    for (const id of GAMES) {
      const n = net.others(id).length
      const badge = this.tabBadges.get(id)!
      badge.hidden = n === 0
      badge.textContent = String(n)
      badge.title = `${n} other ${n === 1 ? "player" : "players"}`
    }
    if (net.live) {
      const others = net.others().length
      this.statusConn.textContent = others ? `live · ${others + 1} online` : "live · just you"
      this.statusPing.textContent = net.rtt ? `${Math.round(net.rtt)}ms` : ""
    }
    this.lobby.renderBoard()
    this.lobby.renderCounts()
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

  constructor(private casino: Casino) {
    this.nameInput = h("input", {
      class: "cz-name-input",
      type: "text",
      maxlength: "20",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "Your name",
    })
    this.nameMsg = h("span", { class: "cz-name-msg", "aria-live": "polite" })
    const save = () => {
      const res = checkName(this.nameInput.value)
      if (!res.ok) {
        this.nameMsg.textContent = res.why
        this.nameMsg.dataset.tone = "err"
        return
      }
      if (res.name === prefs.name) {
        this.nameMsg.textContent = ""
        return
      }
      this.casino.setName(res.name)
      this.nameMsg.textContent = "Saved. Committed as " + res.name + "."
      this.nameMsg.dataset.tone = "ok"
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
          onclick: () => {
            this.nameInput.value = randomName()
            save()
          },
        },
        svg(icons.reroll, 16),
      ),
      h("button", { type: "submit", class: "cz-name-save", text: "commit" }),
      this.nameMsg,
    )
    this.nameInput.addEventListener("blur", () => {
      if (this.nameInput.value !== prefs.name) save()
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
          h("h2", { class: "cz-lobby-title" }, "/dev/null ", h("span", { text: "casino" })),
          h("p", {
            class: "cz-lobby-copy",
            text: `Every visitor gets $${(START_CENTS / 100).toLocaleString("en-US")} of fake money. Like everything else sent to /dev/null, it isn't coming back.`,
          }),
          nameForm,
        ),
        h("div", { class: "cz-cards" }, cards),
      ),
      this.board,
    )
    this.renderName()
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
  crash: `<svg viewBox="0 0 200 110" preserveAspectRatio="none"><defs><linearGradient id="cz-ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".28"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><g class="cz-art-grid"><path d="M0 27.5h200M0 55h200M0 82.5h200M50 0v110M100 0v110M150 0v110"/></g><path class="cz-art-fill" d="M0 104C60 102 110 92 150 64S190 18 200 8V110H0z" fill="url(#cz-ag)"/><path class="cz-art-line" pathLength="1" d="M0 104C60 102 110 92 150 64S190 18 200 8"/></svg><span class="cz-art-mult">2.41&times;</span>`,
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

export function open() {
  casino ??= new Casino()
  casino.open()
}
