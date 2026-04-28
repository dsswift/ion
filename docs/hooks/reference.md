---
title: Hook Reference
description: Complete reference for all 59 Ion Engine hooks with payloads, return types, and behavior.
sidebar_position: 2
---

# Hook Reference

All 59 hooks grouped by category. For each hook: when it fires, what payload it receives, what return values do, and the dispatch pattern.

## Lifecycle (13)

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `session_start` | Session initialized | `nil` | ignored | Observe only |
| `session_end` | Session teardown | `nil` | ignored | Observe only |
| `before_prompt` | Before prompt sent to LLM | `string` (prompt) | `BeforePromptResult{Prompt, SystemPrompt}` or `string` | Last non-nil wins. String = prompt rewrite. Struct can set both prompt and system prompt addition. |
| `turn_start` | Start of each LLM turn | `TurnInfo{TurnNumber}` | ignored | Observe only |
| `turn_end` | End of each LLM turn | `TurnInfo{TurnNumber}` | ignored | Observe only |
| `message_start` | Before LLM streaming begins | `nil` | ignored | Observe only |
| `message_end` | After LLM message completes | `nil` | ignored | Observe only |
| `tool_start` | Before tool execution | `ToolStartInfo{ToolName, ToolID}` | ignored | Observe only |
| `tool_end` | After tool execution | `nil` | ignored | Observe only |
| `tool_call` | LLM requests tool use | `ToolCallInfo{ToolName, ToolID, Input}` | `*ToolCallResult{Block, Reason}` | If any handler returns Block=true, the tool call is blocked. |
| `on_error` | Error occurs (provider, tool, budget, session, hook) | `ErrorInfo{Message, ErrorCode, Category, Retryable, RetryAfterMs, HttpStatus}` | ignored | Observe only. Fires for all error categories including `hook_failed` (with stack traces) and provider HTTP errors with full status and retry timing. |
| `agent_start` | Sub-agent starts | `AgentInfo{Name, Task}` | ignored | Observe only |
| `agent_end` | Sub-agent ends | `AgentInfo{Name, Task}` | ignored | Observe only |

### Payload Types

**TurnInfo**
```go
type TurnInfo struct {
    TurnNumber int
}
```

**ToolStartInfo**
```go
type ToolStartInfo struct {
    ToolName string
    ToolID   string
}
```

**ToolCallInfo**
```go
type ToolCallInfo struct {
    ToolName string
    ToolID   string
    Input    map[string]interface{}
}
```

**ToolCallResult**
```go
type ToolCallResult struct {
    Block  bool
    Reason string
}
```

**ErrorInfo**
```go
type ErrorInfo struct {
    Message      string
    ErrorCode    string
    Category     ErrorCategory  // "tool_error", "provider_error", "permission_error", "mcp_error", "compaction_error", "hook_error"
    Retryable    bool
    RetryAfterMs int64
    HttpStatus   int
}
```

**AgentInfo**
```go
type AgentInfo struct {
    Name string
    Task string
}
```

**BeforePromptResult**
```go
type BeforePromptResult struct {
    Prompt       string // rewritten user prompt; empty = no change
    SystemPrompt string // appended to system prompt; empty = no change
}
```

## Session Management (5)

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `session_before_compact` | Before context compaction | `CompactionInfo{Strategy, MessagesBefore, MessagesAfter}` | `bool` | Return `true` to cancel compaction. |
| `session_compact` | After compaction completes | `CompactionInfo{Strategy, MessagesBefore, MessagesAfter}` | ignored | Observe only |
| `session_before_fork` | Before session fork | `ForkInfo{SourceSessionKey, NewSessionKey, ForkMessageIndex}` | `bool` | Return `true` to cancel fork. |
| `session_fork` | After fork completes | `ForkInfo{SourceSessionKey, NewSessionKey, ForkMessageIndex}` | ignored | Observe only |
| `session_before_switch` | Before session switch | `nil` | ignored | Observe only |

### Payload Types

**CompactionInfo**
```go
type CompactionInfo struct {
    Strategy       string
    MessagesBefore int
    MessagesAfter  int
}
```

**ForkInfo**
```go
type ForkInfo struct {
    SourceSessionKey string
    NewSessionKey    string
    ForkMessageIndex int
}
```

## Pre-Action (2)

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `before_agent_start` | Before a sub-agent launches | `AgentInfo{Name, Task}` | `BeforeAgentStartResult{SystemPrompt}` | Last non-nil wins. Injects system prompt into the sub-agent. |
| `before_provider_request` | Before LLM provider request | provider request data | ignored | Observe only |

### Payload Types

**BeforeAgentStartResult**
```go
type BeforeAgentStartResult struct {
    SystemPrompt string
}
```

## Content (6)

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `context` | Context data available | context data | ignored | Observe only |
| `message_update` | Message content updated | `MessageUpdateInfo{Role, Content}` | ignored | Observe only |
| `tool_result` | Tool returns a result | tool result data | ignored | Observe only |
| `input` | User input received | `string` (prompt) | `string` | Last non-nil string wins. Rewrites the user prompt. |
| `model_select` | Model selection occurs | `ModelSelectInfo{RequestedModel, AvailableModels}` | `string` (model ID) | Last non-nil string wins. Overrides model selection. Wired in session manager -- fires on every model resolution. |
| `user_bash` | User runs bash command | `string` (command) | ignored | Observe only |

### Payload Types

**MessageUpdateInfo**
```go
type MessageUpdateInfo struct {
    Role    string
    Content string
}
```

**ModelSelectInfo**
```go
type ModelSelectInfo struct {
    RequestedModel  string
    AvailableModels []string
}
```

## Per-Tool Call (7)

These hooks fire before a specific tool executes. The hook name is `{toolName}_tool_call`. Available for all core file/code tools.

| Hook | Payload | Return | Effect |
|------|---------|--------|--------|
| `bash_tool_call` | bash tool input | `*PerToolCallResult` | Block or mutate |
| `read_tool_call` | read tool input | `*PerToolCallResult` | Block or mutate |
| `write_tool_call` | write tool input | `*PerToolCallResult` | Block or mutate |
| `edit_tool_call` | edit tool input | `*PerToolCallResult` | Block or mutate |
| `grep_tool_call` | grep tool input | `*PerToolCallResult` | Block or mutate |
| `glob_tool_call` | glob tool input | `*PerToolCallResult` | Block or mutate |
| `agent_tool_call` | agent tool input | `*PerToolCallResult` | Block or mutate |

If any handler returns `Block: true`, the tool call is blocked with the given `Reason`. The `Mutate` field (a `map[string]interface{}`) can modify tool input parameters before execution.

### Payload Type

**PerToolCallResult**
```go
type PerToolCallResult struct {
    Block  bool
    Reason string
    Mutate map[string]interface{}
}
```

## Per-Tool Result (7)

These hooks fire after a specific tool returns. The hook name is `{toolName}_tool_result`. Available for all core file/code tools.

| Hook | Payload | Return | Effect |
|------|---------|--------|--------|
| `bash_tool_result` | tool result data | `string` | Modify result content |
| `read_tool_result` | tool result data | `string` | Modify result content |
| `write_tool_result` | tool result data | `string` | Modify result content |
| `edit_tool_result` | tool result data | `string` | Modify result content |
| `grep_tool_result` | tool result data | `string` | Modify result content |
| `glob_tool_result` | tool result data | `string` | Modify result content |
| `agent_tool_result` | tool result data | `string` | Modify result content |

Last non-nil string return wins. The returned string replaces the tool result content seen by the LLM.

## Context Discovery (3)

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `context_discover` | Context file discovered | `ContextDiscoverInfo{Path, Source}` | `bool` | Return `true` to reject the file. |
| `context_load` | Context file loaded | `ContextLoadInfo{Path, Content, Source}` | `string` or `bool` | String = modified content. `true` = reject file. |
| `instruction_load` | Instruction file loaded | `ContextLoadInfo{Path, Content, Source}` | `string` or `bool` | String = modified content. `true` = reject file. |

### Payload Types

**ContextDiscoverInfo**
```go
type ContextDiscoverInfo struct {
    Path   string
    Source string
}
```

**ContextLoadInfo**
```go
type ContextLoadInfo struct {
    Path    string
    Content string
    Source  string
}
```

## Permission (2)

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `permission_request` | Permission check occurs | `PermissionRequestInfo{ToolName, Input, Decision, RuleName}` | ignored | Observe only. Reports the decision and which rule matched. |
| `permission_denied` | Permission denied | `PermissionDeniedInfo{ToolName, Input, Reason}` | ignored | Observe only |

### Payload Types

**PermissionRequestInfo**
```go
type PermissionRequestInfo struct {
    ToolName string
    Input    map[string]interface{}
    Decision string
    RuleName string
}
```

**PermissionDeniedInfo**
```go
type PermissionDeniedInfo struct {
    ToolName string
    Input    map[string]interface{}
    Reason   string
}
```

## File Changes (1)

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `file_changed` | File created, modified, or deleted | `FileChangedInfo{Path, Action}` | ignored | Observe only |

### Payload Types

**FileChangedInfo**
```go
type FileChangedInfo struct {
    Path   string
    Action string
}
```

## Task Lifecycle (2)

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `task_created` | Task spawned | `TaskLifecycleInfo{TaskID, Name, Status, Extra}` | ignored | Observe only |
| `task_completed` | Task finished | `TaskLifecycleInfo{TaskID, Name, Status, Extra}` | ignored | Observe only |

### Payload Types

**TaskLifecycleInfo**
```go
type TaskLifecycleInfo struct {
    TaskID string
    Name   string
    Status string
    Extra  map[string]interface{}
}
```

## Elicitation (2)

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `elicitation_request` | Structured input requested from user | `ElicitationRequestInfo{RequestID, Schema, URL, Mode}` | `map[string]interface{}` | First non-nil response is used as the user's answer. |
| `elicitation_result` | Elicitation response received | `ElicitationResultInfo{RequestID, Response, Cancelled}` | ignored | Observe only |

### Payload Types

**ElicitationRequestInfo**
```go
type ElicitationRequestInfo struct {
    RequestID string
    Schema    map[string]interface{}
    URL       string
    Mode      string
}
```

**ElicitationResultInfo**
```go
type ElicitationResultInfo struct {
    RequestID string
    Response  map[string]interface{}
    Cancelled bool
}
```

## Plan Mode (1)

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `plan_mode_prompt` | Plan mode session starts | `string` (plan file path) | `PlanModePromptResult{Prompt, Tools}` or `string` | Last non-nil wins. Override plan mode prompt and/or allowed tool list. |

### Payload Types

**PlanModePromptResult**
```go
type PlanModePromptResult struct {
    Prompt string   // custom plan mode prompt; empty = use default
    Tools  []string // custom allowed tools; nil = use default
}
```

## Context Injection (1)

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `context_inject` | System prompt assembled | `ContextInjectInfo{WorkingDirectory, DiscoveredPaths}` | `[]ContextEntry` or `ContextEntry` | All entries are collected and injected into the system prompt. |

### Payload Types

**ContextInjectInfo**
```go
type ContextInjectInfo struct {
    WorkingDirectory string
    DiscoveredPaths  []string
}
```

**ContextEntry**
```go
type ContextEntry struct {
    Label   string // identifier shown in prompt (e.g. file path)
    Content string // raw content to inject
}
```

## Capability Framework (3)

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `capability_discover` | Session start, capability registration | `nil` | `[]Capability` or `Capability` | All returned capabilities are registered. |
| `capability_match` | User input received, before routing | `CapabilityMatchInfo{Input, Capabilities}` | `*CapabilityMatchResult{MatchedIDs, Args}` | Last non-nil with matched IDs wins. Identifies which capabilities handle the input. |
| `capability_invoke` | Before capability execution | `{CapabilityID, Input}` | `*ToolCallResult{Block, Reason}` | If any handler returns Block=true, execution is blocked. |

### Payload Types

**CapabilityMatchInfo**
```go
type CapabilityMatchInfo struct {
    Input        string   // user's raw input
    Capabilities []string // all registered capability IDs
}
```

**CapabilityMatchResult**
```go
type CapabilityMatchResult struct {
    MatchedIDs []string               // capabilities to invoke
    Args       map[string]interface{} // arguments extracted from input
}
```

**Capability**
```go
type Capability struct {
    ID          string
    Name        string
    Description string
    Metadata    map[string]interface{}
    Mode        CapabilityMode         // CapabilityModeTool, CapabilityModePrompt, or both
    InputSchema map[string]interface{} // JSON Schema (when Mode includes Tool)
    Execute     func(ctx *Context, input map[string]interface{}) (*ToolResult, error)
    Prompt      string                 // injected into system prompt (when Mode includes Prompt)
}
```

## Extension Lifecycle (4)

Fire when the engine auto-respawns a crashed extension subprocess. Respawn happens only when no run is in flight; mid-turn deaths defer until the run finishes. The strike budget is 3 respawns within a rolling 60s window — exceeding it leaves the host permanently dead until the user closes the tab. Observational hooks; return values are ignored.

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `extension_respawned` | Fires on the new instance after the init handshake completes | `ExtensionRespawnedInfo{AttemptNumber, PrevExitCode, PrevSignal}` | nil | Lets the harness rebuild caches, re-acquire locks, or re-read disk state lost when the prior subprocess died. |
| `turn_aborted` | Fires on the new instance when the prior subprocess died with a turn in flight | `TurnAbortedInfo{Reason: "extension_died"}` | nil | Signals that some hook lifecycle (turn_start/turn_end pairing, etc.) was interrupted. Reset any per-turn state the harness tracks. |
| `peer_extension_died` | Fires on every other Host in the group when one host dies | `PeerExtensionInfo{Name, ExitCode, Signal}` | nil | Lets surviving extensions degrade gracefully when a sibling becomes unavailable. |
| `peer_extension_respawned` | Fires on every other Host in the group when a sibling host successfully respawns | `PeerExtensionInfo{Name, AttemptNumber}` | nil | Lets surviving extensions re-establish coordination with the recovered sibling. |

### Payload Types

**ExtensionRespawnedInfo**
```go
type ExtensionRespawnedInfo struct {
    AttemptNumber int    // 1, 2, or 3 within the rolling window
    PrevExitCode  *int   // nil if killed by signal or no exit observed
    PrevSignal    string // empty if exited normally
}
```

**TurnAbortedInfo**
```go
type TurnAbortedInfo struct {
    Reason string // currently always "extension_died"
}
```

**PeerExtensionInfo**
```go
type PeerExtensionInfo struct {
    Name          string // sibling extension name
    ExitCode      *int   // populated only on peer_extension_died
    Signal        string // populated only on peer_extension_died
    AttemptNumber int    // populated only on peer_extension_respawned
}
```
