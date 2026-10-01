/* ── casino.exe ──
   The easter egg behind the site's >_ prompts. Loaded on first click (see
   trigger.ts), so none of this is paid for by visitors who never find it.

   A native modal <dialog> dressed as a Windows XP window: title bar, menu
   bar, an Explorer toolbar with an address bar, the view, and a status bar
   with a tray. The shell owns that chrome (wallet, name, sound, connection
   status, menus, the About box) and the page-scroll lock; each game owns its
   own stage and controls (games/*.ts). */

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
import { SHEET_QUERY, Sheet } from "./sheet"
import { START_CENTS, prefs, wallet } from "./store"
import {
  MIN_BET,
  avatar,
  countTo,
  dotColor,
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
  "Please wait while Windows configures your luck…",
  "No real money was harmed in the making of this window.",
  "A new version of your luck is available. Restart now?",
  "Defragmenting your wallet…",
  "It is now safe to turn off your luck.",
]

const APP = "casino.exe"
const ROOT_PATH = "C:\\Program Files\\Casino"

// The status bar's colour, --cz-face: the sheet's foot, which the page's root
// takes on under Safari's toolbar while the sheet is up (holdEdge)
const STATUS_BG = "#ece9d8"

const FACTORIES: Record<GameId, () => Game> = {
  crash: () => new CrashGame(),
  bigo: () => new BigOGame(),
  merge: () => new MergeGame(),
  plinko: () => new PlinkoGame(),
}

const placeTitle = (p: Place) => (p === "lobby" ? APP : `${GAME_INFO[p].title} - ${APP}`)
const placePath = (p: Place) =>
  p === "lobby" ? ROOT_PATH : `${ROOT_PATH}\\${GAME_INFO[p].title.toLowerCase().replace(/ /g, "")}.exe`

class Casino {
  dialog: HTMLDialogElement
  private views = new Map<Place, HTMLElement>()
  private games = new Map<GameId, Game>()
  private place: Place = prefs.get<Place>("place", "lobby")
  private titleEl!: HTMLElement
  private titleTimer = 0
  private backBtn!: HTMLButtonElement
  private maxBtn!: HTMLButtonElement
  private addrIcon!: HTMLElement
  private addrText!: HTMLElement
  private pageTitle = ""
  private balanceEl!: HTMLElement
  private balanceWrap!: HTMLElement
  private shownBalance = wallet.balance
  private nameChip!: HTMLElement
  private soundBtn!: HTMLButtonElement
  private status!: HTMLElement
  private statusConn!: HTMLElement
  private statusQuip!: HTMLElement
  private main!: HTMLElement
  private broke!: HTMLElement
  private about: HTMLElement | null = null
  private lobby!: Lobby
  private menus!: Menus
  private quipTimer = 0
  private balTimer = 0
  private lingerTimer = 0
  private closing = false
  private sheet!: Sheet
  private shell!: HTMLElement
  // Where the window has been dragged to by its title bar (desktop only)
  private pos = { x: 0, y: 0 }
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
    this.moveTo(0, 0)
    this.dialog.showModal()
    // Before the page is held, while where it's scrolled to still reads true
    this.holdEdge(true)
    this.lockPage(true)
    if (this.sheet.active && rise) this.sheet.enter()
    // For the page's own animations to stand down while it's covered
    window.dispatchEvent(new CustomEvent("casino", { detail: true }))
    this.pageTitle = document.title
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
    // The peek's title bar reads just the app's name, so out of it the sheet
    // starts there too, and names the game once it's up
    if (dock && this.place !== "lobby") {
      this.titleEl.textContent = APP
      this.titleTimer = window.setTimeout(() => this.renderTitle(), 450)
    }
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
    clearTimeout(this.titleTimer)
    this.menus.close()
    this.closeAbout()
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
    // Going back down into the peek, it goes back to reading as the peek does
    if (this.sheet.active && this.dock) this.titleEl.textContent = APP
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
      sheet's own foot, the status bar, so the window runs on under the
      toolbar; closed, the page's comes back. Anywhere else the end isn't
      on screen, so it's left alone. */
  private holdEdge(on: boolean) {
    const root = document.documentElement
    if (!on) {
      if (this.heldEdge !== null) root.style.backgroundColor = this.heldEdge
      this.heldEdge = null
      return
    }
    const atEnd = !!this.dock || window.scrollY + window.innerHeight >= root.scrollHeight - 8
    if (!this.sheet.active || !atEnd) return
    this.heldEdge = root.style.backgroundColor
    root.style.backgroundColor = STATUS_BG
  }

  /* ── The window ── */

  /** Maximised fills the screen; restored is the usual floating window. */
  private toggleMax(on = !this.dialog.classList.contains("is-max")) {
    if (this.sheet.active && on) return
    this.dialog.classList.toggle("is-max", on)
    this.moveTo(0, 0)
    this.maxBtn.replaceChildren(svg(on ? icons.capRestore : icons.capMax, 13))
    this.maxBtn.setAttribute("aria-label", on ? "Restore" : "Maximize")
    this.maxBtn.title = on ? "Restore Down" : "Maximize"
  }

  private moveTo(x: number, y: number) {
    this.pos = { x, y }
    this.shell.style.translate = x || y ? `${x}px ${y}px` : ""
  }

  /** On a desktop the window goes where its title bar is dragged, kept on
      screen by enough of the bar to grab it again. (On phones the bar is
      the sheet's handle instead, sheet.ts.) */
  private bindMove(bar: HTMLElement) {
    // Narrowed into a sheet, it's neither moved nor maximised any more
    SHEET_QUERY.addEventListener("change", () => {
      if (SHEET_QUERY.matches) this.toggleMax(false)
    })
    let id: number | null = null
    let sx = 0
    let sy = 0
    let from = { x: 0, y: 0 }
    let box = { left: 0, top: 0, width: 0 }
    bar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.sheet.active || this.dialog.classList.contains("is-max")) return
      if ((e.target as Element).closest("button")) return
      id = e.pointerId
      sx = e.clientX
      sy = e.clientY
      from = { ...this.pos }
      const r = this.shell.getBoundingClientRect()
      box = { left: r.left - from.x, top: r.top - from.y, width: r.width }
      bar.setPointerCapture(id)
      e.preventDefault()
    })
    bar.addEventListener("pointermove", (e) => {
      if (e.pointerId !== id) return
      const grip = 120
      const x = Math.min(window.innerWidth - grip - box.left, Math.max(grip - box.width - box.left, from.x + e.clientX - sx))
      const y = Math.min(window.innerHeight - 40 - box.top, Math.max(-box.top, from.y + e.clientY - sy))
      this.moveTo(x, y)
    })
    const up = (e: PointerEvent) => {
      if (e.pointerId === id) id = null
    }
    bar.addEventListener("pointerup", up)
    bar.addEventListener("pointercancel", up)
    bar.addEventListener("dblclick", (e) => {
      if (!(e.target as Element).closest("button")) this.toggleMax()
    })
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
      this.shell.focus({ preventScroll: true })
    this.dialog.dataset.place = place
    this.backBtn.disabled = place === "lobby"
    clearTimeout(this.titleTimer)
    this.renderTitle()
    this.addrIcon.replaceChildren(svg(place === "lobby" ? icons.folder : icons.app, 16))
    this.addrText.textContent = placePath(place)
    if (place === "lobby") this.lobby.enter()
    else this.ensureGame(place).enter()
    net.send({ t: "at", at: place })
    this.refreshPresence()
    this.updateBroke()
  }

  private renderTitle() {
    this.titleEl.textContent = placeTitle(this.place)
    if (this.dialog.open) document.title = placeTitle(this.place)
  }

  /* ── Chrome ── */

  private build() {
    const dialog = h("dialog", {
      class: "cz",
      "aria-label": APP,
      "data-lenis-prevent": true,
    }) as HTMLDialogElement

    // Escape backs out one layer at a time: a menu, the About box, the window
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault()
      if (this.menus.close(true) || this.closeAbout()) return
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
    // pressed (deal, bet) drops focus to <body>, and its keys with it
    document.addEventListener("keydown", (e) => {
      if (this.dialog.open && !this.closing && !e.defaultPrevented) this.onKey(e)
    })

    // Focus lands on the shell itself when the dialog opens, not the first
    // button, so nothing wears a focus ring until the keyboard asks for one
    const shell = h("div", { class: "cz-shell", tabindex: "-1", autofocus: true })
    this.shell = shell
    this.menus = new Menus(shell)

    // Title bar: the window's name and its caption buttons. It's also what
    // moves the window (desktop) or the sheet (phones).
    this.titleEl = h("span", { class: "cz-title-text" })
    this.maxBtn = h(
      "button",
      { type: "button", class: "cz-cap", "aria-label": "Maximize", title: "Maximize", onclick: () => this.toggleMax() },
      svg(icons.capMax, 13),
    )
    const titlebar = h(
      "header",
      { class: "cz-titlebar" },
      h("span", { class: "cz-title-icon" }, svg(icons.app, 16)),
      this.titleEl,
      h(
        "div",
        { class: "cz-caption" },
        h(
          "button",
          { type: "button", class: "cz-cap", "aria-label": "Minimize", title: "Minimize", onclick: () => this.close() },
          svg(icons.capMin, 13),
        ),
        this.maxBtn,
        h(
          "button",
          { type: "button", class: "cz-cap is-close", "aria-label": "Close", title: "Close (Esc)", onclick: () => this.close() },
          svg(icons.capClose, 13),
        ),
      ),
    )
    this.bindMove(titlebar)

    // Menu bar
    const placeItems = (): MenuItem[] => [
      { label: "Lobby", key: "0", radio: true, checked: this.place === "lobby", run: () => this.go("lobby") },
      "-",
      ...GAMES.map((id, i): MenuItem => ({
        label: GAME_INFO[id].title,
        key: String(i + 1),
        radio: true,
        checked: this.place === id,
        run: () => this.go(id),
      })),
    ]
    const menuBtn = (label: string) => h("button", { type: "button", class: "cz-menubar-btn", text: label })
    const gameMenu = menuBtn("Game")
    const optMenu = menuBtn("Options")
    const helpMenu = menuBtn("Help")
    this.menus.add(gameMenu, () => [...placeItems(), "-", { label: "Exit", key: "Esc", run: () => this.close() }], true)
    this.menus.add(
      optMenu,
      () => [
        { label: "Sound", checked: prefs.sound, run: () => this.toggleSound() },
        { label: "Change name…", run: () => this.editName() },
      ],
      true,
    )
    this.menus.add(helpMenu, () => [{ label: `About ${APP}`, run: () => this.showAbout() }], true)
    const menubar = h("nav", { class: "cz-menubar", "aria-label": "Menu" }, gameMenu, optMenu, helpMenu)

    // Toolbar: back, the address (whose drop-down goes anywhere), the wallet
    this.backBtn = h(
      "button",
      { type: "button", class: "cz-tb-btn cz-back", title: "Back to the lobby (0)", onclick: () => this.go("lobby") },
      svg(icons.back, 22),
      h("span", { class: "cz-tb-label", text: "Back" }),
    )
    this.addrIcon = h("span", { class: "cz-addr-icon" })
    this.addrText = h("span", { class: "cz-addr-text" })
    const addr = h(
      "button",
      { type: "button", class: "cz-addr", "aria-label": "Go to", title: "Go to…" },
      this.addrIcon,
      this.addrText,
      h("span", { class: "cz-addr-drop" }, svg(icons.drop, 16)),
    )
    this.menus.add(addr, placeItems)

    this.balanceEl = h("strong", { class: "cz-balance-value", text: money(wallet.balance) })
    this.balanceWrap = h("div", { class: "cz-balance", "aria-live": "polite", title: "Balance" }, this.balanceEl)
    this.nameChip = h("span", { class: "cz-chip-name" })
    const nameBtn = h(
      "button",
      { type: "button", class: "cz-tb-btn cz-chip", title: "Change your name", onclick: () => this.editName() },
      svg(icons.user, 16),
      this.nameChip,
    )
    const toolbar = h(
      "div",
      { class: "cz-toolbar" },
      this.backBtn,
      h("span", { class: "cz-tb-sep", "aria-hidden": "true" }),
      h("span", { class: "cz-addr-label", "aria-hidden": "true", text: "Address" }),
      addr,
      h("div", { class: "cz-top-game" }, this.balanceWrap, nameBtn),
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
      this.views.set(id, view)
      this.main.append(view)
    }
    for (const view of this.views.values())
      view.addEventListener("animationend", (e) => {
        if (e.target === view) view.classList.remove("is-entering")
      })

    // Out of money: the one error box nobody can dismiss but by restoring
    this.broke = h(
      "div",
      { class: "cz-broke", hidden: true },
      xpWindow(
        `${APP} - Out of Memory`,
        [
          h(
            "div",
            { class: "cz-msg" },
            svg(icons.error, 32),
            h(
              "p",
              {},
              h("strong", { text: `${APP} has run out of memory.` }),
              " Your balance has been garbage collected. Restore your system to an earlier point to keep playing.",
            ),
          ),
          h(
            "div",
            { class: "cz-win-btns" },
            h("button", {
              type: "button",
              class: "cz-btn is-default",
              text: "System Restore",
              onclick: () => {
                wallet.reset()
                sfx.win()
                toast(`System Restore complete. ${money(START_CENTS)} restored.`, "win")
              },
            }),
          ),
        ],
        { role: "alertdialog" },
      ),
    )
    this.main.append(this.broke)

    // Status bar: connection, a quip, and a tray with the network and volume
    this.statusConn = h("span", { class: "cz-status-conn" })
    this.statusQuip = h("span", { class: "cz-status-quip" })
    this.soundBtn = h("button", { type: "button", class: "cz-tray-btn", onclick: () => this.toggleSound() })
    this.status = h(
      "footer",
      { class: "cz-status" },
      h("span", { class: "cz-pane cz-pane-conn" }, this.statusConn),
      h("span", { class: "cz-pane cz-pane-quip" }, this.statusQuip),
      h(
        "span",
        { class: "cz-pane cz-tray" },
        h("span", { class: "cz-tray-net" }, svg(icons.net, 16)),
        this.soundBtn,
      ),
      h("span", { class: "cz-grip", "aria-hidden": "true" }),
    )

    const toasts = h("div", { class: "cz-toasts" })
    setToastHost(toasts)

    shell.append(titlebar, menubar, toolbar, this.main, this.status, toasts)
    dialog.append(shell)
    this.sheet = new Sheet(
      shell,
      scrim,
      titlebar,
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

  private editName() {
    this.go("lobby")
    this.lobby.focusName()
  }

  private toggleSound() {
    prefs.sound = !prefs.sound
    this.renderSound()
    sfx.click()
  }

  private renderSound() {
    this.soundBtn.replaceChildren(svg(prefs.sound ? icons.soundOn : icons.soundOff, 16))
    this.soundBtn.setAttribute("aria-label", prefs.sound ? "Mute sound" : "Turn sound on")
    this.soundBtn.title = prefs.sound ? "Volume: on" : "Volume: muted"
    this.soundBtn.setAttribute("aria-pressed", String(prefs.sound))
  }

  /* ── About ── */

  private showAbout() {
    if (this.about) return
    const ok = h("button", { type: "button", class: "cz-btn is-default", text: "OK", onclick: () => this.closeAbout() })
    const win = xpWindow(
      `About ${APP}`,
      [
        h(
          "div",
          { class: "cz-about-banner" },
          svg(icons.app, 40),
          h("span", { class: "cz-about-word" }, "casino", h("span", { text: ".exe" })),
        ),
        h(
          "div",
          { class: "cz-about-body" },
          h("p", { text: `${APP}` }),
          h("p", { text: "Version 5.1 (Build 2600.xpsp_sp2_rtm : Service Pack 2)" }),
          h("p", { text: `© ${new Date().getFullYear()} Dominic Clerici. No refunds.` }),
          h("hr"),
          h("p", { text: "This product is licensed to:" }),
          h("p", { class: "cz-about-name", text: prefs.name ?? "" }),
          h("hr"),
          h("p", { text: `Physical memory available to ${APP}: ${money(wallet.balance)}` }),
          h("p", { text: `Peak memory usage: ${money(wallet.peak)}` }),
          h("p", { text: `System Restores: ${wallet.resets}` }),
        ),
        h("div", { class: "cz-win-btns" }, ok),
      ],
      { role: "dialog", onClose: () => this.closeAbout() },
    )
    // Modal to the window, as XP's were: a click beside it just flashes it
    const layer = h("div", { class: "cz-modal" }, win)
    layer.addEventListener("mousedown", (e) => {
      if (e.target !== layer) return
      e.preventDefault()
      win.classList.remove("is-flash")
      void win.offsetWidth
      win.classList.add("is-flash")
      sfx.tick(0.5)
    })
    this.shell.append(layer)
    this.about = layer
    ok.focus()
  }

  private closeAbout() {
    if (!this.about) return false
    this.about.remove()
    this.about = null
    this.shell.focus({ preventScroll: true })
    return true
  }

  /* ── Wallet and presence ── */

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
    this.status.dataset.net = s
    this.refreshPresence()
  }

  private refreshPresence() {
    const s = net.status
    const others = net.others().length
    this.statusConn.textContent =
      s === "live"
        ? others
          ? `Online · ${others + 1} players`
          : "Online"
        : s === "connecting"
          ? "Connecting…"
          : "Working offline"
    this.status.querySelector(".cz-tray-net")?.setAttribute(
      "title",
      s === "live" ? "Lobby: Connected" : s === "connecting" ? "Lobby: Acquiring network address…" : "Lobby: A network cable is unplugged",
    )
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
    if (this.about) return
    if (/^[0-4]$/.test(e.key)) {
      const n = Number(e.key)
      this.menus.close()
      this.go(n === 0 ? "lobby" : GAMES[n - 1])
      e.preventDefault()
      return
    }
    if (this.currentGame()?.key?.(e)) e.preventDefault()
  }
}

/* ── XP bits ── */

/** A small window of its own (the About box, the out-of-memory error): title
    bar, optional close button, body. */
function xpWindow(title: string, body: Node[], opts: { role?: string; onClose?: () => void } = {}) {
  return h(
    "div",
    { class: "cz-win", role: opts.role, "aria-label": title },
    h(
      "div",
      { class: "cz-win-title" },
      h("span", { text: title }),
      opts.onClose &&
        h(
          "button",
          { type: "button", class: "cz-cap is-close", "aria-label": "Close", onclick: opts.onClose },
          svg(icons.capClose, 13),
        ),
    ),
    h("div", { class: "cz-win-body" }, body),
  )
}

type MenuItem =
  | "-"
  | { label: string; key?: string; checked?: boolean; radio?: boolean; run: () => void }

/** Drop-down menus: the menu bar's, and the address bar's list of places.
    One popup, shared, placed under whichever button opened it. Once one of
    the bar's menus is open, pointing at another opens that instead, and the
    arrow keys walk the items (and, left and right, the bar). */
class Menus {
  private pop = h("div", { class: "cz-menu", role: "menu", hidden: true })
  private current: HTMLButtonElement | null = null
  private items = new Map<HTMLButtonElement, () => MenuItem[]>()
  private bar: HTMLButtonElement[] = []

  constructor(private host: HTMLElement) {
    host.append(this.pop)
    document.addEventListener(
      "pointerdown",
      (e) => {
        const t = e.target as Node
        if (this.current && !this.pop.contains(t) && !this.current.contains(t)) this.close()
      },
      true,
    )
    this.pop.addEventListener("keydown", (e) => this.onKey(e))
    this.pop.addEventListener("focusout", (e) => {
      const to = e.relatedTarget as Node | null
      if (to && !this.pop.contains(to) && to !== this.current) this.close()
    })
  }

  add(btn: HTMLButtonElement, items: () => MenuItem[], bar = false) {
    this.items.set(btn, items)
    btn.setAttribute("aria-haspopup", "menu")
    btn.setAttribute("aria-expanded", "false")
    btn.addEventListener("click", (e) => {
      if (this.current === btn) this.close()
      else this.open(btn, e.detail === 0)
    })
    btn.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown") return
      e.preventDefault()
      this.open(btn, true)
    })
    if (!bar) return
    this.bar.push(btn)
    btn.addEventListener("pointerenter", () => {
      if (this.current && this.current !== btn && this.bar.includes(this.current)) this.open(btn)
    })
  }

  open(btn: HTMLButtonElement, focus = false) {
    this.close()
    this.current = btn
    btn.setAttribute("aria-expanded", "true")
    btn.classList.add("is-open")
    const items = this.items.get(btn)!()
    this.pop.replaceChildren(
      ...items.map((it) =>
        it === "-"
          ? h("div", { class: "cz-menu-sep", role: "separator" })
          : h(
              "button",
              {
                type: "button",
                class: "cz-menu-item",
                role: it.checked === undefined ? "menuitem" : it.radio ? "menuitemradio" : "menuitemcheckbox",
                "aria-checked": it.checked === undefined ? null : String(it.checked),
                onclick: () => {
                  this.close(true)
                  it.run()
                },
              },
              h("span", { class: `cz-menu-check${it.radio ? " is-radio" : ""}`, "aria-hidden": "true" }),
              h("span", { class: "cz-menu-label", text: it.label }),
              h("span", { class: "cz-menu-key", text: it.key ?? "" }),
            ),
      ),
    )
    this.pop.hidden = false
    this.pop.classList.toggle("is-wide", !this.bar.includes(btn))
    const hr = this.host.getBoundingClientRect()
    const br = btn.getBoundingClientRect()
    this.pop.style.minWidth = this.bar.includes(btn) ? "" : `${br.width}px`
    const left = Math.max(2, Math.min(br.left - hr.left, hr.width - this.pop.offsetWidth - 4))
    this.pop.style.left = `${left}px`
    this.pop.style.top = `${br.bottom - hr.top}px`
    if (focus) this.entries()[0]?.focus()
  }

  /** Returns whether there was one open. `refocus` hands focus back to the
      button that opened it, as a keyboard user would expect. */
  close(refocus = false) {
    const btn = this.current
    if (!btn) return false
    this.current = null
    btn.setAttribute("aria-expanded", "false")
    btn.classList.remove("is-open")
    const had = this.pop.contains(document.activeElement)
    this.pop.hidden = true
    if (refocus && had) btn.focus({ preventScroll: true })
    return true
  }

  private entries() {
    return [...this.pop.querySelectorAll<HTMLButtonElement>(".cz-menu-item")]
  }

  private onKey(e: KeyboardEvent) {
    const list = this.entries()
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    const at = this.bar.indexOf(this.current!)
    let used = true
    if (e.key === "ArrowDown") list[(i + 1) % list.length]?.focus()
    else if (e.key === "ArrowUp") list[(i - 1 + list.length) % list.length]?.focus()
    else if (e.key === "Home") list[0]?.focus()
    else if (e.key === "End") list[list.length - 1]?.focus()
    else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && at >= 0) {
      const next = this.bar[(at + (e.key === "ArrowRight" ? 1 : -1) + this.bar.length) % this.bar.length]
      this.open(next, true)
    } else if (e.key === "Tab") this.close()
    else used = false
    if (used && e.key !== "Tab") e.preventDefault()
    // Keys meant for the menu stay out of the games' shortcuts
    if (used) e.stopPropagation()
  }
}

/* ── Lobby ──
   An Explorer folder: a task pane down the left with who you are, who else
   is online and a few details, and the four games as tiles, each with a
   live preview and how many people are at it. */

class Lobby {
  el: HTMLElement
  private nameInput: HTMLInputElement
  private nameMsg: HTMLElement
  private userPic: HTMLElement
  private userName: HTMLElement
  private board: HTMLElement
  private boardList: HTMLElement
  private boardCount: HTMLElement
  private details: HTMLElement
  private counts = new Map<GameId, HTMLElement>()
  private balanceEl = h("strong", { class: "cz-lobby-balance", "aria-label": "Balance", text: money(wallet.balance) })
  private shownBalance = wallet.balance

  constructor(private casino: Casino) {
    this.nameInput = h("input", {
      class: "cz-input cz-name-input",
      id: "cz-name-input",
      type: "text",
      maxlength: "20",
      autocomplete: "off",
      spellcheck: "false",
    })
    this.nameMsg = h("p", { class: "cz-name-msg", "aria-live": "polite" })
    const say = (text: string, tone: "ok" | "err" | "" = "") => {
      this.nameMsg.textContent = text
      this.nameMsg.dataset.tone = tone
    }
    const save = () => {
      const res = checkName(this.nameInput.value)
      if (!res.ok) return say(res.why, "err")
      if (res.name !== prefs.name) this.casino.setName(res.name)
      this.nameInput.value = res.name
      say(`Saved. You're ${res.name}.`, "ok")
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
      h("label", { class: "cz-name-label", for: "cz-name-input", text: "User name:" }),
      h(
        "span",
        { class: "cz-name-row" },
        this.nameInput,
        h(
          "button",
          {
            type: "button",
            class: "cz-btn cz-btn-icon",
            title: "Random name",
            "aria-label": "Random name",
            // Suggests a name; it only sticks once applied
            onclick: () => {
              this.nameInput.value = randomName()
              say("")
              sfx.click()
            },
          },
          svg(icons.app, 16),
        ),
        h("button", { type: "submit", class: "cz-btn", text: "Apply" }),
      ),
    )
    this.nameInput.addEventListener("input", () => say(""))

    this.userPic = h("span", { class: "cz-user-pic", "aria-hidden": "true" })
    this.userName = h("strong", { class: "cz-user-name" })

    this.boardCount = h("span", { class: "cz-tp-count" })
    this.boardList = h("ol", { class: "cz-board-list" })
    this.board = pane("Online now", [this.boardList], { extra: this.boardCount })
    this.board.hidden = true

    this.details = h("div", { class: "cz-details" })

    const cards = GAMES.map((id, i) => {
      const count = h("span", { class: "cz-card-count", hidden: true })
      this.counts.set(id, count)
      return h(
        "button",
        {
          type: "button",
          class: `cz-card cz-card-${id}`,
          onclick: () => {
            sfx.click()
            this.casino.go(id)
          },
        },
        h("span", { class: `cz-art cz-art-${id}`, "aria-hidden": "true", html: ART[id] }),
        h(
          "span",
          { class: "cz-card-body" },
          h(
            "span",
            { class: "cz-card-top" },
            h("span", { class: "cz-card-title", text: GAME_INFO[id].title }),
            h("kbd", { class: "cz-kbd", text: String(i + 1) }),
          ),
          h("span", { class: "cz-card-tag", text: GAME_INFO[id].tag }),
          count,
        ),
      )
    })

    this.el = h(
      "div",
      { class: "cz-lobby" },
      h(
        "aside",
        { class: "cz-taskpane" },
        pane(
          "User Account",
          [
            h(
              "div",
              { class: "cz-user" },
              this.userPic,
              h("span", { class: "cz-user-meta" }, this.userName, h("span", { class: "cz-user-sub", text: "Balance" }), this.balanceEl),
            ),
            nameForm,
            this.nameMsg,
          ],
          { special: true },
        ),
        this.board,
        pane("Details", [this.details]),
      ),
      h(
        "div",
        { class: "cz-explorer" },
        h("h2", { class: "cz-group-head", text: "Games on this computer" }),
        h("div", { class: "cz-cards" }, cards),
      ),
    )
    this.renderName()
    this.renderDetails()
  }

  renderBalance() {
    countTo(this.balanceEl, this.shownBalance, wallet.balance, money, 600)
    this.shownBalance = wallet.balance
    this.renderDetails()
  }

  enter() {
    this.renderBoard()
    this.renderCounts()
    this.renderDetails()
  }

  focusName() {
    this.nameInput.focus()
    this.nameInput.select()
  }

  renderName() {
    const name = prefs.name ?? ""
    if (document.activeElement !== this.nameInput) this.nameInput.value = name
    this.userName.textContent = name
    this.userPic.style.setProperty("--dot", dotColor(name))
    this.userPic.textContent = name.replace(/[^A-Za-z0-9]/g, "").charAt(0).toUpperCase() || "?"
  }

  private renderDetails() {
    this.details.replaceChildren(
      h("strong", { text: APP }),
      h("span", { text: "Application" }),
      h("span", { text: `Peak balance: ${money(wallet.peak)}` }),
      h("span", { text: `System Restores: ${wallet.resets}` }),
    )
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
          h("span", { class: "cz-board-rank", text: String(i + 1) }),
          avatar(p.name),
          h("span", { class: "cz-board-name", text: p.name }),
          h("span", { class: "cz-board-at", text: p === me ? "you" : p.at === "lobby" ? "lobby" : GAME_INFO[p.at].short }),
          h("span", { class: "cz-board-bal", text: moneyShort(p.bal) }),
        ),
      ),
    )
  }
}

/** One of the task pane's panels, which fold away from their header. */
function pane(title: string, body: Node[], opts: { special?: boolean; extra?: Node } = {}) {
  const bodyEl = h("div", { class: "cz-tp-body" }, body)
  const head = h(
    "button",
    { type: "button", class: "cz-tp-head", "aria-expanded": "true" },
    h("span", { class: "cz-tp-title", text: title }),
    opts.extra,
    h("span", { class: "cz-tp-chev" }, svg(icons.chevron, 16)),
  )
  const el = h("section", { class: `cz-tp${opts.special ? " is-special" : ""}` }, head, bodyEl)
  head.addEventListener("click", () => {
    const open = el.classList.toggle("is-collapsed")
    head.setAttribute("aria-expanded", String(!open))
  })
  return el
}

/* Lobby tile previews: tiny looping animations, pure SVG + CSS, each drawn
   on its game's own table. */
const ART: Record<GameId, string> = {
  crash: `<svg viewBox="0 0 200 110" preserveAspectRatio="none"><g class="cz-art-grid"><path d="M0 11h200M0 22h200M0 33h200M0 44h200M0 55h200M0 66h200M0 77h200M0 88h200M0 99h200M20 0v110M40 0v110M60 0v110M80 0v110M100 0v110M120 0v110M140 0v110M160 0v110M180 0v110"/></g><g class="cz-art-plot"><path class="cz-art-fill" d="M0 104C60 102 110 92 150 64S190 18 200 8V110H0z"/><path class="cz-art-line" d="M0 104C60 102 110 92 150 64S190 18 200 8"/></g></svg><span class="cz-art-mult">2.41&times;</span>`,
  bigo: `<span class="cz-art-cardstack"><span class="cz-art-minicard is-a">A&spades;</span><span class="cz-art-minicard is-b">7&hearts;</span><span class="cz-art-minicard is-c">K&clubs;</span></span>`,
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
