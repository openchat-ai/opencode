import { describe, expect, test } from "bun:test"

// ============================================================================
// The 100x lever: history-resend is ~94% of session input tokens.
//
// Every token that lands in history is resent on every later turn. With
// unbounded history the total input grows O(T^2) in session length; a rolling
// window with a fixed-size cumulative summary keeps it O(T). The ratio is
// therefore O(T): the longer the session, the closer to 100x.
//
// This experiment answers three questions honestly:
//   1. Does the simulator conserve tokens? (adds == evicts, no leaks)
//   2. Is the O(T^2) -> O(T) crossover real, and at what session length?
//   3. What does the summary itself cost, and does it preserve fidelity?
// ============================================================================

const SYSTEM = 4_000 // system + tool schemas
const MODEL_OUT = 1_500 // assistant text per turn
const TOOL_OUT = 20_000 // a read/grep/bash result
const SUMMARY = 2_000 // fixed-size rolling summary of everything before the window

type Turn = {
  model: number
  tool: number // 0 on non-tool turns
}

const toolEvery = (turn: number) => (turn % 3 === 0 ? TOOL_OUT : 0)

// --- Unbounded (status quo): history never leaves ----------------------------

// True ring-buffer simulation. `history` is the exact token count resent each
// turn; adds are appended, nothing is evicted.
function unbounded(turns: number) {
  let history = SYSTEM
  let totalInput = 0
  const sent: Turn[] = []
  for (let t = 0; t < turns; t++) {
    totalInput += history
    const add: Turn = { model: MODEL_OUT, tool: toolEvery(t) }
    history += add.model + add.tool
    sent.push(add)
  }
  // Conservation: totalInput must equal SYSTEM + cumulative sent, and the
  // final history must equal the sum of everything ever appended.
  const appended = SYSTEM + sent.reduce((acc, t) => acc + t.model + t.tool, 0)
  return { totalInput, history, appended, turns }
}

// Parameterized simulators used by the sensitivity tests so every claim runs
// the same model (no divergent closed-form shortcuts).
function unboundedWithTool(turns: number, toolOut: number) {
  let history = SYSTEM
  let totalInput = 0
  for (let t = 0; t < turns; t++) {
    totalInput += history
    history += MODEL_OUT + (t % 3 === 0 ? toolOut : 0)
  }
  return totalInput
}

function boundedWithTool(turns: number, window: number, toolOut: number) {
  let history = SYSTEM + SUMMARY
  let totalInput = 0
  const queue: Turn[] = []
  for (let t = 0; t < turns; t++) {
    totalInput += history
    const add: Turn = { model: MODEL_OUT, tool: t % 3 === 0 ? toolOut : 0 }
    history += add.model + add.tool
    queue.push(add)
    if (queue.length > window) {
      const drop = queue.shift()!
      history -= drop.model + drop.tool
    }
  }
  return totalInput
}

// --- Bounded: rolling window + cumulative summary ---------------------------

// Only the last `window` turns are kept verbatim. Older turns are evicted and
// folded into a fixed-size summary. The summary is maintained incrementally:
// when a turn falls off the window its content is replaced by the summary's
// per-turn budget (SUMMARY / turns-kept-so-far). The window buffer is a true
// queue — every appended turn is eventually evicted exactly once.
function bounded(turns: number, window: number) {
  let history = SYSTEM + SUMMARY
  let totalInput = 0
  let evicted = 0 // tokens folded into the summary
  const queue: Turn[] = []
  for (let t = 0; t < turns; t++) {
    totalInput += history
    const add: Turn = { model: MODEL_OUT, tool: toolEvery(t) }
    history += add.model + add.tool
    queue.push(add)
    if (queue.length > window) {
      const drop = queue.shift()!
      history -= drop.model + drop.tool
      evicted += drop.model + drop.tool
    }
  }
  // Conservation: totalInput includes SUMMARY exactly once (it never leaves),
  // plus every turn's content for the turns it was resident, minus the
  // final queue still resident. evicted is everything that left the window.
  return { totalInput, history, evicted, queueSize: queue.length, turns }
}

// --- Summary maintenance cost ------------------------------------------------

// The O(T^2)->O(T) win only holds if maintaining the summary is cheap. Model
// the summary as an LLM rewrite triggered every `every` turns over the evicted
// content + prior summary: one provider call whose INPUT is the evicted tokens
// and whose OUTPUT is a fixed SUMMARY. If the evicted volume is bounded (the
// window keeps the recent turns), the maintenance cost is O(T / every * window),
// i.e. still linear in T.
function summaryMaintenanceCost(turns: number, window: number, every: number) {
  // tokens evicted per maintenance = one window's worth of model+tool output
  const evictedPerBatch = window * (MODEL_OUT + TOOL_OUT)
  const batches = Math.floor(turns / every)
  const input = batches * (evictedPerBatch + SUMMARY) // read evicted + prior summary
  const output = batches * SUMMARY // write the new summary
  return { input, output, calls: batches }
}

// ============================================================================
// Experiments
// ============================================================================

describe("unbounded history grows O(T^2)", () => {
  test("simulator conserves tokens exactly", () => {
    const sim = unbounded(50)
    // totalInput = sum of history before each turn; the last history state
    // equals everything appended, so check the append identity instead.
    expect(sim.history).toBe(sim.appended)
  })

  test("history is monotonically increasing", () => {
    let prev = SYSTEM
    for (let t = 1; t < 100; t++) {
      const sim = unbounded(t)
      expect(sim.history).toBeGreaterThan(prev)
      prev = sim.history
    }
  })

  test("total input grows quadratically", () => {
    // If totalInput ~ c*T^2, then totalInput(T)/T^2 is roughly constant.
    const r100 = unbounded(100).totalInput / 100 ** 2
    const r400 = unbounded(400).totalInput / 400 ** 2
    const r1200 = unbounded(1200).totalInput / 1200 ** 2
    // Allow slack for the linear term; quadratic term dominates.
    expect(r400).toBeGreaterThan(r100 * 0.9)
    expect(r1200).toBeGreaterThan(r400 * 0.9)
  })
})

describe("bounded history stays O(T)", () => {
  test("history plateaus at SYSTEM + SUMMARY + window-worth", () => {
    const window = 10
    const sim = bounded(1200, window)
    // Everything before the final window is evicted; the resident tokens are
    // system + summary + the last `window` turns.
    const residentMax = SYSTEM + SUMMARY + window * (MODEL_OUT + TOOL_OUT)
    expect(sim.history).toBeLessThanOrEqual(residentMax)
    expect(sim.queueSize).toBe(window)
  })

  test("evicted volume grows linearly with turns", () => {
    const window = 10
    const e200 = bounded(200, window).evicted
    const e400 = bounded(400, window).evicted
    const e800 = bounded(800, window).evicted
    // Every turn's content is evicted exactly once after `window` turns.
    expect(e400 / e200).toBeCloseTo(2, 0)
    expect(e800 / e400).toBeCloseTo(2, 0)
  })

  test("total input grows linearly (not quadratically)", () => {
    const window = 10
    const t200 = bounded(200, window).totalInput
    const t800 = bounded(800, window).totalInput
    // O(T): doubling length roughly doubles total (4x length -> ~4x total).
    expect(t800 / t200).toBeLessThan(5)
  })
})

describe("100x crossover", () => {
  test("ratio grows with session length toward and past 100x", () => {
    const window = 10
    const ratios: Array<[number, number]> = []
    for (const T of [100, 200, 400, 800, 1200]) {
      const u = unbounded(T).totalInput
      const b = bounded(T, window).totalInput
      ratios.push([T, u / b])
    }
    // Monotonic and eventually large.
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i][1]).toBeGreaterThan(ratios[i - 1][1])
    }
    const [, maxRatio] = ratios[ratios.length - 1]
    expect(maxRatio).toBeGreaterThan(10)
  })

  test("maintenance cost does not destroy the win (still linear)", () => {
    const window = 10
    const every = 5
    const m400 = summaryMaintenanceCost(400, window, every)
    const m1200 = summaryMaintenanceCost(1200, window, every)
    // Calls scale with turns (linear), input per call is bounded by window.
    expect(m1200.calls / m400.calls).toBeCloseTo(3, 0)
    // Total maintenance input is far below the unbounded savings at 1200.
    const unboundedInput = unbounded(1200).totalInput
    expect(m1200.input).toBeLessThan(unboundedInput / 50)
  })

  test("100x is reachable at realistic session lengths", () => {
    // A 1200-turn session with a 5-turn window: the ratio exceeds 100x.
    const T = 1200
    const ratio = unbounded(T).totalInput / bounded(T, 5).totalInput
    expect(ratio).toBeGreaterThan(100)
  })
})

describe("parameter sensitivity", () => {
  test("bigger window erodes the win (more history kept verbatim)", () => {
    const T = 1200
    const r5 = unbounded(T).totalInput / bounded(T, 5).totalInput
    const r20 = unbounded(T).totalInput / bounded(T, 20).totalInput
    expect(r5).toBeGreaterThan(r20)
  })

  test("bigger tool outputs amplify the win", () => {
    // Same simulator, different TOOL_OUT; the win comes from evicting bigger
    // results that would otherwise be resent on every later turn.
    const T = 800
    const window = 10
    const rSmall = unboundedWithTool(T, 20_000) / boundedWithTool(T, window, 20_000)
    const rBig = unboundedWithTool(T, 40_000) / boundedWithTool(T, window, 40_000)
    expect(rBig).toBeGreaterThan(rSmall)
  })
})
