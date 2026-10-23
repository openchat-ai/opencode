import { app, type BrowserWindow } from "electron"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { writeHeapSnapshot } from "node:v8"
import type { MainSetup } from "../sdk/main"
import { HeapSnapshots } from "./contract"
import type definition from "./index"
import { captureServer } from "./server-heap"

/** A desktop process the manifest lists: the file written, or why there is none. */
type Snapshot = { readonly process: "main" | "window"; readonly pid: number; readonly window?: number } & (
  | { readonly file: string }
  | { readonly error: string }
)

/** The last capture; the next one starts after it settles. */
type Queue = { tail: Promise<unknown> }

const setup: MainSetup<typeof definition> = (ctx) => {
  const queue: Queue = { tail: Promise.resolve() }

  const capture = async () => {
    const directory = path.join(
      app.getPath("downloads"),
      `opencode-heap-${new Date().toISOString().replace(/[:.]/g, "")}`,
    )

    // Snapshots hold prompts, file contents and credentials. Recursive, because Downloads can be missing on Linux.
    await mkdir(directory, { recursive: true, mode: 0o700 })
    ctx.log.write("info", "capturing heap snapshots", { directory })

    // The server is another process, so it serializes its heap while the windows do. Windows go one at a time: a
    // snapshot can double a process's memory, and a leaking app may not have room for every window at once. Main goes
    // last: writing its own heap blocks the loop that receives the others.
    const [serverSnapshot, windows] = await Promise.all([
      captureServer(ctx.serverEndpoints.get("sidecar"), directory, ctx.scope.signal),
      (async () => {
        const list: Snapshot[] = []

        for (const window of ctx.windows.list()) list.push(await captureWindow(window, directory))

        return list
      })(),
    ])

    const main = await Promise.resolve()
      .then(() => writeHeapSnapshot(path.join(directory, `main-${process.pid}.heapsnapshot`)))
      .then(
        (file): Snapshot => ({ process: "main", pid: process.pid, file: path.basename(file) }),
        (error: Error): Snapshot => ({ process: "main", pid: process.pid, error: error.message }),
      )

    const snapshots = [serverSnapshot, ...windows, main]

    // Written last, so a script can wait for it.
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify(
        {
          created: new Date().toISOString(),
          app: {
            name: app.getName(),
            version: app.getVersion(),
            packaged: app.isPackaged,
            platform: process.platform,
            arch: process.arch,
            versions: process.versions,
          },
          snapshots,
          // Per-process memory as the OS sees it: a process that grows while its heap does not leaks native memory.
          metrics: app.getAppMetrics(),
          metricsMemoryUnit: "KiB",
          mainMemory: process.memoryUsage(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    const complete = snapshots.every((snapshot) => !("error" in snapshot))
    ctx.log.write(complete ? "info" : "warn", "heap snapshots captured", { directory, complete })

    return { directory, complete }
  }

  ctx.provide(HeapSnapshots, {
    // A window that closes meanwhile does not cancel the capture.
    write: () => {
      const run = queue.tail.then(capture)
      queue.tail = run.catch(() => undefined)

      return run
    },
  })
}

function captureWindow(window: BrowserWindow, directory: string) {
  const contents = window.webContents
  const pid = contents.getOSProcessId()
  const file = `window-${window.id}-${pid}.heapsnapshot`

  return contents.takeHeapSnapshot(path.join(directory, file)).then(
    (): Snapshot => ({ process: "window", pid, window: window.id, file }),
    (error: Error): Snapshot => ({ process: "window", pid, window: window.id, error: error.message }),
  )
}

export default setup
