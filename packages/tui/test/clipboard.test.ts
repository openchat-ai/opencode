import { expect, test } from "bun:test"
import {
  createClipboard,
  type ClipboardReadOptions,
  type ClipboardReadResult,
  type ClipboardService as CoreClipboardService,
  type ClipboardWriteOptions,
  type ClipboardWriteResult,
  type HostClipboardService,
} from "@opentui/core"
import {
  ClipboardWriteError,
  classifyClipboardWriteResult,
  createClipboardAdapter,
  formatClipboardWriteNotification,
} from "../src/clipboard"

type OpenTuiFixture = {
  read?: ClipboardReadResult
  remote?: boolean
  onCoreRead?: (options: ClipboardReadOptions) => void
  onCoreWrite?: (text: string, options: ClipboardWriteOptions) => void
  onHostWrite?: () => void
  onTerminalWrite?: () => void
}

function openTuiClipboard(options: OpenTuiFixture = {}) {
  const host: HostClipboardService = {
    maxWriteBytes: 8 * 1024 * 1024,
    async read() {
      return options.read ?? { status: "empty" }
    },
    async writeText() {
      options.onHostWrite?.()
      return { status: "written" }
    },
    async clear() {
      return { status: "cleared" }
    },
    async dispose() {},
  }
  const clipboard = createClipboard({
    host,
    terminal: {
      remote: options.remote ?? false,
      writeText() {
        options.onTerminalWrite?.()
        return { status: "attempted", capability: "supported" }
      },
      clear() {
        return { status: "attempted", capability: "supported" }
      },
    },
  })
  return {
    read(input) {
      options.onCoreRead?.(input)
      return clipboard.read(input)
    },
    writeText(text, input) {
      options.onCoreWrite?.(text, input)
      return clipboard.writeText(text, input)
    },
    clear: clipboard.clear,
    dispose: clipboard.dispose,
  } satisfies CoreClipboardService
}

function writeResult(
  host: ClipboardWriteResult["host"]["status"],
  terminal: ClipboardWriteResult["terminal"]["status"],
  error = new Error("host failed"),
): ClipboardWriteResult {
  return {
    host: host === "failed" ? { status: host, error } : { status: host },
    terminal: { status: terminal, capability: "supported" },
  }
}

function writeError(result: ClipboardWriteResult) {
  try {
    classifyClipboardWriteResult(result)
  } catch (error) {
    if (error instanceof ClipboardWriteError) return error
    throw error
  }
  throw new Error("Expected clipboard classification to fail")
}

test("requests the standard clipboard with image-first preferences and adapts PNG bytes", async () => {
  const requests: ClipboardReadOptions[] = []
  const clipboard = createClipboardAdapter(
    openTuiClipboard({
      read: { status: "read", representation: { mimeType: "image/png", bytes: new Uint8Array([0, 1, 2, 255]) } },
      onCoreRead: (input) => requests.push(input),
    }),
  )

  expect(await clipboard.read()).toEqual({ data: "AAEC/w==", mime: "image/png" })
  expect(requests).toEqual([{ preferredTypes: ["image/png", "text/plain"], selection: "clipboard" }])
})

test("decodes text through OpenTUI without normalizing its contents", async () => {
  const text = "line 1\r\n\t\u001b[31m世界"
  const bytes = new TextEncoder().encode(text)
  const clipboard = createClipboardAdapter(
    openTuiClipboard({ read: { status: "read", representation: { mimeType: "text/plain", bytes } } }),
  )

  expect(await clipboard.read()).toEqual({ data: text, mime: "text/plain" })
})

test("maps empty host results and zero-byte text to no content", async () => {
  await Promise.all(
    (["empty", "unsupported", "cancelled"] as const).map(async (status) => {
      expect(await createClipboardAdapter(openTuiClipboard({ read: { status } })).read()).toBeUndefined()
    }),
  )
  expect(
    await createClipboardAdapter(
      openTuiClipboard({
        read: { status: "read", representation: { mimeType: "text/plain", bytes: new Uint8Array() } },
      }),
    ).read(),
  ).toBeUndefined()
})

test("preserves backend read failures and synthesizes operational errors", async () => {
  const failure = new Error("read failed")
  const failed = createClipboardAdapter(openTuiClipboard({ read: { status: "failed", error: failure } }))
  expect(await failed.read().then(undefined, (error) => error)).toBe(failure)

  const timedOut = createClipboardAdapter(openTuiClipboard({ read: { status: "timed-out" } }))
  await expect(timedOut.read()).rejects.toThrow("Clipboard read timed out after 1000ms")

  const limited = createClipboardAdapter(openTuiClipboard({ read: { status: "limit-exceeded" } }))
  const limitError = await limited.read().then(undefined, (error) => error)
  expect(limitError).toBeInstanceOf(RangeError)
  if (!(limitError instanceof RangeError)) throw limitError
  expect(limitError.message).toBe("Clipboard read exceeded the 8388608-byte limit")

  const unexpected = createClipboardAdapter(
    openTuiClipboard({
      read: { status: "read", representation: { mimeType: "text/html", bytes: new Uint8Array([1]) } },
    }),
  )
  await expect(unexpected.read()).rejects.toThrow("Unexpected clipboard MIME type: text/html")
})

test("uses OpenTUI all-available composition for local writes", async () => {
  let hostWrites = 0
  let terminalWrites = 0
  const writes: [string, ClipboardWriteOptions][] = []
  const clipboard = createClipboardAdapter(
    openTuiClipboard({
      onHostWrite: () => hostWrites++,
      onTerminalWrite: () => terminalWrites++,
      onCoreWrite: (text, options) => writes.push([text, options]),
    }),
  )

  expect(await clipboard.write("hello")).toMatchObject({ delivery: "confirmed", partial: false })
  expect(hostWrites).toBe(1)
  expect(terminalWrites).toBe(1)
  expect(writes).toEqual([["hello", { destination: "all-available", selection: "clipboard" }]])
})

test("does not authorize a process-host write for remote renderers", async () => {
  let hostWrites = 0
  let terminalWrites = 0
  const clipboard = createClipboardAdapter(
    openTuiClipboard({
      remote: true,
      onHostWrite: () => hostWrites++,
      onTerminalWrite: () => terminalWrites++,
    }),
  )

  expect(await clipboard.write("hello")).toMatchObject({
    delivery: "attempted",
    partial: false,
    result: { host: { status: "not-attempted" }, terminal: { status: "attempted" } },
  })
  expect(hostWrites).toBe(0)
  expect(terminalWrites).toBe(1)
})

test("classifies confirmed, attempted, and partial delivery", () => {
  const scenarios = [
    { result: writeResult("written", "attempted"), delivery: "confirmed", partial: false },
    { result: writeResult("written", "not-attempted"), delivery: "confirmed", partial: false },
    { result: writeResult("unsupported", "attempted"), delivery: "attempted", partial: false },
    { result: writeResult("failed", "attempted"), delivery: "attempted", partial: true },
    { result: writeResult("timed-out", "attempted"), delivery: "attempted", partial: true },
    { result: writeResult("cancelled", "attempted"), delivery: "attempted", partial: true },
    { result: writeResult("written", "local-failure"), delivery: "confirmed", partial: true },
  ] as const

  scenarios.forEach((scenario) => {
    expect(classifyClipboardWriteResult(scenario.result)).toMatchObject({
      delivery: scenario.delivery,
      partial: scenario.partial,
      result: scenario.result,
    })
  })
})

test("rejects every unavailable total-failure combination", () => {
  const hosts = ["failed", "unsupported", "cancelled", "timed-out", "not-attempted"] as const
  const terminals = ["local-failure", "not-attempted"] as const

  hosts.flatMap((host) => terminals.map((terminal) => [host, terminal] as const)).forEach(([host, terminal]) => {
    const failure = new Error("native write failed")
    const result = writeResult(host, terminal, failure)
    const error = writeError(result)
    expect(error.message).toBe(`Clipboard write failed (host: ${host}, terminal: ${terminal})`)
    expect(error.result).toBe(result)
    expect(error.cause).toBe(host === "failed" ? failure : undefined)
  })
})

test("formats truthful notifications for every delivered outcome", () => {
  const confirmed = { message: "Copied value", variant: "success" as const }
  expect(
    formatClipboardWriteNotification(
      { delivery: "confirmed", partial: false, result: writeResult("written", "attempted") },
      confirmed,
    ),
  ).toBe(confirmed)
  expect(
    formatClipboardWriteNotification(
      { delivery: "attempted", partial: false, result: writeResult("unsupported", "attempted") },
      confirmed,
    ),
  ).toEqual({ message: "Sent to terminal clipboard (acceptance unconfirmed)", variant: "info" })
  expect(
    formatClipboardWriteNotification(
      { delivery: "confirmed", partial: true, result: writeResult("written", "local-failure") },
      confirmed,
    ),
  ).toEqual({ message: "Copied to host clipboard; terminal clipboard dispatch failed", variant: "warning" })
  expect(
    formatClipboardWriteNotification(
      { delivery: "attempted", partial: true, result: writeResult("failed", "attempted") },
      confirmed,
    ),
  ).toEqual({ message: "Sent to terminal clipboard; host clipboard write failed", variant: "warning" })
})

test("retains OpenTUI text validation and the configured 8 MiB UTF-8 bound", async () => {
  let hostWrites = 0
  let terminalWrites = 0
  const clipboard = createClipboardAdapter(
    openTuiClipboard({
      onHostWrite: () => hostWrites++,
      onTerminalWrite: () => terminalWrites++,
    }),
  )

  const boundary = "é".repeat(4 * 1024 * 1024)
  await expect(clipboard.write(boundary)).resolves.toMatchObject({ delivery: "confirmed" })
  await expect(clipboard.write("")).rejects.toThrow("writeText requires non-empty text")
  await expect(clipboard.write("before\0after")).rejects.toThrow("writeText does not support NUL characters")
  await expect(clipboard.write(boundary + "a")).rejects.toThrow(
    "writeText exceeds the configured 8388608 byte limit",
  )
  expect(hostWrites).toBe(1)
  expect(terminalWrites).toBe(1)
})
