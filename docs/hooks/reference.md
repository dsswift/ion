---
title: Hook Reference
description: Complete reference for all Ion Engine hooks
sidebar_position: 2
---

# Hook Reference

All hooks grouped by category. For each hook: when it fires, what payload it receives, what return values do, and the dispatch pattern.

## Lifecycle

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

## Session Management

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `session_before_compact` | Before context compaction | `CompactionInfo{Strategy, MessagesBefore, MessagesAfter}` | `bool` | Return `true` to cancel compaction. |
| `session_compact` | After compaction completes | `CompactionInfo{Strategy, MessagesBefore, MessagesAfter, Facts}` | ignored | Observe only. `Facts` carries structured snippets extracted from the pre-compaction messages — useful for persisting to external memory before they're discarded. May be empty. |
| `compact_summary_request` | Inside proactive / reactive compaction, after session-memory and LLM tiers and before the regex fallback | `CompactSummaryRequestInfo{Strategy, MessageCount, Messages}` | `CompactSummaryRequestResult{Summary}` or bare `string` | First non-empty `Summary` becomes the new `compact_boundary` block's `Summary` field, short-circuiting the engine's regex fact extractor. Empty/nil return falls through to the regex pipeline. Use this to wire a harness-side summariser (LLM-based, vector-store-backed, domain-specific) that produces higher-quality summaries than the engine's regex pipeline. |
| `session_before_fork` | Before session fork | `ForkInfo{SourceSessionKey, NewSessionKey, ForkMessageIndex}` | `bool` | Return `true` to cancel fork. |
| `session_fork` | After fork completes | `ForkInfo{SourceSessionKey, NewSessionKey, ForkMessageIndex}` | ignored | Observe only |
| `session_before_switch` | Before session switch | `nil` | ignored | Observe only |

### Payload Types

**CompactionInfo**
```go
type CompactionInfo struct {
    Strategy         string           // "auto" (proactive) or "reactive" (prompt_too_long)
    MessagesBefore   int
    MessagesAfter    int
    Facts            []CompactionFact // structured facts extracted from compacted messages; may be empty
    TokensBefore     int              // token count before compaction (proactive only; 0 for reactive)
    TokenLimit       int              // absolute token limit that triggered compaction
    TargetTokens     int              // post-compact target token budget
    MicroCompactKeep int              // number of recent turns protected from micro-compaction
    TokensAfter      int              // token count after compaction
    SessionMemory    string           // session memory content used as summary (empty if not available)
}
```

**CompactionFact**
```go
type CompactionFact struct {
    Type    string // "decision" | "file_mod" | "error" | "preference" | "discovery"
    Content string // short snippet (sentence or path)
}
```

`Facts` is populated on `session_compact` only (not on `session_before_compact`), and may be empty when step-1 micro-compaction alone is sufficient and no fact patterns matched. Message indices are intentionally not exposed — by the time the hook fires, the source messages have been mutated or truncated.

`SessionMemory` contains the background session memory content when it was used as the summary source (tier 1 of the three-tier fallback). Empty when session memory was not available and the summary came from LLM or regex extraction.

**CompactSummaryRequestInfo**
```go
type CompactSummaryRequestInfo struct {
    Strategy     string             // "auto" (proactive) or "reactive" (prompt_too_long retry)
    MessageCount int                // len(Messages); supplied so handlers can log without re-counting
    Messages     []types.LlmMessage // pre-compaction slice, already filtered through MessagesAfterLastCompactBoundary so prior summaries are not in scope
}
```

**CompactSummaryRequestResult**
```go
type CompactSummaryRequestResult struct {
    Summary string // when non-empty, replaces the engine's regex-built summary text; empty means "no opinion — fall back to regex"
}
```

The `compact_summary_request` handler may return a `CompactSummaryRequestResult` value, a `*CompactSummaryRequestResult` pointer, or a bare `string`. All three shapes flow through the same first-non-empty selection. The engine never blocks on this handler; harness implementations that call an LLM must do so with a bounded timeout and surface failures by returning `("", false)` rather than blocking the run. Branch on `Strategy` to tune the summariser to the trigger — e.g. a reactive summary may want to be more aggressive (fewer tokens) because the provider just rejected the prompt, while an auto summary can afford a richer rendering.

**ForkInfo**
```go
type ForkInfo struct {
    SourceSessionKey string
    NewSessionKey    string
    ForkMessageIndex int
}
```

## Pre-Action

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `before_agent_start` | Before a sub-agent launches | `AgentInfo{Name, Task}` | `BeforeAgentStartResult{SystemPrompt, AgentName}` | Last non-empty wins per field independently. Injects system prompt and/or resolves agent name. |
| `before_provider_request` | Immediately before each outbound LLM provider call from the agent loop. Fires once per turn (including fallback hops). | `BeforeProviderRequestInfo{Provider, Model, TurnNumber, MessageCount, ToolCount, HasSystemPrompt, MaxTokens}` | ignored | Observe only |

### Payload Types

**BeforeAgentStartResult**
```go
type BeforeAgentStartResult struct {
    SystemPrompt string `json:"systemPrompt,omitempty"` // injected system prompt; empty = no change
    AgentName    string `json:"agentName,omitempty"`    // override agent name; empty = no change
}
```

**BeforeProviderRequestInfo**
```go
type BeforeProviderRequestInfo struct {
    Provider        string // provider ID (e.g. "anthropic", "openai")
    Model           string // model name post-fallback
    TurnNumber      int    // 1-based, matches turn_start
    MessageCount    int    // number of messages in the request payload
    ToolCount       int    // number of tool definitions attached
    HasSystemPrompt bool   // true when a non-empty system prompt is set
    MaxTokens       int    // configured response cap; 0 = provider default
}
```

## Content

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

## Per-Tool Call

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

## Per-Tool Result

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

## Context Discovery

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

## Permission

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

## File Changes

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `file_changed` | LLM Write or Edit tool wrote a file (does **not** fire on external edits — see `workspace_file_changed`) | `FileChangedInfo{Path, Action}` | ignored | Observe only |
| `workspace_file_changed` | Any non-ignored file or directory under the session working directory was created, modified, or deleted (LLM tools, user editor, shell scripts — anything) | `WorkspaceFileChangedInfo{Path, RelPath, Action}` | ignored | Observe only |

### Payload Types

**FileChangedInfo**
```go
type FileChangedInfo struct {
    Path   string
    Action string
}
```

**WorkspaceFileChangedInfo**
```go
type WorkspaceFileChangedInfo struct {
    Path    string  // absolute, OS-native
    RelPath string  // forward-slash, relative to WorkingDirectory
    Action  string  // "create", "modify", or "delete"
}
```

`workspace_file_changed` is backed by an engine-owned recursive fsnotify watcher rooted at `EngineConfig.WorkingDirectory`. Defaults ignore `.git/**`, `node_modules/**`, `dist/**`, `build/**`, `target/**`, `.next/**`, `.nuxt/**`, `.venv/**`, `__pycache__/**`, `.ion/**`, plus editor noise (`.DS_Store`, `*.swp`, `*.swo`, `*.tmp`, `*~`). Override the whole list via `EngineConfig.WorkspaceWatchIgnore` (non-empty array replaces the defaults; it does not merge).

Out-of-tree paths are not covered. Extensions that need to watch files outside the working directory install their own `node:fs.watch` in their subprocess. Renames are reported as paired delete+create events (cross-editor rename detection is unreliable).

## Task Lifecycle

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `task_created` | Turn starts (every backend) | `TaskLifecycleInfo{TaskID, Name, Status, Extra}` | ignored | Observe only |
| `task_completed` | Turn ends (every backend) | `TaskLifecycleInfo{TaskID, Name, Status, Extra}` | ignored | Observe only |

> **Contract — TaskID format.** `TaskID` is `<session-key>-t<turn-number>` on every engine backend (`ApiBackend`, `CliBackend`, `HybridBackend`). Consumers join `task_created` and `task_completed` on `(SessionKey, TaskID)` and correlate with the adjacent `turn_start` / `turn_end` hooks via `TurnInfo.TurnNumber`. **The format is a public contract.** Changing it requires an ADR documenting the rationale and migration impact, following the precedent of [ADR-003](../architecture/adr/003-state-events-vs-workflow-events.md) for the `engine_plan_mode_changed` trigger removal. Adding new components to the right of `-t<turn-number>` is non-breaking (consumers parse left-anchored); removing or reordering existing components is breaking.

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

## Elicitation

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

## Plan Mode

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `before_plan_mode_enter` | LLM calls `EnterPlanMode` tool requesting mode transition | `PlanModeEnterInfo{Source}` | `*BeforePlanModeEnterResult{Allow, Reason}` | Last non-nil `Allow` across hosts wins. Return `Allow: &false` to deny. Default (nil or no handler): allow. |
| `before_plan_mode_exit` | LLM calls `ExitPlanMode` tool requesting plan review | `BeforePlanModeExitInfo{PlanFilePath, Source}` | `*BeforePlanModeExitResult{Allow, Reason}` | Last non-nil `Allow` wins. Return `Allow: &false` to send the model back for more planning. Default: allow. |
| `before_plan_mode_auto_exit` | Plan-mode run ends with `end_turn` / `stop` but the assistant never invoked `ExitPlanMode` or `AskUserQuestion` (the engine is about to deterministically synthesize the exit — see [ADR-007](../architecture/adr/007-plan-mode-auto-exit.md)) | `BeforePlanModeAutoExitInfo{SessionID, RunID, StopReason, PlanFilePath, AssistantText, EmittedTools}` | `*BeforePlanModeAutoExitResult{Suppress, PlanFilePath, Reason}` | Last writer wins per field across handlers. Return `Suppress: true` to block synthesis (the conversation stays parked in plan mode). Override `PlanFilePath` for stage-then-promote workflows; override `Reason` to localize or rephrase the human-readable string surfaced on the approval card. |
| `plan_mode_prompt` | Plan mode session starts | `string` (plan file path) | `PlanModePromptResult{Prompt, Tools, SparseReminder}` or `string` | Last non-nil wins. Override plan mode prompt, allowed tool list, and/or per-turn sparse reminder text. |

### Payload Types

**PlanModeEnterInfo**
```go
type PlanModeEnterInfo struct {
    Source string // "model_tool" when the LLM called EnterPlanMode
}
```

**BeforePlanModeEnterResult**
```go
type BeforePlanModeEnterResult struct {
    Allow  *bool  // nil = no opinion (allow); &false = deny; &true = explicit allow
    Reason string // returned to the LLM in the tool result when Allow is &false
}
```

**BeforePlanModeExitInfo**
```go
type BeforePlanModeExitInfo struct {
    PlanFilePath string // path of the plan file being submitted for review
    Source       string // "model_tool" when the LLM called ExitPlanMode
}
```

**BeforePlanModeExitResult**
```go
type BeforePlanModeExitResult struct {
    Allow  *bool  // nil = no opinion (allow); &false = deny; &true = explicit allow
    Reason string // returned to the LLM in the tool result when Allow is &false
}
```

Merge semantics: last handler that returns a non-nil `Allow` wins, matching `before_early_stop_decision`. A handler that returns `Allow: nil` (or returns `nil` entirely) abstains.

**BeforePlanModeAutoExitInfo**
```go
type BeforePlanModeAutoExitInfo struct {
    SessionID     string   // engine session ID
    RunID         string   // engine-issued request ID
    StopReason    string   // "end_turn" or "stop" — never another value
    PlanFilePath  string   // resolved plan file path (run, falling back to session)
    AssistantText string   // concatenated text content of the final assistant turn
    EmittedTools  []string // tool names the assistant did emit this turn
}
```

The engine resolves `PlanFilePath` before firing the hook (preferring the run's own value, falling back to the session-level plan file path). The hook never fires when no path is resolvable — synthesizing an exit with no plan to show is worse than parking the conversation. `AssistantText` is capped at 4 KiB to bound the hook subprocess payload; consumers that need the full text should read it from the conversation history.

**BeforePlanModeAutoExitResult**
```go
type BeforePlanModeAutoExitResult struct {
    Suppress     bool   // true = block synthesis entirely
    PlanFilePath string // non-empty = override the path used in the synthesized denial / event
    Reason       string // non-empty = override the human-readable reason string
}
```

Merge semantics: last writer wins per field across handlers. A handler that only sets `PlanFilePath` does not clobber an earlier handler's `Suppress` decision — matching the `BeforePlanModeExit` / `BeforeEarlyStopDecision` precedent. When `Suppress` is true the engine emits neither the synthetic `PermissionDenial` nor `engine_plan_mode_auto_exit`; the run completes as a normal `end_turn` and the conversation stays parked in plan mode.

The hook itself fires only when the synthesis is otherwise about to happen — i.e. the run is in plan mode, the assistant's final turn contains no `ExitPlanMode` or `AskUserQuestion` `tool_use`, a plan file path is resolvable, and `limits.planModeAutoExitOnEndTurn` (or `RunOptions.PlanModeAutoExit`) has not already disabled it. Configurability summary:

| Layer | Field | Default |
|-------|-------|---------|
| engine.json | `limits.planModeAutoExitOnEndTurn` | `true` |
| RunOptions | `planModeAutoExit *bool` | `nil` (inherit) |
| Extension SDK | `before_plan_mode_auto_exit` | no opinion |

See [ADR-007](../architecture/adr/007-plan-mode-auto-exit.md) for the full rationale and the on-by-default decision.

**PlanModePromptResult**
```go
type PlanModePromptResult struct {
    Prompt         string   // custom plan mode prompt; empty = use default
    Tools          []string // custom allowed tools; nil = use default
    SparseReminder string   // custom per-turn sparse reminder; empty = use engine default buildPlanModeSparseReminder
}
```

## System Message Injection

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `system_inject` | Before each engine-injected steering message | `SystemInjectInfo` | `SystemInjectResult` | Override or suppress engine steering messages |

**Precedence:** Per-injection disable flags (`limits.disablePlanModeReminder`, etc.) are checked first. If a flag disables the injection, the hook does **not** fire. If the flag is not set (default), the hook fires and can still suppress or customize.

#### `SystemInjectInfo`

```go
type SystemInjectInfo struct {
    Kind        string `json:"kind"`        // injection type
    DefaultText string `json:"defaultText"` // engine's default message text
    Turn        int    `json:"turn"`        // current turn number
    MaxTurns    int    `json:"maxTurns"`    // configured max turns (0 = unlimited)
}
```

**Kind values:**

| Kind | When injected | Default text pattern |
|------|--------------|---------------------|
| `"plan_mode_reminder"` | Turn 2+ during plan mode | `[SYSTEM] Plan mode still active...` |
| `"turn_limit_warning"` | 2 turns before `maxTurns` | `[SYSTEM] You are approaching your turn limit...` |
| `"max_token_continue"` | LLM response hits `max_tokens` | `Continue from where you left off.` |
| `"early_stop_continue"` | Model emits `end_turn` below the configured token budget | harness-supplied (none by default) — see [ADR-002](../architecture/adr/002-engine-vs-harness-early-stop.md) |

#### `SystemInjectResult`

```go
type SystemInjectResult struct {
    Text     string `json:"text,omitempty"`     // replacement text; empty = use default
    Suppress bool   `json:"suppress,omitempty"` // true = do not inject
}
```

## Early-Stop Continuation

These hooks let harness extensions take **programmatic control** of the early-stop continuation feature. The engine provides the mechanism — cumulative output-token tracking, threshold comparison, the decision hook, and the re-run-turn machinery — but does **not** ship an opinion about whether to nudge or what text to nudge with. Both are policy decisions that belong to the harness consumer. See [ADR-002: Engine vs Harness for Early-Stop Continuation](../architecture/adr/002-engine-vs-harness-early-stop.md) for the full rationale and [`earlyStopContinue` in engine.json](../configuration/engine-json.md#earlystopcontinue) for the configuration block.

The feature ships **off by default**. To enable it, a harness must either flip `earlyStopContinue.enabled = true` in `engine.json`, pass `RunOptions.EarlyStopEnabled = &true` per dispatch, or wire a `before_early_stop_decision` handler that returns `ForceContinue: &true`. The desktop ships [`desktop/src/main/early-stop-policy.ts`](https://github.com/dsswift/ion/blob/main/desktop/src/main/early-stop-policy.ts) as a reference policy implementation — third-party harnesses can copy it verbatim or build their own.

When the model emits `end_turn` / `stop` below the configured output-token target, the engine fires `before_early_stop_decision` so handlers can:

- **Force a specific verdict** (`ForceContinue: &true | &false`) — e.g. "always continue while a `TodoWrite` is in progress" or "stop now because the user already approved the plan."
- **Override the budget mid-run** (`OverrideBudget`) — e.g. "user just expanded scope; bump from 8k to 16k."
- **Override the threshold** (`OverrideThresholdPct`).
- **Supply the continuation prompt** (`ContinueMessage`) — required for any nudge to fire. The engine has no default text; if no handler supplies a message, the engine logs `earlyStop: enabled but no ContinueMessage supplied; skipping injection` and falls through to normal completion.

After the engine has decided to continue (and the message has been injected), `early_stop_continued` fires as an observation point — useful for metrics, UI breadcrumbs, or coordinating sibling agents.

If no extension expressed an opinion via `before_early_stop_decision`, the engine emits a `engine_early_stop_decision_request` event on the wire and blocks briefly (100ms timeout) for a `early_stop_decision_response` client command. This lets socket-only harnesses (the desktop, custom UIs, headless tooling) participate in the decision without running a subprocess extension.

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `before_early_stop_decision` | After model emits `end_turn` / `stop`, before the engine evaluates continuation criteria | `EarlyStopDecisionInfo` | `*EarlyStopDecisionResult` | Per-field last-non-nil-across-hosts wins. See struct docs below. |
| `early_stop_continued` | After a continuation has been injected, before the next turn starts | `EarlyStopContinuedInfo` | ignored | Observe only |

**Execution order during an early-stop event:**

1. `before_early_stop_decision` fires; handlers may override the verdict, budget, threshold, or message.
2. If the (possibly-overridden) verdict is "continue", `system_inject` fires with `kind="early_stop_continue"`; handlers can rewrite or suppress the final text.
3. The user message is appended to the conversation.
4. `early_stop_continued` fires (observe-only) with the final injected text.

If `system_inject` suppresses the message (returns `suppress: true`), the engine **does not** loop — it falls through to `TaskCompleteEvent`. The `early_stop_continued` hook still fires with an empty `InjectedText` so observers can record the suppression.

#### `EarlyStopDecisionInfo`

```go
type EarlyStopDecisionInfo struct {
    RunID                  string // engine-issued request ID
    Model                  string // model that just stopped
    TurnNumber             int    // turn that ended (1-based)
    StopReason             string // "end_turn" or "stop"
    CumulativeOutputTokens int    // total across every turn of this run
    Budget                 int    // effective budget after engine.json + RunOptions
    ThresholdPct           int    // effective completion threshold percent
    ContinuationCount      int    // number of nudges already issued (0 before first)
    MaxContinuations       int    // configured cap
    LastContinuationDelta  int    // output-token delta from the previous continuation
    WouldContinue          bool   // the engine's tentative verdict before this hook
    IsSubagent             bool   // true for runs dispatched by the Agent tool
}
```

#### `EarlyStopDecisionResult`

```go
type EarlyStopDecisionResult struct {
    ForceContinue        *bool  // &true forces continue; &false forces stop; nil defers
    OverrideBudget       int    // bump (or shrink) the effective budget for the remainder of the run; 0 = no override
    OverrideThresholdPct int    // adjust the completion threshold; 0 = no override
    ContinueMessage      string // replace the default continuation prompt text; "" = use default
}
```

Merge semantics across multiple handlers: **last writer wins per field**. A handler that only sets `ContinueMessage` leaves an earlier handler's `ForceContinue` intact. Matches the `before_prompt` resolution pattern.

#### `EarlyStopContinuedInfo`

```go
type EarlyStopContinuedInfo struct {
    RunID                  string // engine-issued request ID
    TurnNumber             int    // turn that just ended
    ContinuationCount      int    // new count after this nudge (1-based)
    Pct                    int    // percent of budget the model reached
    CumulativeOutputTokens int    // running total across the run
    Budget                 int    // effective budget at injection time (after any OverrideBudget)
    InjectedText           string // final continuation text (after OnSystemInject rewrites); empty when suppressed
}
```

#### Worked examples

**Force-continue while a Todo is in progress:**

```go
sdk.On(extension.HookBeforeEarlyStopDecision, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
    info := payload.(extension.EarlyStopDecisionInfo)
    if hasInProgressTodo(ctx) {
        cont := true
        return extension.EarlyStopDecisionResult{ForceContinue: &cont}, nil
    }
    return nil, nil // defer to engine default
})
```

**Bump the budget when the user expands scope mid-conversation:**

```go
sdk.On(extension.HookBeforeEarlyStopDecision, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
    info := payload.(extension.EarlyStopDecisionInfo)
    if userExpandedScope(ctx) && info.Budget < 16000 {
        return extension.EarlyStopDecisionResult{OverrideBudget: 16000}, nil
    }
    return nil, nil
})
```

**Supply a domain-specific continuation prompt:**

```go
sdk.On(extension.HookBeforeEarlyStopDecision, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
    return extension.EarlyStopDecisionResult{
        ContinueMessage: "Continue. Focus on the test plan in plan.md before generating new code.",
    }, nil
})
```

## Context Injection

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

## Capability Framework

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

## Extension Lifecycle

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

## Cross-Session

| Hook | When | Payload | Return | Effect |
|------|------|---------|--------|--------|
| `session_message` | Another session of the same extension type sends a message via `ctx.sessions.send()` | `SessionMessageInfo{SenderSessionKey, Kind, Payload}` | ignored | Observe only. The target extension can react by emitting events, injecting context, or ignoring the message. |

### Payload Types

**SessionMessageInfo**

| Field | Type | Description |
|-------|------|-------------|
| `senderSessionKey` | `string` | Session key of the sender |
| `kind` | `string` | Application-defined message kind |
| `payload` | `map[string]interface{}` | Arbitrary structured data |

Same extension type only. The engine enforces this by comparing extension names; cross-type messaging returns an error to the sender.
