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
    tag: "Watch the multiplier climb and cash out before it crashes.",
  },
  bigo: {
    title: "High Low",
    short: "High Low",
    tag: "Guess whether the next card is higher or lower.",
  },
  merge: {
    title: "Roulette",
    short: "Roulette",
    tag: "Red or black pays double. Green pays 14×.",
  },
  plinko: {
    title: "Plinko",
    short: "Plinko",
    tag: "Drop a ball and see where it lands.",
  },
}
