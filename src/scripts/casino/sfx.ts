/* ── Sound ──
   A handful of synthesized blips, no audio files. Off by default (it's a
   portfolio; nobody opened it expecting noise) and remembered once turned
   on. The AudioContext is only created on the first sound after opting in,
   which is always inside a user gesture, so autoplay rules never bite. */

import { prefs } from "./store"

let ctx: AudioContext | null = null
let master: GainNode | null = null
let lastTick = 0

function audio() {
  if (!prefs.sound) return null
  if (!ctx) {
    try {
      ctx = new AudioContext()
      master = ctx.createGain()
      master.gain.value = 0.22
      master.connect(ctx.destination)
    } catch {
      return null
    }
  }
  if (ctx.state === "suspended") void ctx.resume()
  return ctx
}

function tone(
  freq: number,
  dur: number,
  { type = "sine" as OscillatorType, vol = 1, slide = 0, delay = 0 } = {},
) {
  const a = audio()
  if (!a || !master) return
  const t = a.currentTime + delay
  const osc = a.createOscillator()
  const g = a.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  osc.connect(g).connect(master)
  osc.start(t)
  osc.stop(t + dur + 0.02)
}

function noise(dur: number, vol = 0.6, cutoff = 1800) {
  const a = audio()
  if (!a || !master) return
  const len = Math.floor(a.sampleRate * dur)
  const buf = a.createBuffer(1, len, a.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2
  const src = a.createBufferSource()
  src.buffer = buf
  const f = a.createBiquadFilter()
  f.type = "lowpass"
  f.frequency.value = cutoff
  const g = a.createGain()
  g.gain.value = vol
  src.connect(f).connect(g).connect(master)
  src.start()
}

export const sfx = {
  click: () => tone(660, 0.05, { type: "triangle", vol: 0.4 }),
  /** Throttled, so a board full of plinko balls stays a patter. */
  tick(pitch = 1) {
    const now = performance.now()
    if (now - lastTick < 28) return
    lastTick = now
    tone(1400 * pitch, 0.03, { type: "square", vol: 0.12 })
  },
  flip: () => noise(0.07, 0.35, 4200),
  bet: () => tone(520, 0.08, { type: "triangle", vol: 0.5, slide: 180 }),
  win(big = false) {
    const notes = big ? [523, 659, 784, 1047] : [659, 988]
    notes.forEach((f, i) => tone(f, 0.18, { type: "triangle", vol: 0.5, delay: i * 0.07 }))
  },
  lose: () => tone(220, 0.35, { type: "sawtooth", vol: 0.25, slide: -140 }),
  crash() {
    noise(0.5, 0.8, 900)
    tone(160, 0.5, { type: "sawtooth", vol: 0.3, slide: -120 })
  },
  cashout: () => {
    tone(880, 0.09, { type: "triangle", vol: 0.45 })
    tone(1320, 0.16, { type: "triangle", vol: 0.45, delay: 0.06 })
  },
}
