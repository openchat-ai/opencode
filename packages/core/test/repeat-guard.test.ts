import { describe, expect, test } from "bun:test"
import { detectRepeatedToolCalls } from "@opencode-ai/core/session/runner/repeat-guard"
import { SessionMessage } from "@opencode-ai/core/session/message"

const tool = (name: string, input: Record<string, unknown>): SessionMessage.AssistantTool =>
  ({
    type: "tool",
    id: name + Math.random(),
    name,
    state: { status: "completed", input, content: [], structured: {} },
    time: { created: new Date(0) },
  }) as unknown as SessionMessage.AssistantTool

const assistant = (content: SessionMessage.AssistantContent[]): SessionMessage.Message =>
  ({
    type: "assistant",
    id: "m",
    agent: "build",
    model: "test",
    content,
    time: { created: new Date(0) },
  }) as unknown as SessionMessage.Message

describe("detectRepeatedToolCalls", () => {
  test("returns undefined for few calls", () => {
    const messages = [assistant([tool("bash", { command: "ls" })]), assistant([tool("bash", { command: "ls" })])]
    expect(detectRepeatedToolCalls(messages)).toBeUndefined()
  })

  test("detects three consecutive identical loop-sensitive calls", () => {
    const messages = [
      assistant([tool("bash", { command: "ls" })]),
      assistant([tool("bash", { command: "ls" })]),
      assistant([tool("bash", { command: "ls" })]),
    ]
    expect(detectRepeatedToolCalls(messages)).toEqual({ tool: "bash", input: '{"command":"ls"}' })
  })

  test("does not flag read-only tools", () => {
    const messages = [
      assistant([tool("read", { filePath: "x" })]),
      assistant([tool("read", { filePath: "x" })]),
      assistant([tool("read", { filePath: "x" })]),
    ]
    expect(detectRepeatedToolCalls(messages)).toBeUndefined()
  })

  test("does not flag different inputs", () => {
    const messages = [
      assistant([tool("bash", { command: "ls" })]),
      assistant([tool("bash", { command: "pwd" })]),
      assistant([tool("bash", { command: "ls" })]),
    ]
    expect(detectRepeatedToolCalls(messages)).toBeUndefined()
  })

  test("does not flag interrupted or failed calls", () => {
    const failed = {
      type: "tool",
      id: "t",
      name: "bash",
      state: { status: "error", error: "boom", input: {}, content: [], structured: {} },
      time: { created: new Date(0) },
    } as unknown as SessionMessage.AssistantTool
    const messages = [
      assistant([failed]),
      assistant([failed]),
      assistant([failed]),
    ]
    expect(detectRepeatedToolCalls(messages)).toBeUndefined()
  })

  test("ignores non-assistant messages and text content", () => {
    const messages = [
      { type: "user", id: "u", text: "hi", time: { created: new Date(0) } } as unknown as SessionMessage.Message,
      assistant([{ type: "text", id: "t", text: "thinking" }]),
      assistant([tool("bash", { command: "ls" })]),
      assistant([tool("bash", { command: "ls" })]),
      assistant([tool("bash", { command: "ls" })]),
    ]
    expect(detectRepeatedToolCalls(messages)).toEqual({ tool: "bash", input: '{"command":"ls"}' })
  })

  test("detects loop spanning multiple tool calls in one message", () => {
    const messages = [
      assistant([tool("bash", { command: "ls" }), tool("bash", { command: "ls" })]),
      assistant([tool("bash", { command: "ls" })]),
    ]
    expect(detectRepeatedToolCalls(messages)).toEqual({ tool: "bash", input: '{"command":"ls"}' })
  })
})
