---
title: Hook System
description: How the Ion Engine hook system works, dispatch model, and return patterns.
sidebar_position: 1
---

# Hook System

The Ion Engine exposes 59 hooks across 16 categories. Hooks let extensions observe, modify, and gate engine behavior without changing engine code. Extensions register handlers via the SDK; the engine fires hooks at defined points during session and tool lifecycles.

## Dispatch Model

Handlers registered for a hook run **sequentially** in registration order. Each handler receives the same `Context` and payload. The engine collects all non-nil return values and applies the resolution rule for that hook category.

Errors from individual handlers are logged but do not stop subsequent handlers from running. A handler that returns an error is skipped in the result set.

### Prepend Priority

`PrependHook` inserts a handler at the front of the chain. Use this for enterprise-required hooks that must run before extension handlers.

## Return Patterns

Hooks fall into five return patterns. The pattern determines what happens when a handler returns a non-nil value.

### Observe (void)

Handler return values are ignored. Used for logging, metrics, and side effects.

```
Return: ignored
Examples: session_start, session_end, turn_start, message_start, tool_start
```

### Override (last non-nil wins)

Multiple handlers may return values. The **last** non-nil result in the handler chain wins. Used when extensions compete to transform input.

```
Return: string or typed result
Examples: before_prompt, input, model_select, per-tool result hooks
```

### Cancel (bool gate)

If any handler returns `true`, the operation is cancelled. First `true` wins.

```
Return: bool
Examples: session_before_compact, session_before_fork, context_discover
```

### Block (with reason)

If any handler returns a result struct with `Block: true`, the operation is blocked. The `Reason` field explains why.

```
Return: *ToolCallResult{Block, Reason} or *PerToolCallResult{Block, Reason, Mutate}
Examples: tool_call, per-tool call hooks
```

### Inject (accumulate)

All non-nil results are collected and merged. Used when multiple extensions contribute content.

```
Return: []ContextEntry, []Capability, or typed slices
Examples: context_inject, capability_discover
```

## Hook Categories

| Category | Count | Purpose |
|----------|-------|---------|
| Lifecycle | 13 | Session, turn, message, tool, agent, and error events |
| Session Management | 5 | Compaction, fork, and switch gates |
| Pre-Action | 2 | Intercept before agent start or provider request |
| Content | 6 | Context, message updates, input rewriting, model selection |
| Per-Tool Call | 7 | Gate or mutate individual tool invocations |
| Per-Tool Result | 7 | Modify individual tool results |
| Context Discovery | 3 | Filter or modify context files and instructions |
| Permission | 2 | Observe permission decisions |
| File Changes | 1 | Observe file system changes |
| Task Lifecycle | 2 | Observe task creation and completion |
| Elicitation | 2 | Handle and observe structured user input requests |
| Plan Mode | 1 | Override plan mode prompt and tool list |
| Context Injection | 1 | Inject additional context into system prompt |
| Capability Framework | 3 | Discover, match, and gate capabilities |
| Extension Lifecycle | 4 | React to extension subprocess crashes and auto-respawn |

## Handler Signature

All hook handlers share a single signature:

```go
type HookHandler func(ctx *Context, payload interface{}) (interface{}, error)
```

- `ctx` carries session context: working directory, model info, config, event emitter, and process management functions.
- `payload` is hook-specific data (typed structs, strings, or nil).
- Return `nil, nil` to express no opinion. Return a value to influence the outcome (per the hook's return pattern).

## Context Object

The `Context` passed to every handler provides:

| Field | Type | Purpose |
|-------|------|---------|
| `Cwd` | `string` | Working directory |
| `Model` | `*ModelRef` | Active model ID and context window size |
| `Config` | `*ExtensionConfig` | Extension directory, options, MCP config path |
| `Emit` | `func(EngineEvent)` | Emit events to connected socket clients |
| `GetContextUsage` | `func() *ContextUsage` | Current context utilization (percent, tokens, cost) |
| `Abort` | `func()` | Abort the current session |
| `RegisterAgent` | `func(name, handle)` | Register a named agent handle |
| `DeregisterAgent` | `func(name)` | Remove a named agent handle |
| `ResolveTier` | `func(name) string` | Resolve a model tier name to a model ID |
| `RegisterProcess` | `func(name, pid, task) error` | Track extension-spawned subprocesses |
| `DeregisterProcess` | `func(name)` | Remove a tracked subprocess |
| `ListProcesses` | `func() []ProcessInfo` | List tracked subprocesses |
| `TerminateProcess` | `func(name) error` | Terminate a tracked subprocess |
| `CleanStaleProcesses` | `func() int` | Clean up stale subprocess entries |
| `DispatchAgent` | `func(DispatchAgentOpts) (*DispatchAgentResult, error)` | Dispatch an engine-native child agent |
