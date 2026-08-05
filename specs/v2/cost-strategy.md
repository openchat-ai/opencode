# Cost Strategy

Session-cost reduction across two planes: **token volume** (how many input tokens each provider call carries) and **summary quality** (how much live context survives compaction losslessly). All levers are model-agnostic: they optimize *input tokens sent* and *provider calls*, which are linear transforms of money on every provider.

Reference models and experiments live in `packages/opencode/test/cost/` (`strategy.test.ts`, `progressive-compaction.test.ts`, `history-bounding.test.ts`). Implementations live in `packages/core` (session machinery) and `packages/opencode` (tool calls).

## Metrics

- **Input tokens sent**: the history resent every turn dominates cost. Unbounded history grows O(T²); bounding it makes resend O(T).
- **Provider calls**: each call resends the full current history. Eliminating a wasted turn eliminates that resend too.

## Levers

| # | Lever | Plane | Trigger | Commit |
|---|-------|-------|---------|--------|
| 1 | read dedup | tokens | unchanged file re-read | `5bdbff98a4` |
| 2 | loop guard | calls | 3 identical loop-sensitive tool calls | `8dc05ce796` |
| 3 | grep cap | tokens | grep result > 50 KB | `f0422f7601` |
| 4 | watermark compaction | tokens | serialized history > `compaction.watermark` | `f789fe58a4` |
| 5 | stale instruction decay | tokens | dated AGENTS.md section > 90 days old | `9557d13733` |
| 6 | drop consumed tool output | tokens | completed tool output older than latest compaction | `902587f52d` |
| 7 | pin standing instructions | quality | a user message is folded into a summary | `f35e05ce46` |

## Token-plane levers

### 1. read dedup (`packages/opencode/src/tool/read.ts`)

A re-read of a file whose `(path, mtimeMs, size, lineStart, lineEnd)` fingerprint is unchanged returns a ~50-token digest instead of the full file. The fingerprint includes the requested slice, so overlapping-but-different windows still re-read. Saves input tokens only — call count is unchanged. Value grows with file size and with the number of redundant re-reads.

### 2. loop guard (`packages/core/src/session/runner/repeat-guard.ts`)

`detectRepeatedToolCalls` scans the last assistant messages for 3 consecutive identical tool calls among loop-sensitive tools (`bash`, `edit`, `write`, `apply_patch`, `webfetch`, `websearch`). On detection the runner injects a correction instead of issuing another provider call. Read-only greps/globs are excluded: re-running them is cheap and read dedup already covers unchanged files. Saves provider calls *and* each call's full-history resend.

### 3. grep cap (`packages/opencode/src/tool/grep.ts`)

grep output is capped at 50 KB, matching read. An uncapped broad grep can inject ~200 KB (~50K tokens) in one result via ripgrep's 2 KB line cap times the 100-row limit. The cap bounds the worst single-result injection at ~12.5K tokens.

### 4. watermark compaction (`packages/core/src/session/compaction.ts`)

`shouldCompact` fires compaction when estimated serialized history exceeds `compaction.watermark` (default 64K tokens) **or** the complete request exceeds the context window minus reserved headroom. The watermark is the primary cost lever: it re-bounds history to `keep.tokens` + one summary well before it can grow large, changing the repeated-history cost from O(T²) to O(T). The overflow trigger remains a safety net for small-context models.

Each compaction stores a hidden checkpoint (`session.next.compaction.ended.1`): a structured rolling summary plus token-bounded serialized recent context. The full transcript stays durable; only the model-visible representation is replaced. Repeated compactions update the prior summary incrementally.

**Cost model** (see `progressive-compaction.test.ts`, T=1200 turns): unbounded history costs O(T²). At watermark C the net cost (session resend + summary maintenance) is:

| Watermark | Net ratio vs unbounded |
|-----------|------------------------|
| 20K       | ~190x |
| 64K       | ~102x |
| 100K      | ~82x |

Maintenance stays a minority of net cost (< 30%) because each compaction re-reads only the evicted span (`history - KEEP`), not the whole history. Smaller watermarks win within the granularity floor set by tool-output size (~20K).

### 5. stale instruction decay (`packages/core/src/instruction-context.ts`)

`partitionInstructions` splits AGENTS.md content by `## Heading (YYYY-MM-DD)` tail dates; `renderHistorical` folds sections older than 90 days into a "Historical lessons" block capped at 2K tokens. Undated sections never decay; project files decay only within their own project scope (`fs.up`). Zero loss: content is retained in the historical block, only demoted and capped. Validation on a real AGENTS.md: after a simulated 6 months, 16 stale lessons (~5K tokens) demote correctly while the active section stays ~3.3K.

## Summary-quality levers

The token-plane levers bound *how much* is sent; the summary-plane levers control *what survives* the compaction boundary — the qualitative half that a token model cannot capture.

### 6. drop consumed tool output (`packages/core/src/session/prune.ts`)

`selectPrunable` finds completed tool outputs older than the latest compaction baseline; `applyPrune` empties `content`/`structured` and stamps `time.pruned` on a new message reference (immutable; returns the same reference when nothing changed so the DB write-back is skipped). The runner forks the prune (`Effect.forkDetach` + `Effect.ignore`) after a compaction completes, behind a `MINIMUM_PRUNE_TOKENS=10_000` floor so tiny sessions are left alone. Running/error/already-pruned tool outputs are never touched.

**Cost model** (drop vs summarize, `progressive-compaction.test.ts`): a `deadFraction` of each eviction skips the summary LLM read. At C=64K: dead=0.5 → 112x, dead=0.7 → 117x. Honest ceiling: dropping every evicted byte still leaves the summary *output* (compactions × SUMMARY), which is a minority of net — so drop is a modest token lever. Its real value is qualitative: dead tool output no longer dilutes the summary density.

### 7. pin standing instructions (`packages/core/src/session/compaction.ts`, `runner/to-llm-message.ts`)

`extractPinned` takes the last non-empty user message from the entries about to be folded (`select` now tracks `headEntries` — the raw entries, not just the serialized head). It skips assistant/empty/compaction messages. The pinned text is stored on the compaction message (`Compaction.pinned`, optional; surfaced through `Compaction.Ended` event and the projector) and rendered on the next provider turn as a `<standing-instructions>` block **outside** `<summary>`, so it reads as an active instruction rather than historical context.

Motivation: a one-line constraint like "reply in Chinese" folded into a lossy summary is diluted away across repeated compactions. Pinning it verbatim lets it survive as a standing constraint. The `Compaction`/`Compaction.Ended` schema change flows through `message-updater.ts` and regenerated client types (`packages/client/src/generated/types.ts`).

## Design notes

- **Two fates for finished content**: drop (dead/consumed tool output, erased) and pin (live standing instructions, preserved verbatim). Both are the qualitative counterpart to the quantitative watermark lever.
- **Immutability**: `applyPrune` returns the same reference when nothing changed, so `prune` skips pointless DB writes.
- **Determinism**: prune and decay are pure functions over projected history — no LLM cost, no ordering dependence on the runner's recovery path.
- **Safety nets**: overflow compaction stays as a fallback for small-context models; prune respects already-pruned markers and never touches running/error tools; decay never deletes content.

## Open follow-ups

- Deterministic tool-result pruning was explicitly deferred in the compaction design (`specs/v2/session.md`); drop is the first cut and currently prunes all eligible completed tool outputs after the latest compaction, not just overflow survivors.
- Pin currently captures one user message (the last non-empty in the folded head). A structural heuristic (e.g. instructions matching an allowlist or short-command shape) could generalize it without an LLM.
- `time.pruned` is a new schema field; no migration is required (JSON message rows) but downstream tooling that reads tool `content` must tolerate pruned parts.
