# Extension Anatomy

How Ion Engine extensions are structured, discovered, and executed.

## Directory Layout

```
my-extension/
  index.ts          # entry point (or index.js, or main.ts/main.js)
  agents/           # optional agent definitions (.md files)
    researcher.md
    writer.md
  docs/             # optional reference docs for agents
    api-spec.md
```

The engine looks for the entry point in this order: `index.ts`, `index.js`, `main.ts`, `main.js`. One is required.

## Extension Lifecycle

1. **Discovery**: Engine scans `~/.ion/extensions/` for directories containing a valid entry point.
2. **Subprocess start**: Engine spawns the extension as a child process (`node index.js` or builds TypeScript first).
3. **Init handshake**: Engine sends an `init` JSON-RPC request. Extension responds with its tool and command registrations.
4. **Hook registration**: Engine notes which hooks the extension handles based on the init response.
5. **Session runtime**: Engine fires hooks as JSON-RPC calls during the session. Extension handles them and returns results.
6. **Shutdown**: Engine sends `session_end`, then terminates the subprocess.

## JSON-RPC 2.0 Protocol

All communication between engine and extension uses JSON-RPC 2.0 over stdin/stdout. One JSON object per line (NDJSON).

### Request (engine to extension)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "init",
  "params": {
    "sessionId": "abc-123",
    "workingDirectory": "/Users/josh/project"
  }
}
```

Methods follow these patterns:
- `init` -- startup handshake
- `hook/<event_name>` -- hook invocation (e.g., `hook/before_prompt`)
- `tool/<tool_name>` -- tool invocation (e.g., `tool/ion_scaffold`)

### Response (extension to engine)

Success:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [...],
    "commands": {...},
    "hooks": ["before_prompt", "tool_call"]
  }
}
```

Error:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32600,
    "message": "Invalid request"
  }
}
```

Standard error codes: `-32700` (parse error), `-32600` (invalid request), `-32601` (method not found), `-32602` (invalid params), `-32603` (internal error).

## Tool Registration

Register tools in the `init` response. Each tool needs a name, description, and JSON Schema for parameters.

```json
{
  "result": {
    "tools": [
      {
        "name": "ion_scaffold",
        "description": "Scaffold a new Ion extension directory structure",
        "parameters": {
          "type": "object",
          "properties": {
            "name": { "type": "string", "description": "Extension name" },
            "language": { "type": "string", "enum": ["typescript", "javascript"] }
          },
          "required": ["name"]
        }
      }
    ]
  }
}
```

When the LLM invokes a registered tool, the engine sends a `tool/<name>` RPC to the extension. The extension executes the logic and returns the result.

## Command Registration

Commands are slash-commands the user can invoke directly (e.g., `/ion-meta`). Register them in the `init` response.

```json
{
  "result": {
    "commands": {
      "ion-meta": "Launch the Ion Meta extension authoring assistant"
    }
  }
}
```

Commands map to agents defined in the `agents/` directory. When the user runs `/ion-meta`, the engine loads the corresponding agent definition.

## Hook Handling

The engine calls `hook/<event_name>` when events occur during a session. The extension processes the event and returns a result (or null for void hooks).

```json
// Engine sends:
{"jsonrpc": "2.0", "id": 5, "method": "hook/before_prompt", "params": {"value": "fix the bug"}}

// Extension responds:
{"jsonrpc": "2.0", "id": 5, "result": {"value": "fix the bug in src/main.ts"}}
```

Return null to take no action:

```json
{"jsonrpc": "2.0", "id": 5, "result": null}
```

See `hooks-reference.md` for the full catalog of 50 hooks and their expected return types.

## TypeScript Support

Extensions written in TypeScript require `esbuild` installed globally:

```bash
npm i -g esbuild
```

When the engine discovers an `index.ts` entry point, it runs esbuild to bundle it into a temporary `.js` file before spawning the subprocess:

```
esbuild index.ts --bundle --platform=node --format=cjs --outfile=/tmp/ext-abc.js
```

The bundled file is what actually runs. Source maps are preserved for error traces. The temp file is cleaned up when the extension subprocess exits.
