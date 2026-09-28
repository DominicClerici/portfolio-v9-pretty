import type { GameId } from "../../../multiplayer/src/protocol"

/** What the shell needs from each game. The game builds its own stage (the
    big animated area) and panel (the controls); the shell mounts them. */
export interface Game {
  readonly id: GameId
  readonly stage: HTMLElement
  readonly panel: HTMLElement
  /** Shown. Start loops, sync with the lobby. */
  enter(): void
  /** Hidden. Stop loops; settle anything purely local that's mid-animation. */
  leave(): void
  /** Money is riding on something the server still has to decide. */
  busy?(): boolean
  /** Handle a key press; return true if it was used. */
  key?(e: KeyboardEvent): boolean
}

export const GAME_INFO: Record<GameId, { title: string; short: string; tag: string }> = {
  crash: {
    title: "Crash",
    short: "Crash",
    tag: "Ride the memory leak. Cash out before the OOM killer shows up.",
  },
  bigo: {
    title: "Big O",
    short: "Big O",
    tag: "Higher or lower, in asymptotic complexity. Don't get TLE'd.",
  },
  merge: {
    title: "Merge Conflict",
    short: "Merge",
    tag: "Ours, theirs, or the one nobody wants. Roulette for git.",
  },
  plinko: {
    title: "Plinko",
    short: "Plinko",
    tag: "Drop a packet through the load balancer and see where it lands.",
  },
}
