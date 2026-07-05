import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ErrorBoundary, type JSX } from "solid-js"
import { ClipboardProvider, type ClipboardService, useClipboard } from "../../src/context/clipboard"

const clipboard: ClipboardService = {
  async read() {
    return { data: "text", mime: "text/plain" }
  },
  async write() {
    return {
      delivery: "confirmed",
      partial: false,
      result: {
        host: { status: "written" },
        terminal: { status: "not-attempted", capability: "unknown" },
      },
    }
  },
}

test("requires explicit provider injection", () => {
  expect(() => useClipboard()).toThrow("useClipboard must be used within a ClipboardProvider")
})

test("keeps clipboard access available to an error boundary fallback", async () => {
  let value: ClipboardService | undefined
  function Crash(): JSX.Element {
    throw new Error("crash")
  }
  function Fallback() {
    value = useClipboard()
    return <text>fallback</text>
  }

  const app = await testRender(() => (
    <ClipboardProvider value={clipboard}>
      <ErrorBoundary fallback={() => <Fallback />}>
        <Crash />
      </ErrorBoundary>
    </ClipboardProvider>
  ))
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("fallback")
    expect(value).toBe(clipboard)
  } finally {
    app.renderer.destroy()
  }
})
