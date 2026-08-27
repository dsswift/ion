---
title: Engine-Internal Extension SDK (Go, in-process)
description: Reference for engine/internal/extension, the engine's own in-process extension registry.
sidebar_position: 12
---

# Engine-Internal Extension SDK (Go, in-process)

:::note Looking to write a Go extension?

This page documents `engine/internal/extension`, the registry **inside** the engine. It is not importable from outside the engine module (Go's `internal/` rule) and it is not what you build an extension against.

To write an extension in Go, see **[Go SDK](sdk-go.md)** — the public module at `github.com/dsswift/ion/sdk/go`.

:::

The engine-internal SDK is the native extension system the engine uses for itself. In-process extensions register hooks, tools, commands, and capabilities directly on it. Subprocess extensions — including every one built with the public Go SDK or the TypeScript SDK — communicate over JSON-RPC, and the host forwards their calls through this same registry.

The engine and extension SDK deploy independently. During init, the SDK reports its build identity for provenance and diagnostics; a different identity is logged but never blocks extension loading. Compatibility is resolved at the surface actually used: unsupported extension-to-engine JSON-RPC methods return standard `-32601` (`method not found`), and SDK consumers can degrade or report that specific unavailable capability. Extensions therefore do not need rebuilding merely because the engine or desktop was updated.

## SDK

The central registry for hooks, tools, commands, and capabilities.

```go
import "github.com/dsswift/ion/engine/internal/extension"

sdk := extension.NewSDK()
```

### Registration methods

**`On(event string, handler HookHandler)`** -- register a handler for a hook event. Multiple handlers per event are supported; they run in registration order.

```go
sdk.On("session_start", func(ctx *extension.Context, payload interface{}) (interface{}, error) {
    utils.Log("ext", "session started")
    return nil, nil
})
```

**`PrependHook(event string, handler HookHandler)`** -- insert a handler at the front of the hook chain. Used for enterprise-required hooks that must run before extension handlers.

```go
sdk.PrependHook("tool_call", func(ctx *extension.Context, payload interface{}) (interface{}, error) {
    // Runs before any extension-registered tool_call handlers
    return nil, nil
})
```

**`RegisterTool(def ToolDefinition)`** -- register a tool.

```go
sdk.RegisterTool(extension.ToolDefinition{
    Name:        "my_tool",
    Description: "Does something",
    Parameters:  map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
    Execute: func(params interface{}, ctx *extension.Context) (*types.ToolResult, error) {
        return &types.ToolResult{Content: "result"}, nil
    },
})
```

**`RegisterCommand(name string, def CommandDefinition)`** -- register a slash command.

```go
sdk.RegisterCommand("status", extension.CommandDefinition{
    Description: "Show status",
    Execute: func(args string, ctx *extension.Context) error {
        ctx.Emit(types.EngineEvent{Type: "engine_notify", EventMessage: "OK", Level: "info"})
        return nil
    },
})
```

**`RegisterCapability(cap Capability)`** -- register a capability.

```go
sdk.RegisterCapability(extension.Capability{
    ID:          "code-review",
    Name:        "Code Review",
    Description: "Automated code review with style checks",
    Mode:        extension.CapabilityModeTool | extension.CapabilityModePrompt,
    InputSchema: map[string]interface{}{
        "type": "object",
        "properties": map[string]interface{}{
            "files": map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}},
        },
    },
    Execute: func(ctx *extension.Context, input map[string]interface{}) (*types.ToolResult, error) {
        return &types.ToolResult{Content: "Review complete"}, nil
    },
    Prompt: "When reviewing code, check for style violations.",
})
```

### Query methods

**`Tools() []ToolDefinition`** -- returns all registered tools.

**`Commands() map[string]CommandDefinition`** -- returns all registered commands.

**`Handlers(event string) []HookHandler`** -- returns a snapshot of handlers for a hook event.

**`Capabilities() []Capability`** -- returns all registered capabilities.

**`CapabilitiesByMode(mode CapabilityMode) []Capability`** -- returns capabilities matching a mode flag.

### Fire methods

The SDK provides typed `Fire*` methods for each hook. These iterate handlers, log errors, and merge results. The session manager calls these; extension code typically does not.

**Lifecycle hooks:**

```go
sdk.FireSessionStart(ctx)
sdk.FireSessionEnd(ctx)
sdk.FireBeforePrompt(ctx, prompt) // returns (rewrittenPrompt, systemPromptAddition, error)
sdk.FireTurnStart(ctx, TurnInfo{TurnNumber: 1})
sdk.FireTurnEnd(ctx, TurnInfo{TurnNumber: 1})
sdk.FireMessageStart(ctx)
sdk.FireMessageEnd(ctx)
sdk.FireToolStart(ctx, ToolStartInfo{ToolName: "Bash", ToolID: "abc"})
sdk.FireToolEnd(ctx)
sdk.FireToolCall(ctx, ToolCallInfo{...}) // returns (*ToolCallResult, error)
sdk.FireOnError(ctx, ErrorInfo{...})
sdk.FireAgentStart(ctx, AgentInfo{Name: "worker", Task: "test"})
sdk.FireAgentEnd(ctx, AgentInfo{Name: "worker", Task: "test"})
```

**Session management hooks:**

```go
sdk.FireSessionBeforeCompact(ctx, CompactionInfo{...}) // returns (cancelled bool, error)

// session_compact fires after compaction completes. CompactionInfo carries
// token-level metrics (TokensBefore, TokenLimit, TargetTokens, TokensAfter),
// the MicroCompactKeep setting, and structured Facts the engine extracted
// from the pre-compaction message set ({Type, Content} pairs). Extensions
// maintaining external memory (vector store, knowledge graph, SQLite) can
// persist these durably before the source messages are discarded. Facts may
// be empty when no patterns matched.
sdk.FireSessionCompact(ctx, CompactionInfo{
    Strategy:         "auto",
    MessagesBefore:   50,
    MessagesAfter:    10,
    TokensBefore:     180000,
    TokenLimit:       100000,
    TargetTokens:     100000,
    MicroCompactKeep: 3,
    TokensAfter:      95000,
    Facts: []CompactionFact{
        {Type: "decision", Content: "decided to use SQLite"},
        {Type: "file_mod", Content: "/Users/foo/project/main.go"},
    },
})

// compact_summary_request fires inside proactive (auto) and reactive
// (prompt_too_long) compaction, after the session-memory and LLM tiers
// and before the regex fallback. Substitute a harness-side summariser
// for the engine's regex fact extractor by registering a handler that
// returns a non-empty string; an empty return falls through to the
// regex path. Branch on Strategy ("auto" | "reactive") to tune the
// summariser to the trigger — reactive summaries should be aggressive
// (fewer tokens) because the provider just rejected the prompt; auto
// summaries can afford a richer rendering. The engine never blocks on
// the handler; wrap LLM calls in a bounded timeout and return ("",
// false) on failure rather than blocking the run.
summary, ok := sdk.FireCompactSummaryRequest(ctx, CompactSummaryRequestInfo{
    Strategy:     "auto",
    MessageCount: len(messages),
    Messages:     messages,
}) // returns (summary string, ok bool); ok=false means "fall back to regex"

sdk.FireSessionBeforeFork(ctx, ForkInfo{...})           // returns (cancelled bool, error)
sdk.FireSessionFork(ctx, ForkInfo{...})
sdk.FireSessionBeforeSwitch(ctx)
```

**Content hooks:**

```go
sdk.FireInput(ctx, prompt)                // returns (modifiedPrompt, error)
sdk.FireModelSelect(ctx, ModelSelectInfo{...}) // returns (modelID, error)
sdk.FireContextInject(ctx, ContextInjectInfo{...}) // returns []ContextEntry
sdk.FirePlanModePrompt(ctx, planFilePath)  // returns (customPrompt, customTools)
```

**Per-tool hooks:**

```go
sdk.FirePerToolCall(ctx, "bash", input)    // returns (*PerToolCallResult, error)
sdk.FirePerToolResult(ctx, "bash", result) // returns (modifiedContent, error)
```

**Context discovery hooks:**

```go
sdk.FireContextDiscover(ctx, ContextDiscoverInfo{...}) // returns (reject bool, error)
sdk.FireContextLoad(ctx, ContextLoadInfo{...})         // returns (content, reject, error)
sdk.FireInstructionLoad(ctx, ContextLoadInfo{...})     // returns (content, reject, error)
```

**Capability hooks:**

```go
sdk.FireCapabilityDiscover(ctx)                        // returns []Capability
sdk.FireCapabilityMatch(ctx, CapabilityMatchInfo{...}) // returns *CapabilityMatchResult
sdk.FireCapabilityInvoke(ctx, capID, input)            // returns (blocked, reason)
```

**Plan-mode hooks:**

```go
// Fired when the model calls the EnterPlanMode sentinel tool. Handlers may
// veto the entry by returning Allow=&false with a Reason returned to the
// model. Default is auto-approve. Last non-nil Allow wins.
sdk.FireBeforePlanModeEnter(ctx, PlanModeEnterInfo{Source: "model_tool"})
// returns (allowed bool, reason string)

// Fired when the model calls the ExitPlanMode sentinel tool. Handlers may
// veto the exit by returning Allow=&false with a Reason returned to the
// model (e.g. "plan is too short, add verification steps"). Default is
// auto-approve. Last non-nil Allow wins.
sdk.FireBeforePlanModeExit(ctx, planFilePath)
// returns (allowed bool, reason string)
```

See [ADR-003](../architecture/adr/003-state-events-vs-workflow-events.md) for the
distinction between the plan-mode *state* event (`engine_plan_mode_changed`,
fires only on confirmed transitions) and the *workflow* event
(`engine_plan_proposal`, fires when the model proposes an exit).

**Early-stop continuation hooks:**

```go
// Fired after the model emits end_turn / stop, when the engine has
// detected the run is below the configured token budget and is
// considering whether to nudge the model to keep working. Per-field
// last-non-nil-across-hosts wins. Returning ContinueMessage="" lets the
// engine fall through to the wire-protocol round trip (see below).
sdk.FireBeforeEarlyStopDecision(ctx, EarlyStopDecisionInfo{
    RunID:                  "...",
    Model:                  "...",
    TurnNumber:             1,
    CumulativeOutputTokens: 7200,
    Budget:                 8000,
    ThresholdPct:           90,
    WouldContinue:          true,
})
// returns *EarlyStopDecisionResult (or nil for "no opinion")

// Fired after a continuation has been injected, before the next turn
// starts. Observe-only — return value ignored. Useful for metrics, UI
// breadcrumbs, or coordinating sibling agents.
sdk.FireEarlyStopContinued(ctx, EarlyStopContinuedInfo{
    RunID:        "...",
    InjectedText: "Keep working — do not summarize.",
})
```

If no extension responds with a decisive `ForceContinue` or `ContinueMessage`,
the engine emits `engine_early_stop_decision_request` on the wire and blocks
briefly for a `early_stop_decision_response` from a socket-only harness. See
[ADR-002](../architecture/adr/002-engine-vs-harness-early-stop.md).

**System inject hooks:**

```go
// Fired before the engine injects a system message (plan_mode_reminder,
// turn_limit_warning, max_token_continue, early_stop_continue). Handlers
// can rewrite the text or suppress the injection entirely.
sdk.FireSystemInject(ctx, SystemInjectInfo{
    Kind: "early_stop_continue",
    DefaultText: "...",
    // Hook-specific fields per Kind
})
// returns *SystemInjectResult (Text replaces, Suppress=true cancels)
```

## Context

The execution context passed to all hook handlers, tool execute functions, and command execute functions.

```go
type Context struct {
    SessionKey     string
    ConversationID string
    RunID          string
    TraceID        string
    Depth          int
    DispatchId     string
    Cwd            string
    Model          *ModelRef
    Config         *ExtensionConfig

    Emit            func(event types.EngineEvent)
    GetContextUsage func() *ContextUsage
    Abort           func()
    RegisterAgent   func(name string, handle types.AgentHandle)
    DeregisterAgent func(name string)
    ResolveTier     func(name string) string

    RegisterProcess     func(name string, pid int, task string) error
    DeregisterProcess   func(name string)
    ListProcesses       func() []ProcessInfo
    TerminateProcess    func(name string) error
    CleanStaleProcesses func() int

    DispatchAgent func(opts DispatchAgentOpts) (*DispatchAgentResult, error)
}
```

### Context fields

**`Cwd`** -- working directory for the session.

**`SessionKey`** -- engine session identity for this invocation. `ConversationID` is its durable conversation identity.

**`RunID`** -- engine-native prompt-to-completion run identity. **`TraceID`** is the W3C trace-context identity for that same run. Both are empty when no run is active.

**`Depth`** and **`DispatchId`** -- dispatched-session identity. Root sessions carry zero depth and an empty dispatch ID.

**`Model`** -- active model reference. Nil if not yet resolved.

```go
type ModelRef struct {
    ID            string
    ContextWindow int
}
```

**`Config`** -- extension configuration.

```go
type ExtensionConfig struct {
    ExtensionDir     string                 `json:"extensionDir"`
    Model            string                 `json:"model,omitempty"`
    WorkingDirectory string                 `json:"workingDirectory"`
    McpConfigPath    string                 `json:"mcpConfigPath,omitempty"`
    Options          map[string]interface{} `json:"options,omitempty"`
}
```

### Context methods

**`Emit(event)`** -- emit an engine event to socket clients. During hook execution events are buffered and returned with the hook response; outside hooks they fire immediately as `ext/emit` notifications.

**`GetContextUsage()`** -- returns current context window utilization for the active conversation, or `nil` when no conversation is active. Reads live counters maintained by the session manager — repeated calls within a single hook are cheap.

```go
type ContextUsage struct {
    Percent int
    Tokens  int
    Cost    float64
}
```

Useful for: warning the user before compaction kicks in; downgrading model selection under heavy context pressure.

**`SearchHistory(query, maxResults)`** -- search the active conversation's persisted message history for content matching `query`. Returns up to `maxResults` matches (engine-capped; pass `0` for the default). Returns an empty slice when no conversation is active.

```go
type HistoryMatch struct {
    Index   int
    Role    string
    Snippet string
}
```

Searches the full persisted record (including pre-compaction messages), not just the currently-loaded context. Useful for recall commands and harness-side memory features.

**`GetSessionMemory()`** -- returns the current session memory content. Empty string when not active.

**`SetSessionMemory(content)`** -- replaces the session memory with custom content and persists it to disk.

**`SetPlanMode(enabled, source)`** -- imperatively flip the session's plan mode on or off. `source` is a free-form audit string (`"slash_command"`, `"hook"`, `"user_approval"`, etc.) that is logged with the transition. Fires `engine_plan_mode_changed` as a state event — this is a confirmed transition, not a proposal. See [ADR-003](../architecture/adr/003-state-events-vs-workflow-events.md) for the state-vs-workflow distinction.

**`GetPlanMode()`** -- returns the current plan-mode state and (if active) the path to the plan file. Reads the session manager's authoritative state, not any cached value.

```go
enabled, planFilePath := ctx.GetPlanMode()
```

**`SetRunRecovery(config)`** -- apply extension-owned durable recovery policy to later runs in this session. `config.Enabled` is required. A non-nil session override wins over `start_session` and `engine.json`; it does not modify an active run's existing journal. `MaxAttempts == 0` uses engine default.

```go
enabled := true
ctx.SetRunRecovery(&types.RunRecoveryConfig{Enabled: &enabled, MaxAttempts: 3})
```

**`Elicit(info)`** -- ask the user a structured question via the connected client. Blocks the calling hook until the client replies or times out. The wire protocol promotes this to `engine_elicitation_request` / `elicitation_response` so socket-only consumers can present the prompt.

**`SuppressTool(name)`** -- hide a built-in tool from the model on the current turn. Use sparingly.

**`CallTool(name, input)`** -- dispatch a tool call from extension code through same registry LLM uses. Returns `(*types.ToolResult, error)`. `Content` and `IsError` retain text-only behavior; optional `ContentItems` preserves ordered MCP text, image, audio, resource-link, embedded-resource, and future content items. Embedded blob data remains base64 for an explicit consumer to decode. The engine feeds supported MCP images to current provider call in memory only, never logs, emits, or persists blob bytes by default. Subject to session permission policy. Does **not** fire per-tool hooks or `permission_request` (prevents re-entrant recursion into calling extension).

**`SendPrompt(text, model)`** -- queue a fresh prompt on this session's agent loop. Resolves once the engine has accepted the prompt; does not wait for the LLM to finish. Pass `model=""` to use the session default.

**Recursion hazard**: calling `SendPrompt` from inside `before_prompt` or any pre-prompt hook triggers a new run that fires the same hook again. Guard with a per-session in-flight flag.

**`Abort()`** -- abort the current session run.

**`RegisterAgent(name, handle)`** / **`DeregisterAgent(name)`** -- register/deregister agent handles for per-agent abort and steering.

**`ResolveTier(name)`** -- resolve a model tier name to a model ID.

**`RegisterProcess`**, **`DeregisterProcess`**, **`ListProcesses`**, **`TerminateProcess`**, **`CleanStaleProcesses`** -- process lifecycle management (see TypeScript SDK for semantics).

**`Suspend()`** / **`SuspendUntilAll(dispatchIDs)`** -- end the current LLM run without completing it, then revive later. Inside a dispatched run (depth >= 1) the dispatch stays alive and idle until a revive message arrives; at depth 0 it parks the ROOT session on its outstanding background bash commands, and a new run starts when one completes. Errors at depth 0 when there is no active run to park or no outstanding notifying commands to park on. Same semantics as the TypeScript SDK — see [sdk-typescript.md](sdk-typescript.md) § `suspend()` and [ADR-023](../architecture/adr/023-root-session-park-and-wake.md).

**`DispatchAgent(opts)`** -- dispatch an engine-native child agent.

**`DiscoverAgents(opts)`** -- list agents discoverable via the harness's configured search paths (extension agents, project agents, user agents). Returns a structured result the harness can filter and register via `RegisterAgent`.

## Workspace Context

Clients supply workspace context on `ClientCommand` (per-prompt) or on `EngineConfig` (session-wide default) via the `ClientWorkspaceContext` field. The engine routes it to extensions through:

- **`system_inject`** with `Kind: "workspace_context"` -- the `Workspace` field carries a `workspaces.PromptContext`. Return replacement text or `Suppress: true`.
- **`context_inject`** -- the `Workspace` field on `ContextInjectInfo` carries the same `PromptContext`.

### ClientWorkspaceContext

```go
type ClientWorkspaceContext struct {
    Kind  string         `json:"kind"`
    Cwd   string         `json:"cwd"`
    Bench map[string]any `json:"bench,omitempty"`
    Data  map[string]any `json:"data,omitempty"`
    Text  string         `json:"text,omitempty"`
}
```

### PromptContext (hook payload)

```go
type PromptContext struct {
    Kind     ContextKind      `json:"kind"`
    Cwd      string           `json:"cwd"`
    Worktree *WorktreeContext  `json:"worktree,omitempty"`
    Bench    map[string]any   `json:"bench,omitempty"`  // from ClientWorkspaceContext.Bench
    Client   map[string]any   `json:"client,omitempty"` // from ClientWorkspaceContext.Data
}
```

See [client-commands.md](../protocol/client-commands.md) for the wire shape and [engine.json](../configuration/engine-json.md) § `promptContext` for session-wide defaults.

## Type definitions

### HookHandler

```go
type HookHandler func(ctx *Context, payload interface{}) (interface{}, error)
```

Return `nil, nil` for void hooks. Return a typed result for hooks that expect one. Return `nil, error` to log an error without affecting the hook chain.

### ToolDefinition

```go
type ToolDefinition struct {
    Name         string
    Description  string
    Parameters   map[string]interface{}
    PlanModeSafe bool
    Execute      func(params interface{}, ctx *Context) (*types.ToolResult, error)
}
```

### CommandDefinition

```go
type CommandDefinition struct {
    Description string
    Execute     func(args string, ctx *Context) error
}
```

### ToolResult (from types package)

```go
type ToolResult struct {
    Content string `json:"content"`
    IsError bool   `json:"isError,omitempty"`
}
```

### DispatchAgentOpts / DispatchAgentResult

Abridged to the serialised fields most callers set and read; see
`engine/internal/extension/sdk_types_dispatch.go` for the full structs,
including the lifecycle callback fields (all `json:"-"`).

```go
type DispatchAgentOpts struct {
    Name             string         `json:"name"`
    Task             string         `json:"task"`
    Model            string         `json:"model,omitempty"`
    ExtensionDir     string         `json:"extensionDir,omitempty"`
    SystemPrompt     string         `json:"systemPrompt,omitempty"`
    ProjectPath      string         `json:"projectPath,omitempty"`
    SessionID        string         `json:"sessionId,omitempty"`
    MaxTurns         int            `json:"maxTurns,omitempty"`         // cap child loop turns; <=0 means unlimited
    MaxDispatchDepth int            `json:"maxDispatchDepth,omitempty"` // override the depth cap for this tree
    PlanMode         bool           `json:"planMode,omitempty"`         // start child in plan mode
    PlanFilePath     string         `json:"planFilePath,omitempty"`     // override plan file path
    PlanModeTools    []string       `json:"planModeTools,omitempty"`    // override allowed tools during plan mode
    RequireToolUse   *bool          `json:"requireToolUse,omitempty"`   // tri-state work expectation (see below)
    ContextPolicy    *ContextPolicy `json:"contextPolicy,omitempty"`    // per-dispatch context-layer override
}

type DispatchAgentResult struct {
    Name         string  `json:"name"`
    Output       string  `json:"output"`
    ExitCode     int     `json:"exitCode"` // 0 success, 2 recalled, 3 declined
    Elapsed      float64 `json:"elapsed"`
    Cost         float64 `json:"cost"`
    InputTokens  int     `json:"inputTokens"`
    OutputTokens int     `json:"outputTokens"`
    ToolCount    int     `json:"toolCount"`              // no omitempty: zero is the value that matters
    PlanFilePath string  `json:"planFilePath,omitempty"` // plan file written by child
    PlanExited   bool    `json:"planExited,omitempty"`   // true when child called ExitPlanMode
}
```

**`RequireToolUse` is the work gate.** `nil` declares no expectation, so the
engine reports `ToolCount` and judges nothing — the zero value, which keeps
every existing caller unchanged. `&true` means a zero-tool completion is not
success: the engine gives the child one continuation naming the expectation,
and if the retry also calls no tools the dispatch reports `ExitCodeDeclined`
(3) with delivered status `declined`. `&false` is an explicit exemption for
analysis and advisory dispatches. The engine never infers the expectation from
task text — a summarization dispatch and an edit dispatch are
indistinguishable to it, and only the caller knows which it issued.

**`ToolCount` carries no `omitempty`.** A zero is the single most important
value the field reports (the signature of a child that answered instead of
working), so it must survive serialization rather than vanishing.

## Capability

```go
type CapabilityMode int

const (
    CapabilityModeTool   CapabilityMode = 1 << iota // surface as LLM tool
    CapabilityModePrompt                            // inject into system prompt
)

type Capability struct {
    ID          string
    Name        string
    Description string
    Metadata    map[string]interface{}
    Mode        CapabilityMode
    InputSchema map[string]interface{}
    Execute     func(ctx *Context, input map[string]interface{}) (*types.ToolResult, error)
    Prompt      string
}
```

Capabilities can operate in tool mode, prompt mode, or both (using bitwise OR):

- **CapabilityModeTool** -- the engine creates an LLM tool from `InputSchema` and `Execute`
- **CapabilityModePrompt** -- the engine injects `Prompt` into the system prompt
- **Both** -- `CapabilityModeTool | CapabilityModePrompt`

## Host

The `Host` manages subprocess extension lifecycle. Most extension authors don't interact with it directly, but it's useful to understand for debugging.

```go
host := extension.NewHost()

// Load a subprocess extension
err := host.Load("/path/to/extension", &extension.ExtensionConfig{...})

// Access the underlying SDK
sdk := host.SDK()

// Shutdown
host.Dispose()
```

The Host:

1. Resolves the entry point (binary, TypeScript, or JavaScript)
2. Transpiles TypeScript if needed
3. Spawns the subprocess
4. Sends the init handshake
5. Registers hook forwarders on the SDK
6. Routes tool and command calls to the subprocess
7. Handles extension-initiated notifications and requests
8. Kills the subprocess on Dispose

## Resources, Notifications, and Cross-Session Messaging

The Go SDK context exposes methods for the resource subsystem, push notifications, and cross-session communication.

**Resource subsystem:**

- **`ctx.Resources.Declare(kind string)`** -- declare a resource collection. Multiple extension hosts can declare one kind. The engine stamps each delivered item with the host identity as `Producer`; an item identity is `(kind, producer, id)`.
- **`ctx.Resources.OnQuery(kind string, handler func(filter ResourceFilter) ([]ResourceItem, error))`** -- register a query handler called when a client subscribes. The filter can select one producer or item.

**Notifications:**

- **`ctx.Notify(opts NotifyOpts)`** -- emit a push notification through the engine/relay pipeline. `NotifyOpts` carries `Kind`, `ResourceID`, `Title`, `Body`, `Sound`, `Scope`, `ConversationID`, and `TargetSessionKey`. The `Push`, `PushTitle`, and `PushBody` fields on the resulting `engine_notification` event trigger APNs delivery when the relay is connected.

**Cross-session messaging:**

- **`ctx.Sessions.List()`** -- returns `[]SessionListEntry` with `Key`, `HasActiveRun`, `ExtensionName`, `ConversationID`. Only sessions running the same extension type are returned.
- **`ctx.Sessions.Send(targetKey, kind string, payload map[string]interface{})`** -- send a structured message to another session. The engine enforces same extension type; cross-type sends return an error. The receiving session's `session_message` hook fires with `SessionMessageInfo{SenderSessionKey, Kind, Payload}`.

**Intercept:**

- **`ctx.Intercept(opts InterceptOpts)`** -- emit an `engine_intercept` event on a target session's stream. `InterceptOpts` carries `Level` (`"banner"` or `"redirect"`), `Title` (required), `Message`, `TargetSessionKey` (optional, defaults to caller's session), and `Metadata` (opaque map). The engine stamps `Source` from the extension name; extensions cannot override it.

**Cross-instance dedup:**

- **`ctx.RunOnceCheck(operationID string, debounceMs int64) (execute bool, reason string)`** -- check whether this instance should execute the named operation. Returns `execute=true` when this instance wins the dedup check. `reason` is one of `"in_progress"`, `"debounced"`, or `"already_ran"` when `execute=false`.
- **`ctx.RunOnceComplete(operationID string, failed bool)`** -- record the outcome. When `failed=true`, the lock is released without updating the last-run timestamp so the next instance can retry immediately.
