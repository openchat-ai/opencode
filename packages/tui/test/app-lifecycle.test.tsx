import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type {
  ClipboardOptions,
  ClipboardService,
  HostClipboardOptions,
  HostClipboardService,
  RendererClipboardBoundary,
} from "@opentui/core"
import { Effect, FileSystem } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"

const openTui = { ...(await import("@opentui/core")) }

function restoreOpenTui() {
  mock.restore()
  mock.module("@opentui/core", () => openTui)
}

async function mockOpenTuiClipboard(
  renderer: RendererClipboardBoundary,
  options: {
    dispose?: () => Promise<void>
    constructionError?: Error
  } = {},
) {
  const calls = {
    host: [] as (HostClipboardOptions | undefined)[],
    adapter: [] as RendererClipboardBoundary[],
    service: [] as ClipboardOptions[],
    dispose: 0,
    hostDispose: 0,
    hostWrite: 0,
  }
  const host: HostClipboardService = {
    maxWriteBytes: 8 * 1024 * 1024,
    async read() {
      return { status: "empty" }
    },
    async writeText() {
      calls.hostWrite++
      return { status: "written" }
    },
    async clear() {
      return { status: "cleared" }
    },
    async dispose() {
      calls.hostDispose++
      await options.dispose?.()
    },
  }

  mock.module("@opentui/core", () => ({
    ...openTui,
    createCliRenderer: async () => renderer,
    createHostClipboard: (input?: HostClipboardOptions) => {
      if (options.constructionError) throw options.constructionError
      calls.host.push(input)
      return host
    },
    createRendererClipboardAdapter: (input: RendererClipboardBoundary) => {
      calls.adapter.push(input)
      return openTui.createRendererClipboardAdapter(input)
    },
    createClipboard: (input: ClipboardOptions) => {
      calls.service.push(input)
      const service = openTui.createClipboard(input)
      return {
        read: service.read,
        writeText: service.writeText,
        clear: service.clear,
        async dispose() {
          calls.dispose++
          await service.dispose()
        },
      } satisfies ClipboardService
    },
  }))
  return calls
}

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const clipboard = await mockOpenTuiClipboard(setup.renderer)
  const titles: string[] = []
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    if (title === "OpenCode") started()
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventStream()
  const calls = createFetch(undefined, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        app: { name: "test", version: "test", channel: "test" },
        server: { endpoint: { url: server.url.toString() } },
        config: { get: async () => ({}), update: async () => ({}) },
        packages: { resolve: async () => undefined },
        args: {},
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(clipboard.host).toEqual([
      {
        timeoutMs: 1_000,
        maxReadBytes: 8 * 1024 * 1024,
        maxWriteBytes: 8 * 1024 * 1024,
        maxImagePixels: 64 * 1024 * 1024,
        maxConversionBytes: 512 * 1024 * 1024,
        maxConcurrentOperations: 16,
        maxProviderTransfers: 16,
        maxWorkUnitsPerDrain: 64,
      },
    ])
    expect(clipboard.adapter).toEqual([setup.renderer])
    expect(clipboard.service).toHaveLength(1)
    expect(clipboard.dispose).toBe(1)
    expect(clipboard.hostDispose).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
    restoreOpenTui()
  }
})

test("session lifecycle updates the terminal title and prints the epilogue after cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  let releaseDispose!: () => void
  let startDispose!: () => void
  const disposeStarted = new Promise<void>((resolve) => {
    startDispose = resolve
  })
  const disposeReady = new Promise<void>((resolve) => {
    releaseDispose = resolve
  })
  const clipboard = await mockOpenTuiClipboard(setup.renderer, {
    dispose: async () => {
      startDispose()
      await disposeReady
    },
  })
  let initialTitle!: () => void
  const initialTitleSet = new Promise<void>((resolve) => {
    initialTitle = resolve
  })
  let renamedTitle!: () => void
  const renamedTitleSet = new Promise<void>((resolve) => {
    renamedTitle = resolve
  })
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    if (title === "OC | Demo session") initialTitle()
    if (title === "OC | Renamed session") renamedTitle()
    setTitle(title)
  }
  const events = createEventStream()
  let promptRequests = 0
  const calls = createFetch((url) => {
    const session = {
      id: "dummy",
      title: "Demo session",
      projectID: "project",
      location: { directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
    }
    if (url.pathname === "/api/session")
      return json({
        data: [session],
        cursor: {},
      })
    if (url.pathname === "/api/session/dummy") return json({ data: session })
    if (url.pathname === "/api/session/dummy/message") return json({ data: [], cursor: {} })
    if (url.pathname === "/api/session/dummy/pending") return json({ data: [] })
    if (url.pathname === "/api/session/dummy/permission") return json({ data: [] })
    if (url.pathname === "/api/session/dummy/prompt") {
      promptRequests++
      return json({ data: {} })
    }
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        app: { name: "test", version: "test", channel: "test" },
        server: { endpoint: { url: server.url.toString() } },
        config: { get: async () => ({}), update: async () => ({}) },
        packages: { resolve: async () => undefined },
        args: { sessionID: "dummy" },
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    )

    await initialTitleSet
    events.emit({
      id: "evt_renamed",
      created: 1,
      type: "session.renamed",
      durable: { aggregateID: "dummy", seq: 1, version: 1 },
      data: { sessionID: "dummy", title: "Renamed session" },
    })
    await renamedTitleSet
    let settled = false
    void task.then(
      () => (settled = true),
      () => (settled = true),
    )
    events.emit({
      id: "evt_exit",
      created: 2,
      type: "tui.command.execute",
      data: { command: "app.exit" },
    })
    await disposeStarted
    expect(settled).toBe(false)
    expect(stdout).toBe("")
    releaseDispose()
    await task

    expect(stdout).toContain("opencode2 -s dummy")
    expect(promptRequests).toBe(0)
    expect(clipboard.dispose).toBe(1)
    expect(clipboard.hostDispose).toBe(1)
  } finally {
    releaseDispose()
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
    restoreOpenTui()
  }
})

test("direct renderer destruction disposes the clipboard once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const clipboard = await mockOpenTuiClipboard(setup.renderer)
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    if (title === "OpenCode") started()
    setTitle(title)
  }
  const events = createEventStream()
  const calls = createFetch(undefined, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        app: { name: "test", version: "test", channel: "test" },
        server: { endpoint: { url: server.url.toString() } },
        config: { get: async () => ({}), update: async () => ({}) },
        packages: { resolve: async () => undefined },
        args: {},
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    )
    await ready
    const staleCopy = setup.renderer.console.onCopySelection
    setup.renderer.destroy()
    await task

    expect(clipboard.dispose).toBe(1)
    expect(clipboard.hostDispose).toBe(1)
    await staleCopy?.("stale")
    expect(clipboard.hostWrite).toBe(0)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
    restoreOpenTui()
  }
})

test("clipboard construction failure releases the renderer", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const failure = new Error("clipboard construction failed")
  await mockOpenTuiClipboard(setup.renderer, { constructionError: failure })
  const events = createEventStream()
  const calls = createFetch(undefined, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })

  try {
    const { run } = await import("../src/app")
    await expect(
      Effect.runPromise(
        run({
          app: { name: "test", version: "test", channel: "test" },
          server: { endpoint: { url: server.url.toString() } },
          config: { get: async () => ({}), update: async () => ({}) },
          packages: { resolve: async () => undefined },
          args: {},
          log: () => {},
        }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
      ),
    ).rejects.toThrow("clipboard construction failed")
    expect(setup.renderer.isDestroyed).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
    restoreOpenTui()
  }
})

test("clipboard disposal failure is logged without failing remaining cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const clipboard = await mockOpenTuiClipboard(setup.renderer, {
    dispose: async () => {
      throw new Error("clipboard disposal failed")
    },
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    if (title === "OpenCode") started()
    setTitle(title)
  }
  const events = createEventStream()
  const calls = createFetch(undefined, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const logs: unknown[] = []

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        app: { name: "test", version: "test", channel: "test" },
        server: { endpoint: { url: server.url.toString() } },
        config: { get: async () => ({}), update: async () => ({}) },
        packages: { resolve: async () => undefined },
        args: {},
        log: (_level, message) => void logs.push(message),
      }).pipe(
        Effect.provide(AppNodeBuilder.build(Global.node)),
        Effect.provide(FileSystem.layerNoop({})),
      ),
    )
    await ready
    setup.renderer.destroy()
    await task

    expect(clipboard.dispose).toBe(1)
    expect(clipboard.hostDispose).toBe(1)
    expect(titles.at(-1)).toBe("")
    expect(
      logs.some((message) =>
        (Array.isArray(message) ? message : [message]).some((value) => value === "Failed to dispose TUI clipboard"),
      ),
    ).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
    restoreOpenTui()
  }
})

test("session startup prompt is submitted exactly once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventStream()
  const cwd = process.cwd()
  const location = { directory: cwd, project: { id: "project", directory: cwd } }
  const session = {
    id: "dummy",
    title: "Demo session",
    projectID: "project",
    location: { directory: cwd },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const bodies: unknown[] = []
  const promptSubmitted = Promise.withResolvers<void>()
  const calls = createFetch(async (url, request) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === "/api/session/dummy") return json({ data: session })
    if (url.pathname === "/api/session/dummy/message") return json({ data: [], cursor: {} })
    if (url.pathname === "/api/session/dummy/pending") return json({ data: [] })
    if (url.pathname === "/api/session/dummy/permission") return json({ data: [] })
    if (url.pathname === "/api/agent")
      return json({
        location,
        data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }],
      })
    if (url.pathname === "/api/model")
      return json({
        location,
        data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }],
      })
    if (url.pathname === "/api/session/dummy/prompt") {
      bodies.push(await request.json())
      promptSubmitted.resolve()
      return json({ data: {} })
    }
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        app: { name: "test", version: "test", channel: "test" },
        server: { endpoint: { url: server.url.toString() } },
        config: { get: async () => ({}), update: async () => ({}) },
        packages: { resolve: async () => undefined },
        args: { sessionID: "dummy", prompt: "RESUME_READY" },
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    )

    await Promise.race([
      promptSubmitted.promise,
      Bun.sleep(2000).then(() => {
        throw new Error("startup prompt was not submitted")
      }),
    ])
    await Bun.sleep(20)
    setup.renderer.destroy()
    await task

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ text: "RESUME_READY" })
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
    mock.restore()
  }
})
