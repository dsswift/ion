---
title: Compaction
description: Context window management — token-budget truncation, summary fallback, and session memory.
sidebar_position: 5
---

# Compaction

Compaction reduces the token count of a conversation's message history. As conversations grow, they approach the model's context window limit. The engine uses a token-budget-based compaction system that micro-compacts tool results, truncates to a target token budget, and injects a summary from the best available source.

## When compaction runs

Compaction fires in two modes:

1. **Proactive** — before each LLM call, the engine checks whether context usage exceeds the auto-compact token limit (derived from the context window minus output headroom and summary reserve). If so, compaction runs automatically.
2. **Reactive** — when the provider responds with `prompt_too_long` or `overloaded_error`, the engine runs a progressively more aggressive compaction (target budget shrinks with each retry, up to 3 attempts).

### CompactEnabled gate

Proactive compaction can be disabled per-prompt via `compactEnabled: false` in the client command, per-run via `RunOptions.CompactEnabled`, or globally via `compaction.enabled` in `engine.json`. When disabled, the engine skips proactive compaction entirely — reactive compaction still fires on provider errors.

### Hook integration

The `session_before_compact` hook fires before either mode runs. If any handler returns `true`, the compaction is cancelled.

After compaction, the `session_compact` hook fires with the strategy used, messages before/after counts, token metrics, and a slice of structured facts (`Facts: []CompactionFact`) extracted from the pre-compaction messages. Extensions maintaining external memory (vector store, knowledge graph, SQLite) can persist facts durably before the source messages are discarded. `Facts` may be empty when micro-compaction alone was sufficient and no patterns matched.

## Compaction flow

Both proactive and reactive compaction follow the same two-step flow:

### Step 1: MicroCompact

Replaces `tool_result` content (>100 chars) with `[cleared]` in messages older than the most recent N user turns (default 3, configurable via `microCompactKeep`). Image blocks are never cleared. If pass 1 clears nothing, a second pass truncates long assistant text blocks (>200 chars) in the same message range.

After micro-compaction, the engine re-checks context usage. If below the limit, step 2 is skipped.

### Step 2: Token-budget truncation with summary

When micro-compaction is insufficient, the engine hard-truncates to a target token budget (default 50% of context window, configurable via `targetPercent`). Before truncation drops messages, a summary is generated using the **three-tier fallback**:

1. **Session memory** — if the background session memory summarizer has produced a summary, use it (zero-cost, no LLM call).
2. **LLM summary** — send the message text to an LLM for summarization (costs one additional LLM call). Enabled by default; disable with `summaryEnabled: false`.
3. **Regex fact extraction** — extract structured facts via pattern matching (no LLM call). Used as a last resort when both session memory and LLM summarization are unavailable.

`CompactToTokenBudget` then drops the oldest messages, respecting turn boundaries (never orphans a tool_result from its tool_use, never splits a user/assistant pair). A minimum keep-turns floor (default 2, configurable via `keepTurns`) ensures at least that many user turns are preserved even if they exceed the budget. Token estimates use a conservative padding multiplier (default 1.33×) to avoid re-triggering compaction immediately.

For reactive compaction, the target budget shrinks with each retry (`targetPercent / attempt`), so each successive attempt is more aggressive.

## Post-compaction artifacts

After truncation, the engine injects a **transient user message** containing:

- A `[SYSTEM] Context compaction completed` notice with cleared-block count
- The summary (if generated), under `[Extracted facts from compacted context]`
- Recently modified files detected in the remaining messages
- The full transcript path: `{convDir}/{convID}.tree.jsonl` — so the model can read pre-compaction history if needed
- Instructions to use SearchHistory or re-read files rather than recapping

Transient messages are appended to `conv.Messages` but **not** to the session entry list (`conv.Entries`). They appear in the current LLM call but are not persisted to disk or shown in session history on reload.

### Immediate persistence

After compaction, the engine calls `conversation.Save` immediately so the compacted state survives mid-loop crashes. A compaction entry is also recorded in the conversation tree with the summary, first-kept-entry ID, and pre-compaction token count.

## Session memory

The background session memory summarizer maintains a running summary of the conversation in a `.memory.md` file alongside the conversation's `.tree.jsonl` and `.llm.jsonl`. This summary is the first choice in the three-tier fallback — when it exists, compaction avoids an extra LLM call entirely.

### How it works

`SessionMemory` is created when a session starts (or resumes). On each `turn_end`, it checks two debounce conditions:

1. **Minimum turns elapsed** since last update (default 5, configurable via `memoryUpdateMinTurns`)
2. **Sufficient token growth** since last update (default 20,000 tokens, configurable via `memoryUpdateThreshold`)

When both conditions are met, it spawns a background goroutine that:
- Copies the current message state (non-blocking to the runloop)
- Formats messages for summarization
- Attempts an LLM-based summary (configurable model via `memoryModel`, max tokens via `memoryMaxTokens` default 8192)
- Falls back to regex-based fact extraction if LLM is unavailable
- Persists the result to `{convDir}/{convID}.memory.md`

The background goroutine is cancellable via `Stop()` and waits for completion on session teardown.

### System prompt injection

When session memory exists, `InjectMemoryIntoSystemPrompt` appends it to the system prompt as a `## Session Memory (from previous context)` section before each LLM call. This gives the model awareness of compacted history even outside of compaction events.

## Configuration

Engine config (`engine.json`) controls compaction behavior under the `compaction` key:

```json
{
  "compaction": {
    "enabled": true,
    "strategy": "summary-compact",
    "keepTurns": 2,
    "threshold": 0.8,
    "targetPercent": 50,
    "microCompactKeep": 3,
    "estimationPadding": 1.33,
    "summaryEnabled": true,
    "summaryModel": "",
    "summaryMaxTokens": 0,
    "memoryEnabled": true,
    "memoryModel": "",
    "memoryUpdateThreshold": 20000,
    "memoryUpdateMinTurns": 5,
    "memoryMaxTokens": 8192
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool (nullable) | `null` (enabled) | Global gate for proactive compaction. `false` disables proactive compaction; reactive compaction still fires on provider errors. |
| `strategy` | string | `""` | Strategy name for the strategy registry. Empty means auto-select from preferred order. |
| `keepTurns` | int | `2` | Minimum user turns to preserve during token-budget truncation. Safety floor. |
| `threshold` | float | `0` | Legacy threshold (0.0–1.0). Superseded by the token-limit-based trigger. |
| `targetPercent` | float | `50.0` | Post-compact target as a percentage of the context window. |
| `microCompactKeep` | int | `3` | Number of recent user turns whose tool results are protected from micro-compaction. |
| `estimationPadding` | float | `1.33` | Multiplier applied to heuristic token estimates (conservative buffer to avoid immediate re-compaction). |
| `summaryEnabled` | bool (nullable) | `null` (enabled) | Whether LLM-based summarization is used during compaction (tier 2 of the fallback). |
| `summaryModel` | string | `""` | Model to use for LLM summarization. Empty uses the session's current model. |
| `summaryMaxTokens` | int | `0` | Max output tokens for LLM summarization. `0` uses the provider default. |
| `memoryEnabled` | bool (nullable) | `null` (enabled) | Whether the background session memory summarizer is active. |
| `memoryModel` | string | `""` | Model to use for background memory summarization. Empty uses the session's current model. |
| `memoryUpdateThreshold` | int | `20000` | Token growth since last update before triggering a new background summary. |
| `memoryUpdateMinTurns` | int | `5` | Minimum turns between background memory updates. |
| `memoryMaxTokens` | int | `8192` | Max output tokens for the background memory summary. |

All fields can also be overridden per-prompt via the client command or per-run via `RunOptions`.

## Fact extraction

The compaction package includes a fact extraction system that scans messages for structured information before compacting. Extracted fact types:

| Type | Pattern | Example |
|------|---------|---------|
| `decision` | "decided to", "chose", "will use" | "Decided to use PostgreSQL for the cache layer" |
| `file_mod` | File paths in tool results | `/src/api/handler.go` |
| `error` | "error", "failed", "bug" | "Build failed due to missing dependency" |
| `preference` | "prefer", "always", "never" | "Always use snake_case for database columns" |
| `discovery` | "found", "discovered", "realized" | "Found that the API requires auth headers" |

Facts are formatted into a grouped summary that can be prepended to the compacted conversation, preserving key decisions and context even after older messages are removed. Facts are also passed to the `session_compact` hook so extensions can persist them externally.

## Built-in strategies

The engine ships with three compaction strategies. Additional strategies can be registered via the compaction registry.

### micro-compact

Replaces `tool_result` content with `[cleared]` in messages older than the protected turn window (default 3 turns). A second pass truncates long assistant text blocks if the first pass found nothing to clear. Preserves conversational structure and message count, but reduces token usage from large tool outputs.

Best for: conversations with many tool calls producing large outputs (file reads, grep results).

### summary-compact

Replaces older messages with an LLM-generated summary. Keeps the most recent N turns intact (default 2) and summarizes everything before them into a single `[Conversation summary]` message.

Requires a `Summarize` callback that sends the text to an LLM for summarization. This means summary compaction costs one additional LLM call.

Best for: long conversations where preserving exact tool output is not important.

### truncate

Drops the oldest messages, keeping only the most recent N turns (default 2). No summarization, no LLM call.

Best for: simple use cases where older context is disposable.

## Strategy selection

The compaction registry supports a preferred order. `SelectStrategy` returns the first strategy whose `CanHandle` returns true:

```go
// Set preferred order
SetPreferredOrder([]string{"summary-compact", "micro-compact", "truncate"})

// Auto-select based on message content
strategy := SelectStrategy(messages, opts)
```

You can also request a specific strategy by name:

```go
result, err := ExecuteCompaction(messages, opts, "micro-compact")
```

## CompactionStrategy interface

Custom strategies implement:

```go
type CompactionStrategy interface {
    Name() string
    Description() string
    CanHandle(messages []LlmMessage, options *CompactionOptions) bool
    Compact(messages []LlmMessage, options *CompactionOptions) ([]LlmMessage, *CompactionResult, error)
}
```

Register with `RegisterStrategy(strategy)`. The strategy appears in auto-selection and can be requested by name.
