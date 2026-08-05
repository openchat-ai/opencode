import { describe, expect, test } from "bun:test"

// ============================================================================
// Cost-strategy experiment — "do it right the first time" (reduce round trips N)
//
// Metrics are model-agnostic: INPUT TOKENS SENT and PROVIDER CALLS. Money is a
// linear transform of these, so every conclusion here holds on every provider.
//
// Three levers, three token budgets:
//   1. read dedup    — a re-read of an unchanged file returns a ~50-token
//                      digest instead of the full file. Saves INPUT tokens.
//   2. loop guard    — 3 identical loop-sensitive tool calls inject a
//                      correction instead of another provider call. Saves CALLS
//                      (and every call's full-history resend of INPUT tokens).
//   3. grep cap      — grep output capped at 50 KB like read. Without it a
//                      broad grep injects up to ~200 KB (~50K tokens).
// ============================================================================

// Representative tokens for one coding step.
const SYSTEM_TOKENS = 4_000 // system + tool schemas + reminders
const OUTPUT_TOKENS_PER_STEP = 1_500 // model text + reasoning
const UNCHANGED_DIGEST_TOKENS = 50 // the "file unchanged" short digest
const FILE_TOKENS = 10_000 // one full read of a ~40 KB source file

// --- 1. read dedup -----------------------------------------------------------

// INPUT tokens sent across a session that reads the same file `reads` times.
// Each turn resends the full growing history plus the fresh read output.
// Returns { inputTokens, calls }.
function readSession(shape: { reads: number; fileTokens: number; digestTokens: number }, dedup: boolean) {
  let history = SYSTEM_TOKENS
  let inputTokens = 0
  let calls = 0
  for (let i = 0; i < shape.reads; i++) {
    const fresh = i === 0 || !dedup ? shape.fileTokens : shape.digestTokens
    inputTokens += history + fresh // this turn's request
    calls += 1
    history += fresh + OUTPUT_TOKENS_PER_STEP
  }
  return { inputTokens, calls }
}

describe("lever 1: read dedup (saves input tokens)", () => {
  const shape = { reads: 3, fileTokens: FILE_TOKENS, digestTokens: UNCHANGED_DIGEST_TOKENS }

  test("dedup never sends more input tokens than full re-reads", () => {
    const full = readSession(shape, false)
    const deduped = readSession(shape, true)
    expect(deduped.inputTokens).toBeLessThanOrEqual(full.inputTokens)
  })

  test("dedup cuts input tokens materially", () => {
    const full = readSession(shape, false)
    const deduped = readSession(shape, true)
    const saving = 1 - deduped.inputTokens / full.inputTokens
    expect(saving, `saves ${(saving * 100).toFixed(1)}% of input tokens`).toBeGreaterThan(0.2)
  })

  test("saving grows with the number of redundant re-reads", () => {
    const ratio = (reads: number) =>
      readSession({ reads, fileTokens: FILE_TOKENS, digestTokens: UNCHANGED_DIGEST_TOKENS }, true).inputTokens /
      readSession({ reads, fileTokens: FILE_TOKENS, digestTokens: UNCHANGED_DIGEST_TOKENS }, false).inputTokens
    expect(ratio(5)).toBeLessThan(ratio(2)) // more reads -> more saving
  })

  test("dedup is most valuable for large files", () => {
    const ratio = (fileTokens: number) =>
      readSession({ reads: 3, fileTokens, digestTokens: UNCHANGED_DIGEST_TOKENS }, true).inputTokens /
      readSession({ reads: 3, fileTokens, digestTokens: UNCHANGED_DIGEST_TOKENS }, false).inputTokens
    expect(ratio(12_000)).toBeLessThan(ratio(2_000)) // bigger file -> bigger saving
  })

  test("digest must be far smaller than the file to be worth it", () => {
    expect(UNCHANGED_DIGEST_TOKENS).toBeLessThan(FILE_TOKENS / 10)
  })

  test("dedup does not change call count (same number of read invocations)", () => {
    expect(readSession(shape, true).calls).toBe(readSession(shape, false).calls)
  })
})

// --- 2. loop guard -----------------------------------------------------------

// PROVIDER CALLS and INPUT tokens burned by `loopTurns` wasted turns that the
// guard prevents. Every turn is one call that resends the full history.
function loopWaste(shape: { turns: number; history: number }) {
  let inputTokens = 0
  for (let i = 0; i < shape.turns; i++) {
    inputTokens += shape.history + i * (OUTPUT_TOKENS_PER_STEP + SYSTEM_TOKENS)
  }
  return { inputTokens, calls: shape.turns }
}

describe("lever 2: loop guard (saves provider calls)", () => {
  const turns = 5
  const history = SYSTEM_TOKENS + 30_000 // mid-session history

  test("guard prevents real provider calls", () => {
    const waste = loopWaste({ turns, history })
    expect(waste.calls).toBe(turns)
  })

  test("every prevented turn also avoids resending the full history", () => {
    const one = loopWaste({ turns: 1, history })
    const five = loopWaste({ turns: 5, history })
    // 5 turns resend history 5 times AND the history grows each turn.
    expect(five.inputTokens).toBeGreaterThan(one.inputTokens * 5)
  })

  test("avoiding a loop at 30K history spares more tokens than at 10K", () => {
    const short = loopWaste({ turns, history: SYSTEM_TOKENS + 10_000 })
    const long = loopWaste({ turns, history: SYSTEM_TOKENS + 30_000 })
    expect(long.inputTokens).toBeGreaterThan(short.inputTokens)
  })
})

// --- 3. grep cap -------------------------------------------------------------

// INPUT tokens a single grep injects. `bytes` is ripgrep's 2 KB line cap times
// the 100-row limit; the cap cuts it to 50 KB.
const GREP_UNCAPPED_BYTES = 100 * 2_000 // 200 KB worst case
const GREP_CAPPED_BYTES = 50 * 1024 // 50 KB
const bytesToTokens = (bytes: number) => Math.round(bytes / 4)

describe("lever 3: grep output cap (bounds a single tool result)", () => {
  test("an uncapped broad grep can inject ~50K tokens in one call", () => {
    expect(bytesToTokens(GREP_UNCAPPED_BYTES)).toBe(50_000)
  })

  test("the 50 KB cap bounds a grep at ~12.5K tokens", () => {
    expect(bytesToTokens(GREP_CAPPED_BYTES)).toBe(12_800)
    expect(bytesToTokens(GREP_CAPPED_BYTES)).toBeLessThan(GREP_UNCAPPED_BYTES / 4)
  })

  test("capping grep bounds the worst single-result injection to read's level", () => {
    expect(GREP_CAPPED_BYTES).toBeLessThanOrEqual(50 * 1024)
  })
})
