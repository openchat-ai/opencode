export * as SessionPrune from "./prune"

import { and, asc, eq, lt } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { SessionHistory } from "./history"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"
import { Token } from "../util/token"
// ============================================================================
// Tool-output pruning: the "drop" fate for finished content.
//
// Once a compaction has folded older history into a summary, the raw tool
// outputs it covered are pure waste: they are never resent (the baseline has
// moved past them) but still occupy durable storage and would be re-serialized
// if history is ever reloaded. Prune zeroes their content and marks
// `time.pruned`, keeping the tool call (the model's action) intact but
// dropping the output payload. This is lossless for the model: the summary
// already captured what mattered.
// ============================================================================

const MINIMUM_PRUNE_TOKENS = 10_000

// Which completed tool outputs are safe to drop. `baselineSeq` is the sequence
// of the latest compaction: anything with a lower seq is already summarized.
export const selectPrunable = (
  messages: ReadonlyArray<{ readonly seq: number; readonly message: SessionMessage.Message }>,
  input: { readonly baselineSeq: number },
): ReadonlyArray<{ readonly messageID: SessionMessage.ID; readonly seq: number; readonly contentIndex: number }> => {
  const targets: Array<{ messageID: SessionMessage.ID; seq: number; contentIndex: number }> = []
  for (const { seq, message } of messages) {
    if (message.type !== "assistant" || !message.time.completed) continue
    if (seq >= input.baselineSeq) continue
    for (let index = 0; index < message.content.length; index++) {
      const part = message.content[index]
      if (part.type !== "tool" || part.state.status !== "completed") continue
      if (part.time.pruned !== undefined) continue
      targets.push({ messageID: message.id, seq, contentIndex: index })
    }
  }
  return targets
}

// Apply the pruning recipe to a message in memory (immutable update). Returns
// the same reference when the target index is not a completed tool part, so
// callers can skip the write-back.
export const applyPrune = (
  message: SessionMessage.Assistant,
  contentIndex: number,
  input: { readonly prunedAt: DateTime.Utc },
): SessionMessage.Assistant => {
  const part = message.content[contentIndex]
  if (part?.type !== "tool" || part.state.status !== "completed" || part.time.pruned !== undefined) return message
  return {
    ...message,
    content: message.content.map((item, index) => {
      if (index !== contentIndex || item.type !== "tool" || item.state.status !== "completed") return item
      return {
        ...item,
        state: { ...item.state, content: [], structured: {} },
        time: { ...item.time, pruned: input.prunedAt },
      }
    }),
  }
}

export interface Interface {
  readonly prune: (input: { readonly sessionID: SessionSchema.ID }) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionPrune") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return Service.of({ prune: (input) => prune(db, input) })
  }),
)

// Standalone prune that only needs a database connection. Used by the runner
// (which already holds `db`) without requiring the SessionPrune layer.
export const prune = (
  db: Database.Interface["db"],
  input: { readonly sessionID: SessionSchema.ID },
): Effect.Effect<number> =>
  Effect.gen(function* () {
    const compaction = yield* SessionHistory.latestCompaction(db, input.sessionID)
    if (!compaction) return 0
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, input.sessionID),
          eq(SessionMessageTable.type, "assistant"),
          lt(SessionMessageTable.seq, compaction.seq),
        ),
      )
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    const decode = Schema.decodeUnknownEffect(SessionMessage.Message)
    const messages: Array<{ seq: number; message: SessionMessage.Message }> = []
    for (const row of rows) {
      const message = yield* decode({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie)
      messages.push({ seq: row.seq, message })
    }
    const targets = selectPrunable(messages, { baselineSeq: compaction.seq })
    if (targets.length === 0) return 0

    // Prune whole assistant messages at once to avoid partial writes.
    const byMessage = new Map<SessionMessage.ID, number[]>()
    const byID = new Map(messages.map((m) => [m.message.id, m.message]))
    let est = 0
    for (const target of targets) {
      byMessage.set(target.messageID, [...(byMessage.get(target.messageID) ?? []), target.contentIndex])
      const message = byID.get(target.messageID)
      const part = message?.type === "assistant" ? message.content[target.contentIndex] : undefined
      if (part?.type === "tool") est += Token.estimate(JSON.stringify(part.state))
    }
    if (est < MINIMUM_PRUNE_TOKENS) return 0

    const encode = Schema.encodeSync(SessionMessage.Message)
    const prunedAt = DateTime.makeUnsafe(Date.now())
    for (const { message } of messages) {
      if (message.type !== "assistant") continue
      const indices = byMessage.get(message.id)
      if (!indices) continue
      let updated: SessionMessage.Message = message
      for (const contentIndex of indices) updated = applyPrune(updated, contentIndex, { prunedAt })
      if (updated === message) continue
      const encoded = encode(updated)
      const { id, type, ...data } = encoded
      yield* db
        .update(SessionMessageTable)
        .set({
          type,
          time_created: DateTime.toEpochMillis(updated.time.created),
          data: data as (typeof SessionMessageTable.$inferInsert)["data"],
        })
        .where(
          and(
            eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
            eq(SessionMessageTable.session_id, input.sessionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    return est
  })
