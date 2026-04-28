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
{"jsonrpc": "2.0", "id": 5, "method": "hook/before_prompt",
 "params": {"_ctx": {"sessionKey": "meta", "cwd": "/u/p"}, "value": "fix the bug"}}

// Extension responds:
{"jsonrpc": "2.0", "id": 5, "result": {"value": "fix the bug in src/main.ts"}}
```

The `_ctx` envelope carries session context: `sessionKey` (the engine session id, same key the client passes on `start_session`/`send_prompt`), `cwd` (working directory), and optional `model`/`config`. The TypeScript SDK exposes these as `IonContext.sessionKey`, `ctx.cwd`, etc.

Return null to take no action:

```json
{"jsonrpc": "2.0", "id": 5, "result": null}
```

See `hooks-reference.md` for the full catalog of 55 hooks and their expected return types.

### Per-session state via `ctx.sessionKey`

A single extension subprocess is shared across every session in its loaded extension group. Module-level state is therefore visible to every hook firing for every session served by the process. Partition by `ctx.sessionKey` to keep per-session data separate:

```typescript
const intentBySession = new Map<string, string>()

ion.on('before_prompt', (ctx, prompt) => {
  intentBySession.set(ctx.sessionKey, classify(prompt))
})

ion.on('model_select', (ctx, info) => {
  if (intentBySession.get(ctx.sessionKey) === 'cloud') {
    return 'claude-sonnet-4-6'
  }
  return info.requestedModel
})

ion.on('session_end', (ctx) => {
  intentBySession.delete(ctx.sessionKey)
})
```

Always pair the writer hook with a `session_end` cleanup; long-lived extensions otherwise leak entries forever.

### Calling tools from extension code (`ctx.callTool`)

Use `ctx.callTool(name, input)` to dispatch a registered tool from a hook handler, tool, or slash command without going through the LLM. The call routes to the same registry the LLM uses — built-in tools, MCP-registered tools, and tools registered by extensions in the loaded group.

```typescript
ion.registerCommand('recall', {
  description: '/recall <query>',
  execute: async (args, ctx) => {
    const r = await ctx.callTool('memory_recall', { query: args, topK: 5 })
    ctx.sendMessage(r.isError ? 'recall failed: ' + r.content : r.content)
  },
})
```

Three rules:

- **Permissions still apply.** `deny` rules return `{ content, isError: true }`. `ask` rules also return `isError: true` because extension calls cannot block on user elicitation; configure an explicit allow rule for the specific tool if you need it permitted from extension code.
- **Per-tool hooks (`bash_tool_call`, etc.) and `permission_request` do not fire.** Both would re-enter the calling extension and create surprising recursion. Run inline policy before `callTool` if you need it.
- **Unknown tool name throws.** A non-registered tool surfaces as a Promise rejection — programming error in the calling extension. Tool-internal failures (file not found, etc.) resolve normally with `isError: true`.

### Driving fresh LLM turns (`ctx.sendPrompt`)

`ctx.sendPrompt(text, opts?)` queues a fresh prompt on the session. Use it from a slash command to flip the conversation into a different model, or from `session_start` to prime the agent. Resolves once the engine accepts the prompt; does NOT wait for the LLM to finish.

```typescript
ion.registerCommand('cloud', {
  description: '/cloud <message>',
  execute: async (args, ctx) => {
    await ctx.sendPrompt(args, { model: 'claude-sonnet-4-6' })
  },
})
```

**Recursion hazard.** Calling sendPrompt from `before_prompt` triggers another `before_prompt` for the queued run. Guard with a per-session in-flight flag keyed on `ctx.sessionKey` if you need this pattern.

## TypeScript Support

Extensions written in TypeScript require `esbuild` installed globally:

```bash
npm i -g esbuild
```

When the engine discovers an `index.ts` entry point, it runs esbuild to bundle it into `<extDir>/.ion-build/ext-<timestamp>.mjs` before spawning the subprocess:

```
esbuild index.ts --bundle --platform=node --format=esm --target=node20 --outfile=<extDir>/.ion-build/ext-abc.mjs
```

The bundle lives inside the extension directory (not /tmp) so Node's ESM resolver finds the extension's `node_modules` for declared external deps. The engine plants `.ion-build/.gitignore` to keep build artifacts out of version control.

ESM output means top-level `await` works in extension code and Node built-ins are imported with the standard `import` syntax (`import { readFile } from 'node:fs/promises'`).

The bundled file is what actually runs. Source maps are preserved for error traces. The temp file is cleaned up when the extension subprocess exits.
