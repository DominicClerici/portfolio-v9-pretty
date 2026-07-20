/* Ink analysis for the Contact letter's signature captcha: tells a human
   scribble from a synthetic one. Pure geometry, no DOM — the component keeps
   only the drawing and the state machine. */

export type Pt = { x: number; y: number }

export type InkVerdict = {
  flagged: boolean
  rightAngle: boolean
  diagonal: boolean
}

// Enough path to rule out a stray tap; any real squiggle clears it easily
export const MIN_INK = 220
export const MIN_SAMPLES = 14

// Bot tells: a run of ink is "robotic" only when it's literally
// perfectly straight — within sub-pixel rounding of its own chord.
// Even a careful human hand wobbles more than half a pixel over 30px;
// synthetic pointer events don't. Runs need a few samples so a fast
// human flick (2–3 sparse points, trivially "straight") doesn't get
// accused.
const STRAIGHT_DEV = 0.25
const MIN_STRAIGHT = 30
const MIN_RUN_SAMPLES = 4
const ANGLE_TOL = 5
const ROBOT_RATIO = 0.75

const RIGHT_ANGLE_LINES = [
  "That's an awfully perfect 90° for a human…",
  "A crisp right angle. Blink twice if you're a robot.",
]
const DIAGONAL_LINES = [
  "A flawless 45° — no human hand owns a protractor that steady.",
  "Perfect 45s? Beep boop. Try again, but messier.",
]
const STRAIGHT_LINES = [
  "Ruler-straight. Humans wobble — wobble for me.",
  "That's not a signature, that's a blueprint. Loosen up.",
]

const pick = (lines: string[]) =>
  lines[Math.floor(Math.random() * lines.length)]

// Max perpendicular distance of the points between a and b from the
// straight chord joining them
const chordDeviation = (pts: Pt[], a: number, b: number) => {
  const ax = pts[a].x
  const ay = pts[a].y
  const dx = pts[b].x - ax
  const dy = pts[b].y - ay
  const len = Math.hypot(dx, dy) || 1
  let max = 0
  for (let i = a + 1; i < b; i++) {
    const d = Math.abs((pts[i].x - ax) * dy - (pts[i].y - ay) * dx) / len
    if (d > max) max = d
  }
  return max
}

const pathLength = (pts: Pt[], a: number, b: number) => {
  let l = 0
  for (let i = a; i < b; i++)
    l += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
  return l
}

/* Split every stroke into maximal near-straight runs, tally how much of the
   ink is robotic, and note any suspiciously perfect corners between
   consecutive straight runs */
export function inspectInk(strokes: Pt[][]): InkVerdict {
  let total = 0
  let robotic = 0
  let rightAngle = false
  let diagonal = false
  for (const pts of strokes) {
    if (pts.length < 2) continue
    total += pathLength(pts, 0, pts.length - 1)
    const runs: { a: number; b: number }[] = []
    let a = 0
    for (let b = a + 2; b < pts.length; b++) {
      if (chordDeviation(pts, a, b) > STRAIGHT_DEV) {
        runs.push({ a, b: b - 1 })
        a = b - 1
        b = a + 1
      }
    }
    if (pts.length - 1 > a) runs.push({ a, b: pts.length - 1 })
    let prevDir: number | null = null
    for (const run of runs) {
      const chord = Math.hypot(
        pts[run.b].x - pts[run.a].x,
        pts[run.b].y - pts[run.a].y,
      )
      if (chord < MIN_STRAIGHT || run.b - run.a < MIN_RUN_SAMPLES) {
        prevDir = null
        continue
      }
      robotic += pathLength(pts, run.a, run.b)
      const dir =
        (Math.atan2(pts[run.b].y - pts[run.a].y, pts[run.b].x - pts[run.a].x) *
          180) /
        Math.PI
      if (prevDir !== null) {
        let turn = Math.abs(dir - prevDir) % 360
        if (turn > 180) turn = 360 - turn
        if (Math.abs(turn - 90) <= ANGLE_TOL) rightAngle = true
        else if (
          Math.abs(turn - 45) <= ANGLE_TOL ||
          Math.abs(turn - 135) <= ANGLE_TOL
        )
          diagonal = true
      }
      prevDir = dir
    }
  }
  return {
    flagged: total > 0 && robotic / total >= ROBOT_RATIO,
    rightAngle,
    diagonal,
  }
}

export function botMessage(verdict: {
  rightAngle: boolean
  diagonal: boolean
}) {
  if (verdict.rightAngle) return pick(RIGHT_ANGLE_LINES)
  if (verdict.diagonal) return pick(DIAGONAL_LINES)
  return pick(STRAIGHT_LINES)
}
