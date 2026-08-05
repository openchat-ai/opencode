import { describe, expect, test } from "bun:test"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Model, type LLMRequest } from "@opencode-ai/llm"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"

const makeModel = (context?: number) =>
  Model.make({
    id: "test",
    provider: "fake",
    route: context === undefined ? OpenAIChat.route : OpenAIChat.route.with({ limits: { context, output: 50 } }),
  })

const request = (messages: unknown[], overrides: Partial<LLMRequest> = {}): LLMRequest =>
  ({
    model: makeModel().route as unknown as LLMRequest["model"],
    messages,
    system: [],
    tools: [],
    ...overrides,
  }) as unknown as LLMRequest

// Token.estimate is chars / 4.
const chars = (n: number) => "x".repeat(n)

const trigger = (input: {
  messages: unknown[]
  context?: number
  buffer?: number
  watermark?: number
  auto?: boolean
  generation?: Partial<LLMRequest["generation"]>
  system?: unknown[]
  tools?: unknown[]
}) =>
  SessionCompaction.shouldCompact({
    request: request(input.messages, {
      system: (input.system ?? []) as LLMRequest["system"],
      tools: (input.tools ?? []) as LLMRequest["tools"],
      generation: input.generation,
    }),
    model: makeModel(input.context ?? 128_000),
    auto: input.auto ?? true,
    buffer: input.buffer ?? 20_000,
    watermark: input.watermark ?? 64_000,
  })

describe("SessionCompaction.shouldCompact watermark trigger", () => {
  test("does not compact small history under the watermark", () => {
    expect(trigger({ messages: [chars(1_000)] })).toBe(false)
  })

  test("compacts when history exceeds the watermark", () => {
    // chars(300_000) / 4 = 75K tokens > 64K watermark.
    expect(trigger({ messages: [chars(300_000)] })).toBe(true)
  })

  test("watermark counts history messages, not system or tools", () => {
    // Huge system/tools with tiny messages must not trip the watermark (the
    // request still fits in a large context, so only the watermark could fire).
    expect(
      trigger({
        messages: [chars(100)],
        system: [chars(1_000_000)],
        tools: [chars(1_000_000)],
        context: 1_000_000,
      }),
    ).toBe(false)
  })

  test("lower watermark triggers earlier on the same history", () => {
    // chars(200_000) / 4 = 50K tokens.
    const messages = [chars(200_000)]
    expect(trigger({ messages, watermark: 30_000 })).toBe(true)
    expect(trigger({ messages, watermark: 60_000 })).toBe(false)
  })

  test("auto=false disables compaction entirely", () => {
    expect(trigger({ messages: [chars(1_000_000)], auto: false })).toBe(false)
  })

  test("undefined context disables compaction", () => {
    const res = SessionCompaction.shouldCompact({
      request: request([chars(300_000)]),
      model: makeModel(),
      auto: true,
      buffer: 20_000,
      watermark: 64_000,
    })
    expect(res).toBe(false)
  })
})

describe("SessionCompaction.shouldCompact overflow fallback", () => {
  test("compacts before overflowing even below the watermark", () => {
    // context 4K, buffer 1K -> threshold 3K tokens. Big system (chars 20_000/4
    // = 5K tokens) pushes the request over, while messages stay well under the
    // watermark.
    expect(trigger({ messages: [chars(500)], system: [chars(20_000)], context: 4_000, buffer: 1_000 })).toBe(true)
  })

  test("large maxTokens output reserves space", () => {
    // context 4K, buffer 1K. messages 500 + system 500 tokens leave ~3K spare;
    // output=2K still fits, output=3.5K does not.
    const messages = [chars(2_000)]
    const system = [chars(2_000)]
    expect(trigger({ messages, system, context: 4_000, buffer: 1_000, generation: { maxTokens: 2_000 } })).toBe(false)
    expect(trigger({ messages, system, context: 4_000, buffer: 1_000, generation: { maxTokens: 3_500 } })).toBe(true)
  })
})
