import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"

// Cap the aggregate output at the same budget as read (50 KB) so a broad grep
// cannot inject ~50K tokens into context in one call (100 rows x 2 KB line cap).
const MAX_BYTES = 50 * 1024

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string; include?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false },
            output: "No files found",
          }
          if (!params.pattern) {
            throw new Error("pattern is required")
          }

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
            },
          })

          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")
          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, requested, {
            bypass: false,
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })

          const search = FSUtil.resolve(requested)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const cwd = info?.type === "Directory" ? search : path.dirname(search)
          const result = yield* ripgrep.grep({
            cwd,
            pattern: params.pattern,
            include: params.include,
            limit: 100,
          })
          if (result.length === 0) return empty

          const rows = result.map((item) => ({
            path: path.resolve(
              requestedInfo?.type === "Directory" ? requested : path.dirname(requested),
              item.entry.path,
            ),
            line: item.line,
            text: item.text,
          }))

          const limit = 100
          const rowTruncated = rows.length === limit
          const total = rows.length

          // Build the grouped output under a hard byte budget (same 50 KB as
          // read). Without it a broad grep can inject up to ~200 KB (~50K
          // tokens) into a single context window.
          const byteSize = (s: string) => Buffer.byteLength(s, "utf8")
          const out: string[] = []
          let current = ""
          let bytes = 0
          let byteTruncated = false
          for (const match of rows) {
            const groupHeader = current !== match.path ? `${current !== "" ? "\n" : ""}${match.path}:` : ""
            const line = `  Line ${match.line}: ${match.text}`
            const add = `${groupHeader}${groupHeader === "" ? "" : "\n"}${line}`
            if (bytes + byteSize(add) > MAX_BYTES) {
              byteTruncated = true
              break
            }
            bytes += byteSize(add)
            current = match.path
            out.push(add)
          }
          if (byteTruncated) {
            out.push("")
            out.push(`(Output capped at ${MAX_BYTES / 1024} KB. Use a more specific path or pattern to narrow results.)`)
          } else if (rowTruncated) {
            out.push("")
            out.push("(Results truncated. Consider using a more specific path or pattern.)")
          }

          return {
            title: params.pattern,
            metadata: {
              matches: total,
              truncated: byteTruncated || rowTruncated,
            },
            output: [`Found ${total} matches${rowTruncated ? " (more matches available)" : ""}`, ...out].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
