import { expect, test } from "bun:test"
import type { ClipboardService } from "../../src/context/clipboard"
import { Selection } from "../../src/util/selection"

test("copies semantic selection text, reports attempted partial delivery, and clears immediately", async () => {
  const notifications: { message: string; variant: "info" | "success" | "warning" | "error" }[] = []
  const errors: unknown[] = []
  const writes: string[] = []
  const events: string[] = []
  let notify!: () => void
  const notified = new Promise<void>((resolve) => {
    notify = resolve
  })
  const focus = {
    hasSelection: () => true,
    getClipboardText: (text: string) => text.replace("[Pasted ~2 lines]", "first\nsecond"),
  }
  const renderer = {
    getSelection: () => ({
      getSelectedText: () => "before [Pasted ~2 lines] after",
      selectedRenderables: [focus],
    }),
    clearSelection: () => events.push("clear"),
    currentFocusedRenderable: focus,
  }
  const clipboard: ClipboardService = {
    async read() {
      return undefined
    },
    async write(text) {
      events.push("write")
      writes.push(text)
      return {
        delivery: "attempted",
        partial: true,
        result: {
          host: { status: "failed", error: new Error("host failed") },
          terminal: { status: "attempted", capability: "supported" },
        },
      }
    },
  }

  expect(
    Selection.copy(
      renderer,
      {
        show: (notification) => {
          notifications.push(notification)
          notify()
        },
        error: (error) => errors.push(error),
      },
      clipboard,
    ),
  ).toBe(true)
  expect(writes).toEqual(["before first\nsecond after"])
  expect(events).toEqual(["write", "clear"])
  await notified
  expect(notifications).toEqual([
    { message: "Sent to terminal clipboard; host clipboard write failed", variant: "warning" },
  ])
  expect(errors).toEqual([])
})

test("reports total selection-copy failure without delaying selection clearing", async () => {
  const failure = new Error("copy failed")
  const errors: unknown[] = []
  const notifications: unknown[] = []
  let clears = 0
  let report!: () => void
  const reported = new Promise<void>((resolve) => {
    report = resolve
  })
  const clipboard: ClipboardService = {
    async read() {
      return undefined
    },
    async write() {
      throw failure
    },
  }

  expect(
    Selection.copy(
      {
        getSelection: () => ({ getSelectedText: () => "text", selectedRenderables: [] }),
        clearSelection: () => void clears++,
      },
      {
        show: (notification) => notifications.push(notification),
        error: (error) => {
          errors.push(error)
          report()
        },
      },
      clipboard,
    ),
  ).toBe(true)
  expect(clears).toBe(1)
  await reported
  expect(notifications).toEqual([])
  expect(errors).toEqual([failure])
})
