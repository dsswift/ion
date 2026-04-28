---
title: Sessions
description: Stateful conversation containers with tree-based branching and persistence.
sidebar_position: 1
---

# Sessions

A session is a stateful conversation container managed by the engine. It holds the conversation history, extension state, tool configuration, and active run status. Multiple sessions can exist simultaneously, each identified by a unique key.

## What a session contains

| Component | Description |
|-----------|-------------|
| Conversation | Tree-structured message history with branching and compaction |
| Extension host | Loaded extension with registered hooks, tools, and commands |
| Permission engine | Tool-level permission policy (allow, deny, ask) |
| MCP connections | Connected MCP servers with their tool registrations |
| Prompt queue | Queued prompts waiting for the active run to finish (max 32) |
| Telemetry | Optional structured event collection |
| Idle timer | Auto-shutdown after inactivity |

## Session manager

The `Manager` orchestrates all active sessions. It routes prompts to the backend, translates events from the normalizer into engine events, and forwards those events to connected clients.

```
Client -> Manager.SendPrompt(key, text)
           -> Backend.StartRun(requestID, opts)
              -> LLM stream + tool execution
              -> NormalizedEvent -> EngineEvent -> Client
```

The manager holds a map of sessions keyed by string. Operations are thread-safe via `sync.RWMutex`.

## Key operations

| Operation | Method | Description |
|-----------|--------|-------------|
| Create | `StartSession(key, config)` | Initialize session with model, directory, extensions |
| Prompt | `SendPrompt(key, text, overrides)` | Send a prompt (queued if a run is active) |
| Abort | `SendAbort(key)` | Cancel the active run |
| Fork | `ForkSession(key, messageIndex)` | Branch conversation at a message index |
| Branch | `BranchSession(key, entryID)` | Move leaf pointer to an entry |
| Navigate | `NavigateSession(key, targetID)` | Navigate the conversation tree |
| Stop | `StopSession(key)` | Cleanup and destroy the session |

## Further reading

- [Lifecycle](lifecycle.md) -- create, run, idle, stop flow
- [Persistence](persistence.md) -- JSONL format and storage
- [Branching](branching.md) -- conversation tree model
- [Compaction](compaction.md) -- context window management strategies
