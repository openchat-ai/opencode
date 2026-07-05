import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  decodePasteBytes,
  type ClipboardService as CoreClipboardService,
  type ClipboardWriteResult,
  type RendererClipboardBoundary,
} from "@opentui/core"
import type { ClipboardService, ClipboardWriteOutcome } from "./context/clipboard"

const timeoutMs = 1_000
const maxReadBytes = 8 * 1024 * 1024

export type ClipboardNotification = Readonly<{
  message: string
  variant: "info" | "success" | "warning"
}>

export type ClipboardCopyState =
  | "idle"
  | "confirmed"
  | "confirmed-partial"
  | "attempted"
  | "attempted-partial"
  | "failed"

export type OwnedClipboardService = ClipboardService & Readonly<{ dispose(): Promise<void> }>

export class ClipboardWriteError extends Error {
  readonly result: ClipboardWriteResult

  constructor(result: ClipboardWriteResult) {
    super(
      `Clipboard write failed (host: ${result.host.status}, terminal: ${result.terminal.status})`,
      result.host.status === "failed" ? { cause: result.host.error } : undefined,
    )
    this.name = "ClipboardWriteError"
    this.result = result
  }
}

export function createTuiClipboard(renderer: RendererClipboardBoundary): OwnedClipboardService {
  return createClipboardAdapter(
    createClipboard({
      host: createHostClipboard({
        timeoutMs,
        maxReadBytes,
        maxWriteBytes: 8 * 1024 * 1024,
        maxImagePixels: 64 * 1024 * 1024,
        maxConversionBytes: 512 * 1024 * 1024,
        maxConcurrentOperations: 16,
        maxProviderTransfers: 16,
        maxWorkUnitsPerDrain: 64,
      }),
      terminal: createRendererClipboardAdapter(renderer),
    }),
  )
}

export function createClipboardAdapter(clipboard: CoreClipboardService): OwnedClipboardService {
  return {
    async read() {
      const result = await clipboard.read({
        preferredTypes: ["image/png", "text/plain"],
        selection: "clipboard",
      })
      if (result.status !== "read") {
        if (result.status === "empty" || result.status === "unsupported" || result.status === "cancelled") return
        if (result.status === "failed") throw result.error
        if (result.status === "timed-out") throw new Error(`Clipboard read timed out after ${timeoutMs}ms`)
        if (result.status === "limit-exceeded") {
          throw new RangeError(`Clipboard read exceeded the ${maxReadBytes}-byte limit`)
        }
        throw new Error(`Unexpected clipboard read status: ${result.status}`)
      }

      if (result.representation.mimeType === "image/png") {
        return {
          data: Buffer.from(result.representation.bytes).toString("base64"),
          mime: result.representation.mimeType,
        }
      }
      if (result.representation.mimeType === "text/plain") {
        if (result.representation.bytes.length === 0) return
        return {
          data: decodePasteBytes(result.representation.bytes),
          mime: result.representation.mimeType,
        }
      }
      throw new Error(`Unexpected clipboard MIME type: ${result.representation.mimeType}`)
    },
    async write(text) {
      return classifyClipboardWriteResult(
        await clipboard.writeText(text, {
          destination: "all-available",
          selection: "clipboard",
        }),
      )
    },
    dispose() {
      return clipboard.dispose()
    },
  }
}

export function classifyClipboardWriteResult(result: ClipboardWriteResult): ClipboardWriteOutcome {
  const partial =
    result.host.status === "failed" ||
    result.host.status === "timed-out" ||
    result.host.status === "cancelled" ||
    result.terminal.status === "local-failure"

  if (result.host.status === "written") return { delivery: "confirmed", partial, result }
  if (result.terminal.status === "attempted") return { delivery: "attempted", partial, result }
  throw new ClipboardWriteError(result)
}

export function formatClipboardWriteNotification(
  outcome: ClipboardWriteOutcome,
  confirmed: ClipboardNotification,
): ClipboardNotification {
  if (outcome.delivery === "confirmed" && !outcome.partial) return confirmed
  if (outcome.delivery === "attempted" && !outcome.partial) {
    return { message: "Sent to terminal clipboard (acceptance unconfirmed)", variant: "info" }
  }
  if (outcome.delivery === "confirmed") {
    return { message: "Copied to host clipboard; terminal clipboard dispatch failed", variant: "warning" }
  }
  return { message: "Sent to terminal clipboard; host clipboard write failed", variant: "warning" }
}

export function clipboardCopyState(outcome: ClipboardWriteOutcome): ClipboardCopyState {
  if (!outcome.partial) return outcome.delivery
  return `${outcome.delivery}-partial`
}
