import { afterEach, expect, test } from "bun:test"
import { ImageRenderable } from "@opentui/core"
import { MouseButtons } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import type { SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageUser } from "@opencode-ai/client"
import { sessionImageKeys, sessionMessageImages, SessionImages, ToolImages } from "../../../src/routes/session"

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg=="
const image = { type: "file" as const, uri: `data:image/png;base64,${PNG_1X1_BASE64}`, mime: "image/png" }
let setup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

test("renders bounded inline images from completed tool content", async () => {
  let opened = -1
  setup = await testRender(
    () => toolImages([image, image, image, image, image, image, image], (_, index) => (opened = index)),
    {
      width: 80,
      height: 70,
    },
  )
  await setup.renderOnce()

  const first = setup.renderer.root.findDescendantById("session-image-message-1:call-1:1")
  const second = setup.renderer.root.findDescendantById("session-image-message-1:call-1:2")
  if (!(first instanceof ImageRenderable)) throw new Error("Tool image did not render")
  if (!(second instanceof ImageRenderable)) throw new Error("Second tool image did not render")
  await first.loadPromise

  expect(first.fit).toBe("cover")
  expect(first.protocol).toBe("auto")
  expect(first.width).toBe(16)
  expect(first.height).toBe(8)
  expect(second.y).toBe(first.y)
  expect(second.x).toBe(first.x + first.width + 1)
  expect(setup.renderer.root.findDescendantById("session-image-message-1:call-1:3")).toBeInstanceOf(ImageRenderable)
  expect(setup.renderer.root.findDescendantById("session-image-message-1:call-1:0")).toBeUndefined()
  expect(setup.renderer.root.findDescendantById("session-image-message-1:call-1:4")).toBeUndefined()
  expect(setup.captureCharFrame()).toContain("+3 more")

  await setup.mockMouse.click(first.x, first.y, MouseButtons.LEFT)
  expect(opened).toBe(0)
})

test("does not expose external image tool content to the renderer", () => {
  expect(
    sessionMessageImages(
      assistant("message-1", [
        tool([
          { type: "file", uri: "https://example.test/image.png", mime: "image/png" },
          { type: "file", uri: "file:///tmp/image.png", mime: "image/png" },
          { type: "file", uri: "data:text/plain;base64,SGVsbG8=", mime: "text/plain" },
        ]),
      ]),
    ),
  ).toEqual([])
})

test("does not render session images without the opt-in setting", async () => {
  const part = tool([image])
  setup = await testRender(() => <ToolImages parts={[{ messageID: "message-1", part }]} visible={new Set()} />, {
    width: 80,
    height: 24,
  })
  await setup.renderOnce()

  expect(setup.renderer.root.findDescendantById("session-image-message-1:call-1:0")).toBeUndefined()
})

test("renders images submitted in user prompts", async () => {
  const message: SessionMessageUser = {
    type: "user",
    id: "message-user",
    text: "What is in this image?",
    files: [{ data: PNG_1X1_BASE64, mime: "image/png", source: { type: "inline" }, name: "prompt.png" }],
    time: { created: 1 },
  }
  setup = await testRender(
    () => <SessionImages images={sessionMessageImages(message)} visible={sessionImageKeys([message])} />,
    { width: 80, height: 24 },
  )
  await setup.renderOnce()

  const preview = setup.renderer.root.findDescendantById("session-image-message-user:file:0")
  if (!(preview instanceof ImageRenderable)) throw new Error("User image did not render")
  await preview.loadPromise

  expect(preview.fit).toBe("cover")
})

test("does not reserve image slots for reverted messages", () => {
  const visible = assistant("message-1", [tool([image])])
  const reverted = assistant("message-2", [tool([image, image, image, image, image, image])])

  expect([...sessionImageKeys([visible, reverted], reverted.id)]).toEqual(["message-1:call-1:0"])
})

test("falls back when inline image content is malformed", async () => {
  setup = await testRender(
    () => toolImages([{ type: "file", uri: "data:image/png;base64,aW52YWxpZA==", mime: "image/png" }]),
    { width: 80, height: 24 },
  )
  await setup.renderOnce()

  const preview = setup.renderer.root.findDescendantById("session-image-message-1:call-1:0")
  if (!(preview instanceof ImageRenderable)) throw new Error("Tool image did not render")
  await preview.loadPromise

  expect(await setup.waitForFrame((frame) => frame.includes("No preview"))).toContain("No preview")
})

function toolImages(
  content: Extract<SessionMessageAssistantTool["state"], { status: "completed" }>["content"],
  onOpen?: (images: readonly { key: string; uri: string }[], index: number) => void,
) {
  const part = tool(content)
  const message = assistant("message-1", [part])
  return <ToolImages parts={[{ messageID: message.id, part }]} visible={sessionImageKeys([message])} onOpen={onOpen} />
}

function assistant(id: string, content: SessionMessageAssistant["content"]): SessionMessageAssistant {
  return {
    type: "assistant",
    id,
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content,
    time: { created: 1 },
  }
}

function tool(
  content: Extract<SessionMessageAssistantTool["state"], { status: "completed" }>["content"],
): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: "call-1",
    name: "image",
    state: { status: "completed", input: {}, content },
    time: { created: 0, completed: 1 },
  }
}
