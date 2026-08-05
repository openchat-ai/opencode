import { describe, expect, test } from "bun:test"
import {
  partitionInstructions,
  renderHistorical,
  HISTORICAL_HEADER,
  DEFAULT_DECAY_DAYS,
} from "@opencode-ai/core/instruction-context"

const day = (offset: number) => {
  const d = new Date(Date.UTC(2026, 6, 15))
  d.setUTCDate(d.getUTCDate() + offset)
  return d
}

// A typical AGENTS.md: undated standing constraint + dated lessons.
const agents = `# Project rules

## Always run typecheck before commit
This is a standing constraint.

## ONNX LSTM layout note (2026-07-14)
The default layout is [i,o,f,c].

## AutoDL download note (2026-01-05)
Use hf download with HF_ENDPOINT.

## General principle
Another undated section.
`

describe("partitionInstructions", () => {
  test("keeps undated sections active forever", () => {
    const now = day(400) // well past any decay window
    const { active, historical } = partitionInstructions(agents, { now })
    expect(active).toContain("Always run typecheck before commit")
    expect(active).toContain("General principle")
    expect(historical).not.toContain("Always run typecheck before commit")
  })

  test("moves dated lessons older than the window to historical", () => {
    const now = day(400)
    const { active, historical } = partitionInstructions(agents, { now })
    // 2026-07-14 is ~5 months before "now"; 2026-01-05 is even older.
    expect(active).not.toContain("ONNX LSTM layout note")
    expect(historical).toContain("ONNX LSTM layout note")
    expect(historical).toContain("AutoDL download note")
  })

  test("keeps recent dated lessons active", () => {
    const now = day(0) // 2026-07-15
    const { active, historical } = partitionInstructions(agents, { now })
    expect(active).toContain("ONNX LSTM layout note")
    expect(historical).not.toContain("ONNX LSTM layout note")
    // 2026-01-05 is older than 90 days from 2026-07-15.
    expect(historical).toContain("AutoDL download note")
  })

  test("decay window is configurable", () => {
    const now = day(100)
    const narrow = partitionInstructions(agents, { now, decayDays: 30 })
    const wide = partitionInstructions(agents, { now, decayDays: 400 })
    expect(narrow.historical).toContain("ONNX LSTM layout note")
    expect(wide.historical).not.toContain("ONNX LSTM layout note")
  })

  test("default window matches the exported constant", () => {
    expect(partitionInstructions(agents, { now: day(91) }).historical).toContain("ONNX LSTM layout note")
    expect(DEFAULT_DECAY_DAYS).toBe(90)
  })
})

describe("renderHistorical", () => {
  test("adds the historical header when there is historical content", () => {
    const rendered = renderHistorical("## Old note\nstale content", 10_000)
    expect(rendered).toContain(HISTORICAL_HEADER)
    expect(rendered).toContain("## Old note")
  })

  test("returns undefined for empty historical content", () => {
    expect(renderHistorical("", 10_000)).toBeUndefined()
  })

  test("caps historical content at the token budget", () => {
    const big = "## A\n" + "word ".repeat(10_000) // ~2.5K tokens at 4 chars/token
    const rendered = renderHistorical(big, 500)
    expect(rendered).toBeDefined()
    expect(rendered!.length).toBeLessThan(big.length)
    expect(rendered).toContain(HISTORICAL_HEADER)
  })

  test("line-based truncation keeps whole leading lines", () => {
    const big = "## A\n" + "x".repeat(200) + "\n" + "y".repeat(200)
    const rendered = renderHistorical(big, 50) // 50 tokens = 200 chars budget
    expect(rendered).toContain("## A")
    expect(rendered).not.toContain("y".repeat(200))
  })
})
