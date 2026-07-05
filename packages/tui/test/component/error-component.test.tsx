import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ErrorComponent } from "../../src/component/error-component"
import { ClipboardProvider, type ClipboardService, type ClipboardWriteOutcome } from "../../src/context/clipboard"
import { ExitProvider } from "../../src/context/exit"

const outcomes = [
  {
    label: "Copied",
    absent: "Copied (terminal failed)",
    outcome: {
      delivery: "confirmed",
      partial: false,
      result: {
        host: { status: "written" },
        terminal: { status: "attempted", capability: "supported" },
      },
    },
  },
  {
    label: "Copied (terminal failed)",
    absent: undefined,
    outcome: {
      delivery: "confirmed",
      partial: true,
      result: {
        host: { status: "written" },
        terminal: { status: "local-failure", capability: "supported" },
      },
    },
  },
  {
    label: "Sent",
    absent: "Sent (host failed)",
    outcome: {
      delivery: "attempted",
      partial: false,
      result: {
        host: { status: "unsupported" },
        terminal: { status: "attempted", capability: "supported" },
      },
    },
  },
  {
    label: "Sent (host failed)",
    absent: undefined,
    outcome: {
      delivery: "attempted",
      partial: true,
      result: {
        host: { status: "failed", error: new Error("host failed") },
        terminal: { status: "attempted", capability: "supported" },
      },
    },
  },
] as const satisfies readonly { label: string; absent: string | undefined; outcome: ClipboardWriteOutcome }[]

function clipboard(write: () => Promise<ClipboardWriteOutcome>): ClipboardService {
  return {
    async read() {
      return undefined
    },
    write,
  }
}

async function waitForFrame(
  app: { renderOnce(): Promise<void>; captureCharFrame(): string },
  match: (frame: string) => boolean,
) {
  for (let attempts = 0; attempts < 20; attempts++) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    if (match(frame)) return frame
    await Bun.sleep(1)
  }
  throw new Error("Timed out waiting for clipboard state")
}

test("crash report distinguishes every delivered clipboard state", async () => {
  for (const scenario of outcomes) {
    const app = await testRender(
      () => (
        <ExitProvider exit={() => {}}>
          <ClipboardProvider value={clipboard(async () => scenario.outcome)}>
            <ErrorComponent error={new Error("boom")} reset={() => {}} />
          </ClipboardProvider>
        </ExitProvider>
      ),
      { width: 100, height: 24 },
    )
    try {
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Copy report")
      app.mockInput.pressKey("c")
      const frame = await waitForFrame(app, (frame) => frame.includes(scenario.label))
      if (scenario.absent) expect(frame).not.toContain(scenario.absent)
    } finally {
      app.renderer.destroy()
    }
  }
})

test("crash report catches clipboard rejection", async () => {
  const app = await testRender(
    () => (
      <ExitProvider exit={() => {}}>
        <ClipboardProvider
          value={clipboard(async () => {
            throw new Error("copy failed")
          })}
        >
          <ErrorComponent error={new Error("boom")} reset={() => {}} />
        </ClipboardProvider>
      </ExitProvider>
    ),
    { width: 100, height: 24 },
  )
  try {
    await app.renderOnce()
    app.mockInput.pressKey("c")
    expect(await waitForFrame(app, (frame) => frame.includes("Copy failed"))).toContain("Copy failed")
  } finally {
    app.renderer.destroy()
  }
})
