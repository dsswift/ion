---
title: Compaction
description: Context window management strategies and configuration.
sidebar_position: 5
---

# Compaction

Compaction reduces the token count of a conversation's message history. As conversations grow, they approach the model's context window limit. Compaction removes or summarizes older messages to keep the conversation within bounds.

## When compaction runs

Compaction can be triggered in three ways:

1. **Threshold** -- when context usage exceeds the configured threshold percentage, the engine triggers compaction before the next LLM call. Set via `compaction.threshold` in engine config (e.g., `0.8` for 80%).
2. **Manual** -- the `compact` command triggers compaction on demand.
3. **Extension hook** -- the `session_before_compact` hook fires before compaction. If any handler returns `true`, compaction is cancelled.

After compaction, the `session_compact` hook fires with details about the strategy used and messages before/after counts.

## Built-in strategies

The engine ships with three compaction strategies. Additional strategies can be registered via the compaction registry.

### micro-compact

Replaces `tool_result` content with `[compacted]` in all messages. Preserves conversational structure and message count, but reduces token usage from large tool outputs.

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

## Configuration

Engine config controls compaction behavior:

```json
{
  "compaction": {
    "strategy": "summary-compact",
    "keepTurns": 10,
    "threshold": 0.8
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `strategy` | Auto-select | Strategy name. Empty means auto-select from preferred order. |
| `keepTurns` | 2 | Number of recent turns to preserve during compaction. |
| `threshold` | 0 (disabled) | Context usage percentage that triggers automatic compaction. |

## Fact extraction

The compaction package includes a fact extraction system that scans messages for structured information before compacting. Extracted fact types:

| Type | Pattern | Example |
|------|---------|---------|
| `decision` | "decided to", "chose", "will use" | "Decided to use PostgreSQL for the cache layer" |
| `file_mod` | File paths in tool results | `/src/api/handler.go` |
| `error` | "error", "failed", "bug" | "Build failed due to missing dependency" |
| `preference` | "prefer", "always", "never" | "Always use snake_case for database columns" |
| `discovery` | "found", "discovered", "realized" | "Found that the API requires auth headers" |

Facts are formatted into a grouped summary that can be prepended to the compacted conversation, preserving key decisions and context even after older messages are removed.

## Post-compaction restore

After compaction, `PostCompactRestore` creates a system message listing recently modified files and deferred tool calls. This helps the LLM maintain awareness of the current project state despite losing the detailed tool history.

## Conversation-level compaction

The `conversation` package also provides direct compaction methods:

- `Compact(conv, keepTurns)` -- drop oldest messages, keep N turns
- `CompactWithSummary(conv, summarize, keepTurns)` -- summarize then drop
- `MicroCompact(conv, keepTurns)` -- clear tool_result content in older messages

These operate on the flat message list. The tree-aware `CompactPartial` in the compaction package works with entry IDs and preserves tree structure.

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
