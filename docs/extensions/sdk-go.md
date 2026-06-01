---
title: Go SDK Reference
description: Full API reference for the Ion Engine Go extension SDK.
sidebar_position: 8
---

# Go SDK Reference

The Go SDK (`engine/internal/extension`) is the native extension system used by the engine itself. In-process extensions register hooks, tools, commands, and capabilities directly on the SDK. Subprocess extensions communicate via JSON-RPC and have their calls forwarded through the same SDK.

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
    Cwd    string
    Model  *ModelRef
    Config *ExtensionConfig

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

**`Elicit(info)`** -- ask the user a structured question via the connected client. Blocks the calling hook until the client replies or times out. The wire protocol promotes this to `engine_elicitation_request` / `elicitation_response` so socket-only consumers can present the prompt.

**`SuppressTool(name)`** -- hide a built-in tool from the model on the current turn. Use sparingly.

**`CallTool(name, input)`** -- dispatch a tool call from extension code through the same registry the LLM uses. Returns `(content, isError, error)`. Subject to the session's permission policy. Does **not** fire per-tool hooks or `permission_request` (prevents re-entrant recursion into the calling extension).

**`SendPrompt(text, model)`** -- queue a fresh prompt on this session's agent loop. Resolves once the engine has accepted the prompt; does not wait for the LLM to finish. Pass `model=""` to use the session default.

**Recursion hazard**: calling `SendPrompt` from inside `before_prompt` or any pre-prompt hook triggers a new run that fires the same hook again. Guard with a per-session in-flight flag.

**`Abort()`** -- abort the current session run.

**`RegisterAgent(name, handle)`** / **`DeregisterAgent(name)`** -- register/deregister agent handles for per-agent abort and steering.

**`ResolveTier(name)`** -- resolve a model tier name to a model ID.

**`RegisterProcess`**, **`DeregisterProcess`**, **`ListProcesses`**, **`TerminateProcess`**, **`CleanStaleProcesses`** -- process lifecycle management (see TypeScript SDK for semantics).

**`DispatchAgent(opts)`** -- dispatch an engine-native child agent.

**`DiscoverAgents(opts)`** -- list agents discoverable via the harness's configured search paths (extension agents, project agents, user agents). Returns a structured result the harness can filter and register via `RegisterAgent`.

## Type definitions

### HookHandler

```go
type HookHandler func(ctx *Context, payload interface{}) (interface{}, error)
```

Return `nil, nil` for void hooks. Return a typed result for hooks that expect one. Return `nil, error` to log an error without affecting the hook chain.

### ToolDefinition

```go
type ToolDefinition struct {
    Name        string
    Description string
    Parameters  map[string]interface{}
    Execute     func(params interface{}, ctx *Context) (*types.ToolResult, error)
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

```go
type DispatchAgentOpts struct {
    Name          string   `json:"name"`
    Task          string   `json:"task"`
    Model         string   `json:"model,omitempty"`
    ExtensionDir  string   `json:"extensionDir,omitempty"`
    SystemPrompt  string   `json:"systemPrompt,omitempty"`
    ProjectPath   string   `json:"projectPath,omitempty"`
    SessionID     string   `json:"sessionId,omitempty"`
    MaxTurns      int      `json:"maxTurns,omitempty"`      // cap child loop turns; <=0 means unlimited
    PlanMode      bool     `json:"planMode,omitempty"`      // start child in plan mode
    PlanFilePath  string   `json:"planFilePath,omitempty"`  // override plan file path
    PlanModeTools []string `json:"planModeTools,omitempty"` // override allowed tools during plan mode
}

type DispatchAgentResult struct {
    Output       string  `json:"output"`
    ExitCode     int     `json:"exitCode"`
    Elapsed      float64 `json:"elapsed"`
    PlanFilePath string  `json:"planFilePath,omitempty"` // plan file written by child
    PlanExited   bool    `json:"planExited,omitempty"`   // true when child called ExitPlanMode
}
```

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
