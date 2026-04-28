---
title: Tools Registration
description: How to register custom tools in Ion Engine extensions.
sidebar_position: 5
---

# Tools Registration

Extensions register tools that the LLM can invoke alongside the engine's built-in tools. Tools are registered during the init handshake and are available for the entire session.

## Tool definition

Each tool requires a name, description, JSON Schema for parameters, and an execute function.

### TypeScript

```typescript
import { createIon } from './sdk/ion-sdk'

const ion = createIon()

ion.registerTool({
  name: 'search_jira',
  description: 'Search Jira issues by JQL query',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'JQL query string'
      },
      maxResults: {
        type: 'number',
        description: 'Maximum results to return (default 10)'
      }
    },
    required: ['query']
  },
  execute: async (params, ctx) => {
    const results = await searchJira(params.query, params.maxResults || 10)
    return { content: JSON.stringify(results, null, 2) }
  }
})
```

### Go

```go
sdk.RegisterTool(extension.ToolDefinition{
    Name:        "search_jira",
    Description: "Search Jira issues by JQL query",
    Parameters: map[string]interface{}{
        "type": "object",
        "properties": map[string]interface{}{
            "query": map[string]interface{}{
                "type":        "string",
                "description": "JQL query string",
            },
            "maxResults": map[string]interface{}{
                "type":        "number",
                "description": "Maximum results to return (default 10)",
            },
        },
        "required": []string{"query"},
    },
    Execute: func(params interface{}, ctx *extension.Context) (*types.ToolResult, error) {
        p := params.(map[string]interface{})
        query := p["query"].(string)
        results, err := searchJira(query)
        if err != nil {
            return &types.ToolResult{Content: err.Error(), IsError: true}, nil
        }
        data, _ := json.MarshalIndent(results, "", "  ")
        return &types.ToolResult{Content: string(data)}, nil
    },
})
```

## ToolDef schema

### TypeScript

```typescript
interface ToolDef {
  name: string        // unique tool name (used in tool/{name} RPC)
  description: string // shown to the LLM to decide when to use the tool
  parameters: any     // JSON Schema object describing the input
  execute: (params: any, ctx: IonContext) => Promise<{ content: string; isError?: boolean }>
}
```

### Go

```go
type ToolDefinition struct {
    Name        string
    Description string
    Parameters  map[string]interface{}
    Execute     func(params interface{}, ctx *Context) (*types.ToolResult, error)
}
```

## Tool invocation flow

1. The LLM decides to use a tool based on the tool description and current context.
2. The engine receives the tool call from the LLM with the tool name and input parameters.
3. The engine fires the `tool_call` hook (extensions can block the call here).
4. The engine fires the per-tool call hook (e.g., `bash_tool_call`) if applicable.
5. The engine sends a `tool/{name}` RPC request to the extension.
6. The extension executes the tool logic and returns a result.
7. The engine fires the per-tool result hook (e.g., `bash_tool_result`) if applicable.
8. The engine returns the result to the LLM.

## Response format

Tools return an object with two fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | yes | Text content returned to the LLM |
| `isError` | boolean | no | If true, the LLM sees this as an error result |

```typescript
// Success
return { content: 'Created issue PROJ-123' }

// Error
return { content: 'Authentication failed: invalid token', isError: true }
```

When `isError` is true, the LLM typically acknowledges the error and may retry with different parameters or ask the user for help. The engine does not treat tool errors as fatal.

## Parameter schema

Parameters must be a valid JSON Schema object. The schema is sent to the LLM as part of the tool definition, so clear descriptions on each property help the LLM provide correct input.

```typescript
{
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute file path to read'
    },
    encoding: {
      type: 'string',
      enum: ['utf-8', 'base64'],
      description: 'File encoding (default utf-8)'
    }
  },
  required: ['path']
}
```

## Context during tool execution

The `ctx` parameter provides access to session context and engine communication:

```typescript
execute: async (params, ctx) => {
  // Access working directory
  const cwd = ctx.cwd

  // Access model info
  const model = ctx.model?.id

  // Access extension config
  const extDir = ctx.config.extensionDir

  // Emit an event to socket clients
  ctx.emit({ type: 'engine_working_message', message: 'Searching...' })

  // Send a follow-up message
  ctx.sendMessage('Search complete, found 5 results')

  return { content: 'Done' }
}
```

## Naming conventions

- Use snake_case for tool names (e.g., `search_jira`, `create_issue`)
- Prefix with your extension name to avoid collisions (e.g., `ion_scaffold`, `deploy_preview`)
- Keep descriptions concise but specific. The LLM uses the description to decide when to invoke the tool.
