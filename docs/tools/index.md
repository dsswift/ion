---
title: Tool System
description: How the Ion Engine registers, dispatches, and executes tools.
sidebar_position: 1
---

# Tool System

The engine provides 14 core tools and 4 optional tools. Tools are the primary way the LLM interacts with the filesystem, network, and external systems.

## Architecture

Tools are defined by the `ToolDef` struct and stored in a global registry. The LLM sends `tool_use` blocks in its response; the engine resolves each tool by name and executes it.

```go
type ToolDef struct {
    Name        string
    Description string
    InputSchema map[string]any
    Execute     func(ctx context.Context, input map[string]any, cwd string) (*ToolResult, error)
}

type ToolResult struct {
    Content string
    IsError bool
}
```

Each tool receives:

- `ctx`: Go context for cancellation and deadline propagation.
- `input`: Parsed JSON input from the LLM, validated against `InputSchema`.
- `cwd`: Working directory for the current session.

Each tool returns a `ToolResult` with string content and an error flag. The content is sent back to the LLM as the tool response.

## Registration

Core tools register at init time via `registerBuiltinTools()`. Extensions can register additional tools through the SDK:

```go
sdk.RegisterTool(ToolDefinition{
    Name:        "MyTool",
    Description: "Does something useful",
    Parameters:  map[string]interface{}{...}, // JSON Schema
    Execute:     func(params interface{}, ctx *Context) (*ToolResult, error) { ... },
})
```

The registry supports dynamic add/remove:

- `RegisterTool(t)` -- add or replace a tool
- `UnregisterTool(name)` -- remove a tool
- `GetTool(name)` -- look up by name
- `GetAllTools()` -- list all registered tools
- `GetToolDefs()` -- export as LLM API format (`LlmToolDef`)

## Parallel Execution

When the LLM returns multiple `tool_use` blocks in a single message, the engine executes them in parallel using `errgroup.Group`. Each tool runs in its own goroutine. Results are collected and sent back as a batch.

This is equivalent to `Promise.allSettled` in the TypeScript engine. Individual tool failures do not cancel sibling executions.

## Tool Lifecycle Hooks

The engine fires hooks at each stage of tool execution:

1. **`tool_call`** -- Before dispatch. Extensions can block the call entirely by returning `Block: true`.
2. **`{toolName}_tool_call`** -- Per-tool pre-hook. Extensions can block or mutate the input.
3. **`tool_start`** -- After dispatch decision, before execution. Observational.
4. *(tool executes)*
5. **`tool_end`** -- After execution completes. Observational.
6. **`{toolName}_tool_result`** -- Per-tool post-hook. Extensions can modify the result string.
7. **`tool_result`** -- After result processing. Observational.

## Tool Categories

### Core Tools (14)

Always registered. Available in every session.

| Tool | Purpose |
|------|---------|
| Read | Read file content with line numbers |
| Write | Write content to files |
| Edit | Find-and-replace in files |
| Bash | Execute shell commands |
| Grep | Search file contents (ripgrep) |
| Glob | Find files by pattern |
| Agent | Spawn sub-agent sessions |
| WebFetch | Fetch content from URLs |
| WebSearch | Search the web |
| NotebookEdit | Read/edit/run Jupyter notebooks |
| LSP | Language server operations |
| Skill | Invoke loaded skills |
| ListMcpResources | List MCP server resources |
| ReadMcpResource | Read MCP server resources |

### Optional Tools (4)

Require explicit opt-in via `RegisterTaskTools()`. See [Task Tools](task-tools.md).

| Tool | Purpose |
|------|---------|
| TaskCreate | Spawn asynchronous sub-tasks |
| TaskList | List active and completed tasks |
| TaskGet | Check task status and results |
| TaskStop | Stop a running task |

### Plan Mode Tool

`ExitPlanMode` is not registered globally. It is injected by the API backend only when plan mode is active and intercepted before normal tool execution.

## LLM Integration

Tools are presented to the LLM as `LlmToolDef` objects:

```go
type LlmToolDef struct {
    Name        string         `json:"name"`
    Description string         `json:"description"`
    InputSchema map[string]any `json:"input_schema"`
}
```

The `InputSchema` follows JSON Schema. The LLM generates structured JSON input matching the schema, and the engine passes it to the tool's `Execute` function.

## Error Handling

Tools signal errors through `ToolResult.IsError = true` rather than Go errors. A Go error from `Execute` indicates an infrastructure failure. A `ToolResult` with `IsError: true` indicates a normal tool failure the LLM should handle (file not found, command failed, etc.).
