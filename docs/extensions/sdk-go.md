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
sdk.FireSessionCompact(ctx, CompactionInfo{...})
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

**`Emit(event)`** -- emit an engine event to socket clients.

**`GetContextUsage()`** -- returns current context window utilization.

```go
type ContextUsage struct {
    Percent int
    Tokens  int
    Cost    float64
}
```

**`Abort()`** -- abort the current session run.

**`RegisterAgent(name, handle)`** / **`DeregisterAgent(name)`** -- register/deregister agent handles for per-agent abort and steering.

**`ResolveTier(name)`** -- resolve a model tier name to a model ID.

**`RegisterProcess`**, **`DeregisterProcess`**, **`ListProcesses`**, **`TerminateProcess`**, **`CleanStaleProcesses`** -- process lifecycle management (see TypeScript SDK for semantics).

**`DispatchAgent(opts)`** -- dispatch an engine-native child agent.

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
    Name         string `json:"name"`
    Task         string `json:"task"`
    Model        string `json:"model,omitempty"`
    ExtensionDir string `json:"extensionDir,omitempty"`
    SystemPrompt string `json:"systemPrompt,omitempty"`
    ProjectPath  string `json:"projectPath,omitempty"`
}

type DispatchAgentResult struct {
    Output   string  `json:"output"`
    ExitCode int     `json:"exitCode"`
    Elapsed  float64 `json:"elapsed"`
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
