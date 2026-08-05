import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { applyPrune, selectPrunable } from "@opencode-ai/core/session/prune"
import { SessionMessage } from "@opencode-ai/core/session/message"

const tool = (name: string, input: Record<string, unknown>, content: string): SessionMessage.AssistantTool =>
  ({
    type: "tool",
    id: name,
    name,
    state: { status: "completed", input, content: [{ type: "text", text: content }], structured: {} },
    time: { created: DateTime.makeUnsafe(0) },
  }) as unknown as SessionMessage.AssistantTool

const assistant = (content: SessionMessage.AssistantContent[]): SessionMessage.Assistant =>
  ({
    type: "assistant",
    id: "m",
    agent: "build",
    model: "test",
    content,
    time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
  }) as unknown as SessionMessage.Assistant

describe("selectPrunable", () => {
  test("selects completed tool outputs before the compaction baseline", () => {
    const messages = [
      { seq: 10, message: assistant([tool("bash", { command: "ls" }, "output")]) },
      { seq: 20, message: assistant([tool("read", { filePath: "x" }, "content")]) },
      { seq: 30, message: assistant([tool("bash", { command: "pwd" }, "more")]) },
    ]
    const targets = selectPrunable(messages, { baselineSeq: 30 })
    expect(targets.map((t) => t.seq)).toEqual([10, 20])
  })

  test("skips tool calls at or after the baseline", () => {
    const messages = [
      { seq: 30, message: assistant([tool("bash", { command: "new" }, "fresh")]) },
    ]
    expect(selectPrunable(messages, { baselineSeq: 30 })).toEqual([])
  })

  test("skips running, error, and already-pruned tool parts", () => {
    const pending: SessionMessage.AssistantTool = {
      type: "tool",
      id: "p",
      name: "bash",
      state: { status: "pending", input: {} },
      time: { created: DateTime.makeUnsafe(0) },
    } as unknown as SessionMessage.AssistantTool
    const errored: SessionMessage.AssistantTool = {
      type: "tool",
      id: "e",
      name: "bash",
      state: { status: "error", input: {}, content: [], structured: {}, error: "boom" },
      time: { created: DateTime.makeUnsafe(0) },
    } as unknown as SessionMessage.AssistantTool
    const pruned: SessionMessage.AssistantTool = {
      type: "tool",
      id: "r",
      name: "bash",
      state: { status: "completed", input: {}, content: [], structured: {} },
      time: { created: DateTime.makeUnsafe(0), pruned: DateTime.makeUnsafe(2) },
    } as unknown as SessionMessage.AssistantTool
    const messages = [{ seq: 5, message: assistant([pending, errored, pruned]) }]
    expect(selectPrunable(messages, { baselineSeq: 30 })).toEqual([])
  })

  test("skips uncompleted assistant messages", () => {
    const incomplete = {
      ...assistant([tool("bash", { command: "ls" }, "output")]),
      time: { created: DateTime.makeUnsafe(0) },
    } as unknown as SessionMessage.Assistant
    expect(selectPrunable([{ seq: 5, message: incomplete }], { baselineSeq: 30 })).toEqual([])
  })
})

describe("applyPrune", () => {
  test("zeroes content and structured, marks pruned, keeps other parts", () => {
    const message = assistant([tool("bash", { command: "ls" }, "secret output"), tool("read", { filePath: "x" }, "keep")])
    const prunedAt = DateTime.makeUnsafe(9_000)
    const updated = applyPrune(message, 0, { prunedAt })
    const dropped = updated.content[0]
    expect(dropped.type).toBe("tool")
    if (dropped.type === "tool") {
      expect(dropped.state).toMatchObject({ status: "completed", content: [], structured: {} })
      expect(dropped.time.pruned).toBe(prunedAt)
    }
    const kept = updated.content[1]
    if (kept.type === "tool") expect(kept.state).toMatchObject({ content: [{ type: "text", text: "keep" }] })
  })

  test("applyPrune is immutable", () => {
    const message = assistant([tool("bash", { command: "ls" }, "data")])
    const updated = applyPrune(message, 0, { prunedAt: DateTime.makeUnsafe(1) })
    expect(message).not.toBe(updated)
    const original = message.content[0]
    if (original.type === "tool") {
      expect(original.state).toMatchObject({ content: [{ type: "text", text: "data" }] })
      expect(original.time.pruned).toBeUndefined()
    }
  })

  test("does nothing when the index is not a completed tool", () => {
    const text = { type: "text", id: "t", text: "hello" } as SessionMessage.AssistantText
    const message = assistant([text])
    const updated = applyPrune(message, 0, { prunedAt: DateTime.makeUnsafe(1) })
    expect(updated).toBe(message)
  })
})
