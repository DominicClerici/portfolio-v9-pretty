import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CRASH_MAX,
  checkName,
  cleanPlay,
  crashAt,
  crashMsTo,
  crashPoint,
  isClean,
  randomName,
} from "../src/protocol.ts"

test("crash curve and its inverse agree", () => {
  for (const x of [101, 150, 200, 1000, 10_000, CRASH_MAX]) {
    const ms = crashMsTo(x)
    assert.ok(Math.abs(crashAt(ms) - x) <= Math.max(1, x * 0.001), `${x} at ${ms}ms`)
  }
  assert.equal(crashAt(0), 100)
})

// Every point in [1.00, 1.01) floors to 1.00, so 1 − 0.99/1.01 ≈ 1.98% of
// rounds bust there, while any target x still pays back 99% on average
test("bust points: P(>= x) = 0.99 / x, ~2% at 1.00x, capped", () => {
  assert.equal(crashPoint(0), 100)
  assert.equal(crashPoint(0.0099), 100)
  assert.equal(crashPoint(0.999999999), CRASH_MAX)
  const N = 200_000
  let atLeast2 = 0
  let atLeast10 = 0
  let instant = 0
  for (let i = 0; i < N; i++) {
    const p = crashPoint(Math.random())
    if (p >= 200) atLeast2++
    if (p >= 1000) atLeast10++
    if (p === 100) instant++
  }
  assert.ok(Math.abs(atLeast2 / N - 0.495) < 0.01, `P(>=2x) ${atLeast2 / N}`)
  assert.ok(Math.abs(atLeast10 / N - 0.099) < 0.005, `P(>=10x) ${atLeast10 / N}`)
  assert.ok(Math.abs(instant / N - (1 - 0.99 / 1.01)) < 0.003, `P(1.00x) ${instant / N}`)
})

test("names: shape rules", () => {
  assert.equal(checkName("ok_name-1.2").ok, true)
  assert.equal(checkName("a").ok, false)
  assert.equal(checkName("x".repeat(21)).ok, false)
  assert.equal(checkName("has space").ok, false)
  assert.equal(checkName("<script>").ok, false)
  assert.equal(checkName("___").ok, false)
  assert.equal(checkName("  padded  ").ok, true)
  assert.equal(checkName(42).ok, false)
})

test("names: filter catches the obvious, spares the innocent", () => {
  for (const bad of ["fuck", "FuCk_you", "sh1t", "ass", "ass42", "b1tch", "d1ck", "nazi_boi"]) {
    assert.equal(isClean(bad), false, bad)
  }
  for (const good of ["class", "raccoon", "grape", "torpedo", "cocktail_dev", "assert", "basement", "therapist", "dickens_fan"]) {
    assert.equal(isClean(good), true, good)
  }
})

test("generated names are always valid", () => {
  for (let i = 0; i < 2000; i++) {
    const n = randomName()
    assert.equal(checkName(n).ok, true, n)
  }
})

test("relayed plays are rebuilt from known fields only", () => {
  const plinko = cleanPlay("plinko", { bet: 100, rows: 12, risk: 1, path: 4095, mult: 3300, evil: "<img>" })
  assert.deepEqual(plinko, { bet: 100, rows: 12, risk: 1, path: 4095, mult: 3300 })
  assert.equal(cleanPlay("plinko", { bet: 100, rows: 12, risk: 1, path: 4096, mult: 1 }), null)
  assert.equal(cleanPlay("plinko", { bet: 100, rows: 9, risk: 1, path: 1, mult: 1 }), null)
  assert.equal(cleanPlay("merge", { o: 0, t: 0, c: 0, r: "o", ms: 5200, win: 0 }), null)
  assert.deepEqual(cleanPlay("merge", { o: 10, t: 0, c: 5, r: "c", ms: 5200, win: 70 }), { o: 10, t: 0, c: 5, r: "c", ms: 5200, win: 70 })
  assert.equal(cleanPlay("bigo", { s: "hack", bet: 1, card: 0, suit: 0, mult: 100, n: 0 }), null)
  assert.equal(cleanPlay("bigo", { s: "win", bet: 1, card: 13, suit: 0, mult: 100, n: 0 }), null)
  assert.equal(cleanPlay("bigo", { s: "win", bet: 1.5, card: 1, suit: 0, mult: 100, n: 0 }), null)
  assert.equal(cleanPlay("crash", {}), null)
  assert.equal(cleanPlay("bigo", null), null)
})
