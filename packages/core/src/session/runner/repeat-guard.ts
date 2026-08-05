import { SessionMessage } from "../message"

// Number of consecutive identical tool calls that mark a loop.
export const REPEAT_THRESHOLD = 3

// Tools whose repeated identical calls are almost always a loop: each run
// spends a full turn and returns a large result the model already saw.
// Read-only greps/globs are excluded: re-running them is cheap and read.ts
// already dedups unchanged files.
const LOOP_SENSITIVE = new Set(["bash", "edit", "write", "apply_patch", "webfetch", "websearch"])

export interface RepeatedToolCall {
  readonly tool: string
  readonly input: string
}

// Scan session messages for the last N consecutive identical tool calls.
// Returns the repeated (tool, input) when detected, undefined otherwise.
export const detectRepeatedToolCalls = (
  messages: ReadonlyArray<SessionMessage.Message>,
): RepeatedToolCall | undefined => {
  const recent: RepeatedToolCall[] = []
  for (let i = messages.length - 1; i >= 0 && recent.length < REPEAT_THRESHOLD; i--) {
    const message = messages[i]
    if (!message || message.type !== "assistant") continue
    const content = message.content
    for (let j = content.length - 1; j >= 0 && recent.length < REPEAT_THRESHOLD; j--) {
      const item = content[j]
      if (!item || item.type !== "tool") continue
      const tool = item.name
      if (!LOOP_SENSITIVE.has(tool)) continue
      if (item.state.status !== "completed" && item.state.status !== "running") continue
      recent.push({ tool, input: JSON.stringify(item.state.input) })
    }
  }
  if (recent.length < REPEAT_THRESHOLD) return undefined
  const first = recent[0]
  if (recent.every((item) => item.tool === first.tool && item.input === first.input)) return first
  return undefined
}
