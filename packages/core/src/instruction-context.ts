export * as InstructionContext from "./instruction-context"

import { Array, Effect, Layer, Schema } from "effect"
import { isAbsolute, join, relative, sep } from "path"
import { FSUtil } from "./fs-util"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"
import { makeLocationNode } from "./effect/app-node"
import { Token } from "./util/token"

class File extends Schema.Class<File>("InstructionContext.File")({
  path: AbsolutePath,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = SystemContext.Key.make("core/instructions")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service

    const source = (value: ReadonlyArray<File> | SystemContext.Unavailable) =>
      SystemContext.make({
        key,
        codec: Schema.toCodecJson(Files),
        load: Effect.succeed(value),
        baseline: render,
        update: (_previous, current) =>
          `These instructions replace all previously loaded ambient instructions.\n\n${render(current)}`,
        removed: () => "Previously loaded instructions no longer apply.",
      })

    const observe = Effect.fn("InstructionContext.observe")(function* () {
      const start = yield* fs.resolve(location.directory)
      const stop = yield* fs.resolve(location.project.directory)
      const fromProject = relative(stop, start)
      const insideProject =
        fromProject === "" || (fromProject !== ".." && !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject))
      const discovered = new Set(
        yield* Effect.forEach(
          Flag.OPENCODE_DISABLE_PROJECT_CONFIG || !insideProject
            ? []
            : yield* fs.up({
                targets: ["AGENTS.md"],
                start,
                stop,
              }),
          fs.resolve,
        ),
      )
      const paths = Array.dedupe([yield* fs.resolve(join(global.config, "AGENTS.md")), ...discovered])
      const files = yield* Effect.forEach(
        paths,
        (path) =>
          fs
            .readFileStringSafe(path)
            .pipe(
              Effect.map((content) => {
                if (content === undefined) return undefined
                const partitioned = partitionInstructions(content)
                const historical = renderHistorical(partitioned.historical, MAX_HISTORICAL_TOKENS)
                const body = historical ? `${partitioned.active}\n${historical}` : partitioned.active
                return new File({ path: AbsolutePath.make(path), content: body })
              }),
            ),
        { concurrency: "unbounded" },
      )
      if (files.some((file, index) => file === undefined && discovered.has(paths[index])))
        return SystemContext.unavailable
      return files.filter((file): file is File => file !== undefined)
    })

    yield* registry.register({
      key,
      load: observe().pipe(
        Effect.map((files) =>
          files === SystemContext.unavailable
            ? source(files)
            : files.length === 0
              ? SystemContext.empty
              : source(files),
        ),
        Effect.catch(() => Effect.succeed(source(SystemContext.unavailable))),
        Effect.catchDefect(() => Effect.succeed(source(SystemContext.unavailable))),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "instruction-context",
  layer,
  deps: [FSUtil.node, Global.node, Location.node, SystemContextRegistry.node],
})

// ---------------------------------------------------------------------------
// Rule decay: AGENTS.md sections that carry a trailing (YYYY-MM-DD) date and
// are older than the decay window are de-prioritized. They are still shown,
// but grouped under a "historical lessons" header and token-capped, so stale
// iron rules stop crowding the active instructions without ever being lost.
//
// Undated sections (standing constraints, current checklists) never decay —
// there is no way to judge their freshness. Project-scoped AGENTS.md files
// already decay on project switch (fs.up discovers only the current tree).
// ---------------------------------------------------------------------------

export const DEFAULT_DECAY_DAYS = 90
export const MAX_HISTORICAL_TOKENS = 2_000
export const HISTORICAL_HEADER = "Historical lessons (may be outdated — reference only if relevant)"

export type PartitionedInstructions = {
  readonly active: string
  readonly historical: string
}

const DATE_SUFFIX = /\s\((\d{4})-(\d{2})-(\d{2})\)\s*$/

// Split markdown on `## ` headings. Content before the first heading stays in
// the active preamble.
const splitSections = (content: string): ReadonlyArray<{ readonly heading?: string; readonly body: string }> => {
  const lines = content.split("\n")
  const sections: Array<{ heading?: string; body: string[] }> = []
  let current: { heading?: string; body: string[] } = { body: [] }
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current.body.length > 0 || current.heading !== undefined) sections.push(current)
      current = { heading: line.slice(3), body: [] }
    } else {
      current.body.push(line)
    }
  }
  sections.push(current)
  return sections.map((section) => ({ heading: section.heading, body: section.body.join("\n").trim() }))
}

const parseDate = (heading: string): Date | undefined => {
  const match = DATE_SUFFIX.exec(heading)
  if (!match) return undefined
  const [, year, month, day] = match
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
}

const daysSince = (date: Date, now: Date) => Math.floor((now.getTime() - date.getTime()) / 86_400_000)

export const partitionInstructions = (
  content: string,
  input: { readonly now?: Date; readonly decayDays?: number } = {},
): PartitionedInstructions => {
  const now = input.now ?? new Date()
  const decayDays = input.decayDays ?? DEFAULT_DECAY_DAYS
  const sections = splitSections(content)
  const active: string[] = []
  const historical: string[] = []
  let activePreamble = ""
  let historicalPreamble = ""
  for (const section of sections) {
    if (section.heading === undefined) {
      if (activePreamble === "") activePreamble = section.body
      else if (historicalPreamble === "") historicalPreamble = section.body
      continue
    }
    const date = parseDate(section.heading)
    const text = `## ${section.heading}\n${section.body}`.trim()
    if (date !== undefined && daysSince(date, now) > decayDays) historical.push(text)
    else active.push(text)
  }
  return {
    active: [activePreamble, ...active].filter(Boolean).join("\n\n"),
    historical: [historicalPreamble, ...historical].filter(Boolean).join("\n\n"),
  }
}

// Token-cap the historical section so stale rules cannot crowd the active
// instructions. Returns undefined when there is nothing historical left.
export const renderHistorical = (historical: string, maxTokens: number): string | undefined => {
  if (historical.length === 0) return undefined
  const trimmed = Token.estimate(historical) > maxTokens ? truncateAtToken(historical, maxTokens) : historical
  if (trimmed.length === 0) return undefined
  return `\n\n${HISTORICAL_HEADER}\n${trimmed}`
}

const truncateAtToken = (value: string, maxTokens: number) => {
  const charsPerToken = 4
  const maxChars = maxTokens * charsPerToken
  const lines = value.split("\n")
  let total = 0
  const kept: string[] = []
  for (const line of lines) {
    const next = total + line.length
    if (next > maxChars && kept.length > 0) break
    total = next
    kept.push(line)
  }
  return kept.join("\n")
}

function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}
