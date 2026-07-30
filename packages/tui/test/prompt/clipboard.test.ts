import { afterAll, expect, mock, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ImageRenderable,
  TextareaRenderable,
  type ClipboardReadResult,
  type HostClipboardService,
} from "@opentui/core"
import { createTestRenderer, MouseButtons } from "@opentui/core/testing"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/util/global"
import { Effect, FileSystem } from "effect"
import { createComponent } from "solid-js"
import { Prompt, type PromptRef } from "../../src/component/prompt"
import { parsePromptInfo } from "../../src/prompt/history"
import { createEventStream, createFetch } from "../fixture/tui-client"

const openTui = { ...(await import("@opentui/core")) }
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg=="
const PNG_1X1 = Buffer.from(PNG_1X1_BASE64, "base64")
let activeSetup: Awaited<ReturnType<typeof createTestRenderer>> | undefined
let activeHost: HostClipboardService | undefined
let activePromptRef: PromptRef | undefined

await mock.module("@opentui/core", () => ({
  ...openTui,
  createCliRenderer: async () => {
    if (!activeSetup) throw new Error("Prompt renderer is not mounted")
    return activeSetup.renderer
  },
  createHostClipboard: () => {
    if (!activeHost) throw new Error("Prompt clipboard is not mounted")
    return activeHost
  },
}))
await mock.module("../../src/routes/home", () => ({
  Home: () =>
    createComponent(Prompt, {
      ref: (value) => (activePromptRef = value),
      showPlaceholder: false,
    }),
}))
const { run } = await import("../../src/app")

afterAll(() => mock.restore())

async function mountPrompt(read: () => Promise<ClipboardReadResult>, imagePreview = false, width = 80) {
  const setup = await createTestRenderer({ width, height: 24, useThread: false })
  let reads = 0
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => (ready = resolve))
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    if (title === "OpenCode") ready()
    setTitle(title)
  }

  const host: HostClipboardService = {
    maxWriteBytes: 8 * 1024 * 1024,
    async read() {
      reads++
      return read()
    },
    async writeText() {
      return { status: "written" }
    },
    async clear() {
      return { status: "cleared" }
    },
    async dispose() {},
  }
  activeSetup = setup
  activeHost = host
  activePromptRef = undefined

  const events = createEventStream()
  const calls = createFetch(undefined, events)
  let preloaded!: () => void
  const preload = new Promise<void>((resolve) => (preloaded = resolve))
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const response = await calls.fetch(request)
      const url = new URL(request.url)
      if (url.pathname === "/api/session" && url.searchParams.has("project")) preloaded()
      return response
    },
  })
  let task: Promise<unknown> | undefined
  try {
    task = Effect.runPromise(
      run({
        app: { name: "test", version: "test", channel: "test" },
        server: { endpoint: { url: server.url.toString() } },
        config: {
          get: async () => ({ prompt: { paste: "full" as const, image_preview: imagePreview } }),
          update: async () => ({}),
        },
        packages: { resolve: async () => undefined },
        args: {},
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    )
    await mounted
    await setup.waitFor(() => activePromptRef?.focused === true)
    await preload
    await Bun.sleep(0)
  } catch (error) {
    setup.renderer.destroy()
    await task?.catch(() => undefined)
    await server.stop()
    activeSetup = undefined
    activeHost = undefined
    activePromptRef = undefined
    throw error
  }

  return {
    setup,
    get input() {
      const input = setup.renderer.currentFocusedEditor
      if (!(input instanceof TextareaRenderable)) throw new Error("Prompt textarea is not focused")
      return input
    },
    get reads() {
      return reads
    },
    get prompt() {
      if (!activePromptRef) throw new Error("Prompt ref is not mounted")
      return activePromptRef
    },
    async dispose() {
      activePromptRef?.reset()
      setup.renderer.destroy()
      await task
      await server.stop()
      activeSetup = undefined
      activeHost = undefined
      activePromptRef = undefined
    },
  }
}

test("inserts nonempty whitespace-only terminal paste without reading the host clipboard", async () => {
  const prompt = await mountPrompt(async () => ({ status: "empty" }))
  try {
    await prompt.setup.mockInput.pasteBracketedText(" \t\n")
    await prompt.setup.waitFor(() => prompt.input.plainText === " \t\n")

    expect(prompt.input.plainText).toBe(" \t\n")
    expect(prompt.reads).toBe(0)
  } finally {
    await prompt.dispose()
  }
})

test("uses one host clipboard read for a zero-byte terminal paste", async () => {
  const prompt = await mountPrompt(async () => ({ status: "empty" }))
  try {
    prompt.setup.renderer.keyInput.processPaste(new Uint8Array())
    await prompt.setup.waitFor(() => prompt.reads === 1)

    expect(prompt.input.plainText).toBe("")
    expect(prompt.reads).toBe(1)
  } finally {
    await prompt.dispose()
  }
})

test("normalizes host clipboard text once before inserting it", async () => {
  const bytes = new TextEncoder().encode("first\r\nsecond\rthird")
  const prompt = await mountPrompt(async () => ({ status: "read", representation: { mimeType: "text/plain", bytes } }))
  try {
    prompt.setup.renderer.keyInput.processPaste(new Uint8Array())
    await prompt.setup.waitFor(() => prompt.input.plainText === "first\nsecond\nthird")

    expect(prompt.input.plainText).toBe("first\nsecond\nthird")
    expect(prompt.reads).toBe(1)
  } finally {
    await prompt.dispose()
  }
})

test("creates one image mention from PNG clipboard bytes", async () => {
  const prompt = await mountPrompt(async () => ({
    status: "read",
    representation: { mimeType: "image/png", bytes: PNG_1X1 },
  }))
  try {
    prompt.setup.renderer.keyInput.processPaste(new Uint8Array())
    await prompt.setup.waitFor(() => prompt.input.plainText === "[Image 1] ")

    expect(prompt.input.plainText).toBe("[Image 1] ")
    expect(prompt.input.extmarks.getVirtual()).toHaveLength(1)
    expect(prompt.prompt.current.files).toEqual([
      {
        uri: `data:image/png;base64,${PNG_1X1_BASE64}`,
        name: "clipboard",
        mention: { start: 0, end: 9, text: "[Image 1]" },
      },
    ])
    expect(prompt.setup.renderer.root.findDescendantById("prompt-image-preview-0")).toBeUndefined()
    expect(prompt.reads).toBe(1)
  } finally {
    await prompt.dispose()
  }
})

test("renders at most three left-aligned square image crops", async () => {
  const prompt = await mountPrompt(
    async () => ({
      status: "read",
      representation: { mimeType: "image/png", bytes: PNG_1X1 },
    }),
    true,
  )
  try {
    for (let index = 0; index < 4; index++) {
      prompt.setup.renderer.keyInput.processPaste(new Uint8Array())
      await prompt.setup.waitFor(() => prompt.reads === index + 1)
    }

    const first = prompt.setup.renderer.root.findDescendantById("prompt-image-preview-0")
    if (!(first instanceof ImageRenderable)) throw new Error("Image preview did not render")
    await first.loadPromise
    const previews = prompt.setup.renderer.root.findDescendantById("prompt-image-previews")
    if (!previews) throw new Error("Image preview row did not render")
    expect(first.fit).toBe("cover")
    expect(first.x).toBe(previews.x)
    expect(first.width).toBe(first.height * 2)
    expect(prompt.setup.renderer.root.findDescendantById("prompt-image-preview-1")).toBeInstanceOf(ImageRenderable)
    expect(prompt.setup.renderer.root.findDescendantById("prompt-image-preview-2")).toBeInstanceOf(ImageRenderable)
    expect(prompt.setup.renderer.root.findDescendantById("prompt-image-preview-3")).toBeUndefined()
    await prompt.setup.waitForFrame((frame) => frame.includes("+1 more"))
  } finally {
    await prompt.dispose()
  }
})

test("opens a clicked thumbnail in a keyboard-navigable large preview", async () => {
  const prompt = await mountPrompt(
    async () => ({
      status: "read",
      representation: { mimeType: "image/png", bytes: PNG_1X1 },
    }),
    true,
  )
  try {
    for (let index = 0; index < 2; index++) {
      prompt.setup.renderer.keyInput.processPaste(new Uint8Array())
      await prompt.setup.waitFor(() => prompt.reads === index + 1)
    }

    const thumbnail = prompt.setup.renderer.root.findDescendantById("prompt-image-preview-1")
    if (!(thumbnail instanceof ImageRenderable)) throw new Error("Second image thumbnail did not render")
    const card = prompt.setup.renderer.root.findDescendantById("prompt-image-preview-card-1")
    if (!card) throw new Error("Second image thumbnail card did not render")
    await prompt.setup.mockMouse.click(15, 1, MouseButtons.LEFT)

    await prompt.setup.waitForFrame((frame) => frame.includes("Image 2 of 2"))
    const large = prompt.setup.renderer.root.findDescendantById("prompt-image-viewer-image")
    expect(large).toBeInstanceOf(ImageRenderable)
    if (!(large instanceof ImageRenderable)) throw new Error("Large image preview did not render")
    expect(large.fit).toBe("fit")
    expect(large.width).toBeGreaterThan(card.width)

    prompt.setup.mockInput.pressArrow("left")
    await prompt.setup.waitForFrame((frame) => frame.includes("Image 1 of 2"))
    prompt.setup.mockInput.pressCtrlC()
    await prompt.setup.waitForFrame((frame) => !frame.includes("Image 1 of 2"))
    expect(large.isDestroyed).toBe(true)
    await prompt.setup.waitFor(() => prompt.setup.renderer.currentFocusedEditor === prompt.input)
  } finally {
    await prompt.dispose()
  }
})

test("opens image attachments from the command palette", async () => {
  const prompt = await mountPrompt(
    async () => ({
      status: "read",
      representation: { mimeType: "image/png", bytes: PNG_1X1 },
    }),
    true,
  )
  try {
    prompt.setup.renderer.keyInput.processPaste(new Uint8Array())
    await prompt.setup.waitFor(() => prompt.reads === 1)

    prompt.setup.mockInput.pressKey("p", { ctrl: true })
    await prompt.setup.waitForFrame((frame) => frame.includes("Commands"))
    for (const key of "view image attachments") prompt.setup.mockInput.pressKey(key)
    await prompt.setup.waitForFrame((frame) => frame.includes("View image attachments"))
    prompt.setup.mockInput.pressEnter()
    await prompt.setup.waitForFrame((frame) => frame.includes("Image 1 of 1"))
  } finally {
    await prompt.dispose()
  }
})

test("attaches multiple images from one terminal drop", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-drop-"))
  const first = path.join(directory, "one image.png")
  const second = path.join(directory, "two image.png")
  await Promise.all([writeFile(first, PNG_1X1), writeFile(second, PNG_1X1)])
  const prompt = await mountPrompt(async () => ({ status: "empty" }), true)
  try {
    await prompt.setup.mockInput.pasteBracketedText(`'${first}' '${second}'`)
    await prompt.setup.waitFor(() => prompt.prompt.current.files?.length === 2)

    expect(prompt.input.plainText).toBe("[Image 1] [Image 2] ")
    expect(prompt.prompt.current.files?.map((file) => file.name)).toEqual(["one image.png", "two image.png"])
    expect(prompt.setup.renderer.root.findDescendantById("prompt-image-preview-0")).toBeInstanceOf(ImageRenderable)
    expect(prompt.setup.renderer.root.findDescendantById("prompt-image-preview-1")).toBeInstanceOf(ImageRenderable)
  } finally {
    await prompt.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test("reduces the preview count to fit a narrow terminal", async () => {
  const prompt = await mountPrompt(
    async () => ({
      status: "read",
      representation: { mimeType: "image/png", bytes: PNG_1X1 },
    }),
    true,
    32,
  )
  try {
    for (let index = 0; index < 4; index++) {
      prompt.setup.renderer.keyInput.processPaste(new Uint8Array())
      await prompt.setup.waitFor(() => prompt.reads === index + 1)
    }

    expect(prompt.setup.renderer.root.findDescendantById("prompt-image-preview-0")).toBeInstanceOf(ImageRenderable)
    expect(prompt.setup.renderer.root.findDescendantById("prompt-image-preview-1")).toBeUndefined()
    await prompt.setup.waitForFrame((frame) => frame.includes("+3 more"))
    const previews = prompt.setup.renderer.root.findDescendantById("prompt-image-previews")
    const overflow = prompt.setup.renderer.root.findDescendantById("prompt-image-overflow")
    if (!previews || !overflow) throw new Error("Narrow preview layout did not render")
    expect(overflow.x + overflow.width).toBeLessThanOrEqual(previews.x + previews.width)
    for (const preview of previews.getChildren()) {
      expect(preview.x + preview.width).toBeLessThanOrEqual(previews.x + previews.width)
    }
  } finally {
    await prompt.dispose()
  }
})

test("removes an image preview when its mention is deleted", async () => {
  const prompt = await mountPrompt(
    async () => ({
      status: "read",
      representation: { mimeType: "image/png", bytes: PNG_1X1 },
    }),
    true,
  )
  try {
    prompt.setup.renderer.keyInput.processPaste(new Uint8Array())
    await prompt.setup.waitFor(
      () => prompt.setup.renderer.root.findDescendantById("prompt-image-preview-0") instanceof ImageRenderable,
    )
    const preview = prompt.setup.renderer.root.findDescendantById("prompt-image-preview-0")
    if (!(preview instanceof ImageRenderable)) throw new Error("Image preview did not render")
    await preview.loadPromise
    const image = preview.image
    expect(image).not.toBeNull()

    prompt.input.cursorOffset = prompt.input.plainText.length
    prompt.setup.mockInput.pressBackspace()
    prompt.setup.mockInput.pressBackspace()
    await prompt.setup.waitFor(() => prompt.prompt.current.files?.length === 0)

    expect(prompt.input.plainText).toBe("")
    expect(prompt.setup.renderer.root.findDescendantById("prompt-image-preview-0")).toBeUndefined()
    expect(() => image!.info()).toThrow("NativeImage is disposed")
  } finally {
    await prompt.dispose()
  }
})

test("keeps an attachment when its opt-in preview cannot be decoded", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71])
  const prompt = await mountPrompt(
    async () => ({ status: "read", representation: { mimeType: "image/png", bytes } }),
    true,
  )
  try {
    prompt.setup.renderer.keyInput.processPaste(new Uint8Array())
    await prompt.setup.waitForFrame((frame) => frame.includes("No preview"))

    expect(prompt.input.plainText).toBe("[Image 1] ")
    expect(prompt.prompt.current.files).toEqual([
      {
        uri: "data:image/png;base64,iVBORw==",
        name: "clipboard",
        mention: { start: 0, end: 9, text: "[Image 1]" },
      },
    ])
  } finally {
    await prompt.dispose()
  }
})

test("ignores malformed attachment URIs restored into the prompt", async () => {
  const prompt = await mountPrompt(
    async () => ({
      status: "read",
      representation: { mimeType: "image/png", bytes: PNG_1X1 },
    }),
    true,
  )
  try {
    const restored = parsePromptInfo({
      text: "[Image 1] ",
      files: [{ uri: 42 }],
      agents: [],
      pasted: [],
    })
    if (!restored) throw new Error("Malformed prompt fixture was not restored")
    prompt.prompt.set(restored)
    await prompt.setup.renderOnce()

    expect(prompt.prompt.current.text).toBe("[Image 1] ")
    expect(prompt.setup.renderer.root.findDescendantById("prompt-image-preview-0")).toBeUndefined()

    prompt.setup.renderer.keyInput.processPaste(new Uint8Array())
    await prompt.setup.waitFor(() => prompt.reads === 1 && prompt.prompt.current.files?.length === 1)
    expect(prompt.prompt.current.files?.[0]?.uri).toBe(`data:image/png;base64,${PNG_1X1_BASE64}`)
  } finally {
    await prompt.dispose()
  }
})

test("shows clipboard read failures without changing prompt state", async () => {
  const prompt = await mountPrompt(async () => ({ status: "failed", error: new Error("clipboard read failed") }))
  try {
    prompt.setup.renderer.keyInput.processPaste(new Uint8Array())
    await prompt.setup.waitForFrame((frame) => frame.includes("clipboard read failed"))

    expect(prompt.input.plainText).toBe("")
    expect(prompt.input.extmarks.getAll()).toHaveLength(0)
    expect(prompt.reads).toBe(1)
  } finally {
    await prompt.dispose()
  }
})
