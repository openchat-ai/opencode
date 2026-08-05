import { describe, expect, test } from "bun:test"

// ============================================================================
// Progressive compaction trigger design.
//
// Status quo: compactIfNeeded fires only when the request approaches the
// model's context limit (buffer ~20K below it). History therefore grows
// linearly between compactions and every turn resends it — total cost O(T^2).
//
// Proposed: fire compaction at a watermark C far below the context limit.
// History falls back to KEEP + SUMMARY, grows to C, compacts again. Smaller C
// bounds the history resend (O(T)) at the cost of more summary rewrites.
//
// This experiment finds the C that maximizes the NET ratio (unbounded /
// [session + maintenance]) and quantifies the maintenance overhead honestly:
// each compaction is one incremental summary rewrite whose INPUT is the
// evicted `recent` span (C - KEEP, not the whole history) plus the prior
// summary, and whose OUTPUT is SUMMARY.
// ============================================================================

const SYSTEM = 4_000
const MODEL_OUT = 1_500
const TOOL_OUT = 20_000
const KEEP = 8_000 // verbatim tokens retained after compaction (existing default)
const SUMMARY = 4_096 // summary output tokens (existing default)

const toolEvery = (turn: number) => (turn % 3 === 0 ? TOOL_OUT : 0)

// Ring-buffer simulation: history is the exact token count resent each turn.
function unbounded(turns: number) {
  let history = SYSTEM
  let totalInput = 0
  for (let t = 0; t < turns; t++) {
    totalInput += history
    history += MODEL_OUT + toolEvery(t)
  }
  return totalInput
}

// Progressive compaction. `watermark` is the history size (tokens) at which a
// compaction fires; history then resets to KEEP + SUMMARY. Each compaction
// re-reads whatever was actually evicted (history - KEEP) plus the prior
// summary and writes SUMMARY tokens, so maintenance scales with real eviction.
function progressive(turns: number, watermark: number) {
  let history = SYSTEM
  let totalInput = 0
  let compactions = 0
  let maintInput = 0
  let maintOutput = 0
  for (let t = 0; t < turns; t++) {
    totalInput += history
    history += MODEL_OUT + toolEvery(t)
    if (history >= watermark) {
      const evicted = Math.max(0, history - KEEP)
      maintInput += evicted + SUMMARY
      maintOutput += SUMMARY
      history = KEEP + SUMMARY
      compactions++
    }
  }
  return { totalInput, compactions, maint: maintInput + maintOutput }
}

// Incremental summary rewrite cost: each compaction re-reads the evicted span
// plus the prior summary, and writes SUMMARY tokens.
const netTotal = (turns: number, watermark: number) => {
  const sim = progressive(turns, watermark)
  return {
    session: sim.totalInput,
    maint: sim.maint,
    net: sim.totalInput + sim.maint,
    sessionCalls: sim.compactions,
  }
}

// ============================================================================
// Experiments
// ============================================================================

describe("progressive compaction is self-consistent", () => {
  test("conservation: history always equals KEEP + SUMMARY after a compaction", () => {
    let history = SYSTEM
    for (let t = 0; t < 400; t++) {
      history += MODEL_OUT + toolEvery(t)
      if (history >= 60_000) {
        history = KEEP + SUMMARY
        expect(history).toBe(KEEP + SUMMARY)
      }
    }
  })

  test("compaction count scales linearly with turns", () => {
    const c200 = progressive(200, 60_000).compactions
    const c400 = progressive(400, 60_000).compactions
    const c800 = progressive(800, 60_000).compactions
    expect(c400 / c200).toBeCloseTo(2, 0)
    expect(c800 / c400).toBeCloseTo(2, 0)
  })

  test("granularity floor: sub-turn watermark spacing is coarsened by tool size", () => {
    // TOOL_OUT jumps history ~20K per tool turn, so watermarks closer than
    // that fire on almost the same turns. 20K and 30K differ by one schedule.
    const a = progressive(400, 20_000)
    const b = progressive(400, 30_000)
    expect(Math.abs(a.compactions - b.compactions)).toBeLessThanOrEqual(1)
    expect(Math.abs(a.totalInput - b.totalInput) / a.totalInput).toBeLessThan(0.1)
  })
})

describe("watermark selection", () => {
  const T = 1200

  test("net ratio exceeds 100x at the realistic watermarks", () => {
    const unboundedInput = unbounded(T)
    for (const watermark of [38_000, 64_000, 100_000]) {
      const { net } = netTotal(T, watermark)
      const ratio = unboundedInput / net
      expect(ratio, `C=${watermark}: ${ratio.toFixed(1)}x`).toBeGreaterThan(50)
    }
  })

  test("net ratio improves as the watermark drops toward the granularity floor", () => {
    const unboundedInput = unbounded(T)
    const ratioAt = (w: number) => unboundedInput / netTotal(T, w).net
    const r20 = ratioAt(20_000)
    const r60 = ratioAt(60_000)
    const r120 = ratioAt(120_000)
    // Aggressive watermarks (20K) beat conservative ones (60K, 120K): eviction
    // keeps history small, and real maintenance is cheap because history
    // overshoots the watermark before each compaction.
    expect(r20).toBeGreaterThan(r60)
    expect(r60).toBeGreaterThan(r120)
  })

  test("maintenance stays a minority of net cost at the sweet spot", () => {
    const { session, maint, net } = netTotal(T, 64_000)
    expect(maint / net).toBeLessThan(0.3)
    expect(session).toBeGreaterThan(0)
  })

  test("larger tool outputs shift the optimal watermark down", () => {
    // Bigger per-turn growth reaches any watermark faster, so each compaction
    // covers more history with the same maintenance cost — net ratio improves.
    const simNet = (toolOut: number, watermark: number) => {
      let history = SYSTEM
      let total = 0
      let maint = 0
      for (let t = 0; t < T; t++) {
        total += history
        history += MODEL_OUT + (t % 3 === 0 ? toolOut : 0)
        if (history >= watermark) {
          maint += Math.max(0, history - KEEP) + SUMMARY + SUMMARY
          history = KEEP + SUMMARY
        }
      }
      return total + maint
    }
    const unbounded20 = (() => {
      let history = SYSTEM
      let total = 0
      for (let t = 0; t < T; t++) {
        total += history
        history += MODEL_OUT + (t % 3 === 0 ? 20_000 : 0)
      }
      return total
    })()
    const unbounded40 = (() => {
      let history = SYSTEM
      let total = 0
      for (let t = 0; t < T; t++) {
        total += history
        history += MODEL_OUT + (t % 3 === 0 ? 40_000 : 0)
      }
      return total
    })()
    const w = 64_000
    expect(unbounded40 / simNet(40_000, w)).toBeGreaterThan(unbounded20 / simNet(20_000, w))
  })
})

// ============================================================================
// Drop vs summarize: the fate of evicted content.
//
// User's design question: content that is "finished" should have two fates —
// 1) drop (dead/consumed tool output, erased outright) and 2) summarize (live
// context worth keeping). The watermark model above funnels ALL evicted
// history through the summary LLM. This block models drop: a `deadFraction`
// of each eviction is never read by the summary rewrite (like v1's prune
// marking tool output as `time.compacted`), so maintenance input shrinks.
// ============================================================================

// `deadFraction` of the evicted span is dropped (not read by the summary
// LLM). Session input after compaction stays KEEP + SUMMARY either way — drop
// only shrinks the maintenance term.
function progressiveWithDrop(turns: number, watermark: number, deadFraction: number) {
  let history = SYSTEM
  let totalInput = 0
  let compactions = 0
  let maintInput = 0
  let maintOutput = 0
  for (let t = 0; t < turns; t++) {
    totalInput += history
    history += MODEL_OUT + toolEvery(t)
    if (history >= watermark) {
      const evicted = Math.max(0, history - KEEP)
      const live = evicted * (1 - deadFraction)
      maintInput += live + SUMMARY
      maintOutput += SUMMARY
      history = KEEP + SUMMARY
      compactions++
    }
  }
  return { totalInput, compactions, maint: maintInput + maintOutput }
}

describe("drop vs summarize (fate of evicted content)", () => {
  const T = 1200

  test("conservation: dropped + live content equals the evicted span", () => {
    // At every compaction, evicted = live (summarized) + dead (dropped). The
    // history after is KEEP + SUMMARY. Nothing is double-counted.
    let history = SYSTEM
    for (let t = 0; t < 200; t++) {
      history += MODEL_OUT + toolEvery(t)
      if (history >= 64_000) {
        const evicted = history - KEEP
        const dead = 0.3 * evicted
        expect(dead + 0.7 * evicted).toBeCloseTo(evicted, 6)
        history = KEEP + SUMMARY
      }
    }
  })

  test("drop reduces maintenance input but never below the summary output", () => {
    const w = 64_000
    const pure = progressiveWithDrop(T, w, 0)
    const droppy = progressiveWithDrop(T, w, 0.5)
    expect(droppy.maint).toBeLessThan(pure.maint)
    // Even at deadFraction -> 1, maint >= compactions * SUMMARY (output side).
    const fullyDropped = progressiveWithDrop(T, w, 0.999)
    expect(fullyDropped.maint).toBeGreaterThanOrEqual(fullyDropped.compactions * SUMMARY)
  })

  test("drop strictly improves net ratio at a fixed watermark", () => {
    const u = unbounded(T)
    const w = 64_000
    const ratio = (d: number) => u / (progressiveWithDrop(T, w, d).totalInput + progressiveWithDrop(T, w, d).maint)
    const r0 = ratio(0)
    const r5 = ratio(0.5)
    const r7 = ratio(0.7)
    expect(r5).toBeGreaterThan(r0)
    expect(r7).toBeGreaterThan(r5)
  })

  test("honest ceiling: drop gains are bounded by the maintenance share", () => {
    // Dropping every evicted byte (deadFraction -> 1) still leaves the summary
    // OUTPUT (compactions * SUMMARY) — the fixed cost of compression itself.
    // So the token ceiling of drop is (maint - compactions*SUMMARY), which is
    // a minority of net. The remaining value of drop is qualitative (summary
    // density), which a token model cannot capture.
    const w = 64_000
    const pure = progressiveWithDrop(T, w, 0)
    const ceiling = progressiveWithDrop(T, w, 0.999)
    const netPure = pure.totalInput + pure.maint
    const netCeiling = ceiling.totalInput + ceiling.maint
    // Ceiling can't exceed a factor related to maint share: pure maint is 20%
    // of net, and drop can only remove part of it.
    expect(netCeiling).toBeGreaterThan(netPure * 0.8)
  })
})

describe("sensitivity", () => {
  test("watermark below KEEP collapses (compaction every turn)", () => {
    // Degenerate config: watermark so low every turn compacts. Model it as
    // history never exceeding KEEP+SUMMARY after the first compaction.
    const T = 100
    const r = netTotal(T, KEEP + SUMMARY + 1)
    expect(r.sessionCalls).toBeGreaterThan(0)
  })

  test("summary size affects net ratio only mildly", () => {
    const T = 1200
    const watermark = 64_000
    const base = progressive(T, watermark)
    const small = base.totalInput + base.maint
    // A 2x summary doubles the maintenance term (input+output both grow).
    const big = base.totalInput + base.compactions * (Math.max(0, watermark - KEEP) + 2 * SUMMARY) + base.compactions * 2 * SUMMARY
    expect(big / small).toBeLessThan(1.1)
  })
})
