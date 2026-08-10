export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@opencode-ai/llm"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"
import type { FileAttachment } from "./prompt"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 15_000
const DEFAULT_WATERMARK = 64_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
const COMPACTION_CHUNK_TOKENS = 32_000
const REQUEST_BODY_COMPACTION_BYTES = 8 * 1024 * 1024
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Standing Instructions
- [standing user instructions that must survive future compactions, such as language, tone, formatting, or workflow rules; otherwise "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
  readonly watermark: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
  readonly requestBytes: number
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
      watermark: current.watermark ?? result.watermark,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS, watermark: DEFAULT_WATERMARK },
  )
}

const select = (
  entries: readonly Entry[],
  tokens: number,
): { readonly head: string; readonly recent: string; readonly headEntries: readonly Entry[]; readonly media: readonly FileAttachment[] } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => ({ entry, text: serialize(entry.message) }))
    .filter((item) => item.text.length > 0)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  let splitPrefix = ""
  let splitSuffix = ""
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index].text)
    if (next > tokens) {
      const remaining = Math.max(0, tokens - total) * 4
      if (remaining > 0) {
        splitPrefix = conversation[index].text.slice(0, -remaining)
        splitSuffix = conversation[index].text.slice(-remaining)
        split = index + 1
      }
      break
    }
    total = next
    split = index
  }
  const headItems = conversation.slice(0, split)
  const media = headItems.flatMap((item) => (item.entry.message.type === "user" ? (item.entry.message.files ?? []) : []))
  return {
    head: [...headItems.map((item) => item.text), splitPrefix].filter(Boolean).join("\n\n"),
    recent: [splitSuffix, ...conversation.slice(split).map((item) => item.text)].filter(Boolean).join("\n\n"),
    headEntries: (splitPrefix ? headItems.slice(0, -1) : headItems).map((item) => item.entry),
    media,
  }
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

// Split a large context into bounded chunks so a single compaction request does
// not itself overflow the provider context window. Each chunk is summarized in
// its own bounded request and the running summary feeds the next chunk.
const chunkContext = (context: readonly string[]) => {
  const value = context.filter(Boolean).join("\n\n")
  const size = COMPACTION_CHUNK_TOKENS * 4
  return Array.from({ length: Math.ceil(value.length / size) }, (_, index) =>
    value.slice(index * size, (index + 1) * size),
  )
}

// Extract standing instructions from the summary produced by the compaction
// model. The summary template asks the model to record user instructions that
// must survive compaction (language, tone, formatting, workflow rules) under a
// "Standing Instructions" section. This replaces the old heuristic that pinned
// the last user message verbatim, which could not tell a persistent constraint
// like "use Chinese" from a one-off query. Returns undefined when the section
// is absent or empty.
export const extractPinned = (summary: string): string | undefined => {
  const lines = summary.split("\n")
  const start = lines.findIndex((line) => line.trim() === "## Standing Instructions")
  if (start === -1) return undefined
  const content: string[] = []
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index].trim().startsWith("## ")) break
    content.push(lines[index])
  }
  const text = content.join("\n").trim()
  if (text.length === 0 || text === "(none)") return undefined
  return text
}

// Decide whether a request needs compaction before the LLM call. Compact when
// the history is at/over the watermark (progressive trigger) OR the full
// request approaches the model context limit (overflow fallback). The
// watermark is what makes history resend cost O(T) instead of O(T^2): history
// is re-bounded to KEEP + SUMMARY long before it can grow large.
export const shouldCompact = (input: {
  readonly request: Pick<LLMRequest, "system" | "messages" | "tools" | "generation">
  readonly model: Model
  readonly auto: boolean
  readonly buffer: number
  readonly watermark: number
  readonly requestBytes?: number
}) => {
  if (!input.auto) return false
  if (input.requestBytes !== undefined && input.requestBytes >= REQUEST_BODY_COMPACTION_BYTES) return true
  const context = input.model.route.defaults.limits?.context
  if (context === undefined || context <= 0) return false
  const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
  const estimateMessages = estimate({ messages: input.request.messages })
  const nearOverflow =
    estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }) >
    context - Math.max(output, input.buffer)
  const overWatermark = estimateMessages > input.watermark
  return nearOverflow || overWatermark
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    const contexts = chunkContext([
      previousSummary?.type === "compaction" ? previousSummary.recent : "",
      selected.head,
    ])
    const summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: contexts,
    })
    if (Token.estimate(summaryPrompt) > context - summaryOutput) return false
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
    })

    let summary = previousSummary?.type === "compaction" ? previousSummary.summary : undefined
    for (const [index, chunk] of contexts.entries()) {
      const chunks: string[] = []
      const publish = index === contexts.length - 1
      const timestamp = yield* DateTime.now
      let failed = false
      const summarized = yield* dependencies.llm
        .stream(
          LLM.request({
            model: input.model,
            messages: [Message.user(buildPrompt({ previousSummary: summary, context: [chunk] }))],
            tools: [],
            generation: { maxTokens: summaryOutput },
          }),
        )
        .pipe(
          Stream.runForEach((event) => {
            if (LLMEvent.is.providerError(event)) failed = true
            if (LLMEvent.is.textDelta(event)) {
              chunks.push(event.text)
              if (publish) return dependencies.events.publish(SessionEvent.Compaction.Delta, {
                sessionID: input.sessionID,
                messageID,
                text: event.text,
                timestamp,
              })
            }
            return Effect.void
          }),
          Effect.as(true),
          Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
        )
      const next = chunks.join("")
      if (!summarized || failed || !next.trim()) return false
      summary = next
    }
    if (!summary?.trim()) return false
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
      text: summary,
      recent: selected.recent,
      pinned: extractPinned(summary),
      media: selected.media,
    })
    return true
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (
      !shouldCompact({
        request: input.request,
        model: input.model,
        auto: config.auto,
        buffer: config.buffer,
        watermark: config.watermark,
        requestBytes: input.requestBytes,
      })
    )
      return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
