import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"

const entry = (seq: number, message: SessionMessage.Message) => ({ seq, message })
const at = (millis: number) => DateTime.makeUnsafe(millis)
const id = (value: string) => value as SessionMessage.ID
const modelRef = { id: "test" as never, providerID: "test" as never }

test("extractPinned returns the last non-empty user message", () => {
  const user1 = SessionMessage.User.make({
    id: id("msg_1"),
    type: "user",
    text: "refactor the parser",
    time: { created: at(1) },
  })
  const user2 = SessionMessage.User.make({
    id: id("msg_2"),
    type: "user",
    text: "from now on, always reply in Chinese",
    time: { created: at(2) },
  })
  const pinned = SessionCompaction.extractPinned([entry(1, user1), entry(2, user2)])
  expect(pinned).toBe("from now on, always reply in Chinese")
})

test("extractPinned skips assistant and empty user messages", () => {
  const assistant = SessionMessage.Assistant.make({
    id: id("msg_3"),
    type: "assistant",
    agent: "build",
    model: modelRef,
    content: [],
    time: { created: at(3) },
  })
  const empty = SessionMessage.User.make({
    id: id("msg_4"),
    type: "user",
    text: "   ",
    time: { created: at(4) },
  })
  const user = SessionMessage.User.make({
    id: id("msg_5"),
    type: "user",
    text: "keep this one",
    time: { created: at(5) },
  })
  const pinned = SessionCompaction.extractPinned([entry(1, assistant), entry(2, empty), entry(3, user)])
  expect(pinned).toBe("keep this one")
})

test("extractPinned skips compaction messages but pins the oldest user instruction", () => {
  const compaction = SessionMessage.Compaction.make({
    id: id("msg_6"),
    type: "compaction",
    reason: "auto",
    summary: "earlier",
    recent: "",
    time: { created: at(6) },
  })
  const user = SessionMessage.User.make({
    id: id("msg_7"),
    type: "user",
    text: "remember the ordering rule",
    time: { created: at(7) },
  })
  const pinned = SessionCompaction.extractPinned([entry(1, compaction), entry(2, user)])
  expect(pinned).toBe("remember the ordering rule")
})

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})


