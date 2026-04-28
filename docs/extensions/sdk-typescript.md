---
title: TypeScript SDK Reference
description: Full API reference for the Ion Engine TypeScript extension SDK.
sidebar_position: 7
---

# TypeScript SDK Reference

The TypeScript SDK lives at `engine/extensions/sdk/ion-sdk/` (a directory with `index.ts`, `types.ts`, and `runtime.ts`) and handles JSON-RPC communication, hook dispatch, and tool/command registration. Import `createIon()` to get started — esbuild resolves the directory through its `index.ts` barrel, so the public import path is the same single string `'../sdk/ion-sdk'`.

## createIon()

Factory function that creates an SDK instance and begins listening for engine requests on the next tick.

```typescript
import { createIon } from './sdk/ion-sdk'

const ion = createIon()
```

Returns an `IonSDK` instance. Register all hooks, tools, and commands synchronously after calling `createIon()`. The SDK starts reading stdin on `process.nextTick()`, giving your registration code time to run first.

## IonSDK

The main SDK interface.

```typescript
interface IonSDK {
  on(hook: string, handler: (ctx: IonContext, payload?: any) => any): void
  registerTool(def: ToolDef): void
  registerCommand(name: string, def: CommandDef): void
}
```

### `on(hook, handler)`

Register a handler for a hook event. Only one handler per hook name is supported. If you call `on()` twice with the same hook name, the second handler replaces the first.

```typescript
ion.on('session_start', (ctx) => {
  process.stderr.write('Session started\n')
})

ion.on('before_prompt', (ctx, prompt) => {
  return { value: prompt + '\n\nAlways respond in JSON.' }
})

ion.on('tool_call', (ctx, payload) => {
  if (payload.toolName === 'Bash' && payload.input.command.includes('rm -rf')) {
    return { block: true, reason: 'Dangerous command blocked' }
  }
  return null
})
```

The handler receives an `IonContext` and an optional payload (hook-specific data). Return values depend on the hook type. See the hooks reference for return type patterns.

### `registerTool(def)`

Register a tool that the LLM can invoke.

```typescript
ion.registerTool({
  name: 'my_tool',
  description: 'Does something useful',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The input value' }
    },
    required: ['input']
  },
  execute: async (params, ctx) => {
    return { content: `Processed: ${params.input}` }
  }
})
```

### `registerCommand(name, def)`

Register a slash command.

```typescript
ion.registerCommand('status', {
  description: 'Show current project status',
  execute: async (args, ctx) => {
    ctx.sendMessage('All systems operational')
  }
})
```

## IonContext

Passed to every hook handler, tool execute function, and command execute function. Provides access to session state and engine communication.

```typescript
interface IonContext {
  sessionKey: string
  cwd: string
  model: { id: string; contextWindow: number } | null
  config: ExtensionConfig
  emit(event: EngineEvent): void
  sendMessage(text: string): void
  registerProcess(name: string, pid: number, task: string): Promise<void>
  deregisterProcess(name: string): Promise<void>
  listProcesses(): Promise<ProcessInfo[]>
  terminateProcess(name: string): Promise<void>
  cleanStaleProcesses(): Promise<number>
  callTool(name: string, input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }>
  sendPrompt(text: string, opts?: SendPromptOpts): Promise<void>
  dispatchAgent(opts: DispatchAgentOpts): Promise<DispatchAgentResult>
  discoverAgents(opts?: DiscoverAgentsOpts): Promise<DiscoveredAgent[]>
}
```

### Properties

**`sessionKey: string`** -- identifier of the engine session that fired the hook (the same key clients pass on `start_session` / `send_prompt`). Empty string when the context does not originate from a live session — for example, during extension load before any session is bound.

Use this as the key of a module-level `Map` to keep per-session state across hook calls within a single extension subprocess. The extension subprocess is shared across every session in its loaded group, so module-level state must be partitioned by session key to avoid cross-session bleed.

```typescript
const intentBySession = new Map<string, string>()

ion.on('before_prompt', (ctx, prompt) => {
  intentBySession.set(ctx.sessionKey, classify(prompt))
})

ion.on('model_select', (ctx, info) => {
  const intent = intentBySession.get(ctx.sessionKey)
  if (intent === 'cloud') return 'claude-sonnet-4-6'
  return info.requestedModel
})

ion.on('session_end', (ctx) => {
  intentBySession.delete(ctx.sessionKey)
})
```

Always delete the session entry on `session_end` to avoid leaking state across long-lived extension processes.

**`cwd: string`** -- the working directory for the current session.

**`model: { id: string; contextWindow: number } | null`** -- the active model. Null if not yet resolved.

**`config: ExtensionConfig`** -- the extension configuration passed during init.

### Methods

**`emit(event: EngineEvent)`** -- emit an event to all connected socket clients. During hook execution, events are buffered and returned with the hook response. Outside hooks (tool/command execution), events are sent as `ext/emit` notifications immediately.

```typescript
ctx.emit({ type: 'engine_notify', message: 'Task complete', level: 'info' })
ctx.emit({ type: 'engine_working_message', message: 'Processing...' })
ctx.emit({ type: 'engine_agent_state', agents: [{ name: 'worker', status: 'running' }] })
```

**`sendMessage(text: string)`** -- send text as assistant content. The engine queues this as a follow-up prompt.

```typescript
ctx.sendMessage('Analysis complete. Found 3 issues.')
```

**`registerProcess(name, pid, task)`** -- register a subprocess for lifecycle tracking.

```typescript
const child = spawn('node', ['worker.js'])
await ctx.registerProcess('worker', child.pid, 'Running background task')
```

**`deregisterProcess(name)`** -- remove a process registration.

```typescript
await ctx.deregisterProcess('worker')
```

**`listProcesses()`** -- list all registered processes.

```typescript
const procs = await ctx.listProcesses()
// [{ name: 'worker', pid: 54321, task: 'Running...', startedAt: '2026-04-22T10:00:00Z' }]
```

**`terminateProcess(name)`** -- terminate a registered process (SIGTERM, then SIGKILL after 5s).

```typescript
await ctx.terminateProcess('worker')
```

**`cleanStaleProcesses()`** -- remove registrations for dead processes. Returns the count of cleaned entries.

```typescript
const cleaned = await ctx.cleanStaleProcesses()
```

**`callTool(name, input)`** -- dispatch a tool call from extension code through the same registry the LLM uses. Resolves with `{ content, isError? }`. Covers built-in tools (Read, Write, Edit, Bash, Grep, Glob, Agent, ...), MCP-registered tools (`mcp__server__tool` form), and any tool registered by extensions in the loaded group.

```typescript
ion.registerCommand('recall', {
  description: '/recall <query>',
  execute: async (args, ctx) => {
    const r = await ctx.callTool('memory_recall', { query: args, topK: 5 })
    ctx.sendMessage(r.content)
  },
})
```

Subject to the session's permission policy. `deny` decisions resolve with `{ content, isError: true }` and a human-readable reason. `ask` decisions also resolve with `isError: true` -- extension calls cannot block on user elicitation, so configure an explicit allow rule for the specific tool/extension combination if you need it permitted from extension code.

`callTool` does **not** fire per-tool hooks (`bash_tool_call`, etc.) or `permission_request`. Both would re-enter the calling extension and create surprising recursion. The audit log entries from the permission engine still fire.

The promise rejects only when the named tool is not registered (programming error in the calling extension). Tool-internal failures resolve with `isError: true`.

**`sendPrompt(text, opts?)`** -- queue a fresh prompt on this session's agent loop. Resolves once the engine has accepted the prompt; does **not** wait for the LLM to finish. Pass `opts.model` to override the model for this single prompt.

```typescript
ion.registerCommand('cloud', {
  description: '/cloud <message>',
  execute: async (args, ctx) => {
    await ctx.sendPrompt(args, { model: 'claude-sonnet-4-6' })
  },
})
```

Slash commands and hook handlers can both call this. Common patterns:

- `/cloud <message>` — force a specific model for one turn.
- `session_start` — prime the agent with a kickoff prompt.

**Recursion hazard.** Calling `sendPrompt` from inside `before_prompt` or any pre-prompt hook triggers a new run, which fires the same hook again. The engine's prompt queue depth is the only outer bound — extensions are responsible for guarding their own loops. The canonical pattern is a per-session in-flight flag stored on a `sessionKey`-keyed Map:

```typescript
const inFlight = new Set<string>()

ion.on('session_start', async (ctx) => {
  if (inFlight.has(ctx.sessionKey)) return
  inFlight.add(ctx.sessionKey)
  try {
    await ctx.sendPrompt('What should we work on first?')
  } finally {
    inFlight.delete(ctx.sessionKey)
  }
})
```

```typescript
interface SendPromptOpts {
  model?: string  // override the session default for this single prompt
}
```

**`dispatchAgent(opts)`** -- dispatch an engine-native agent. Blocks until the agent completes.

```typescript
const result = await ctx.dispatchAgent({
  name: 'researcher',
  task: 'Find all TODO comments in the codebase',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a research agent. Be thorough.',
  projectPath: ctx.cwd
})
// { output: '...', exitCode: 0, elapsed: 8.3 }
```

## ToolDef

```typescript
interface ToolDef {
  name: string
  description: string
  parameters: any                    // JSON Schema
  execute: (params: any, ctx: IonContext) => Promise<{ content: string; isError?: boolean }>
}
```

## CommandDef

```typescript
interface CommandDef {
  description: string
  execute: (args: string, ctx: IonContext) => Promise<void>
}
```

## ExtensionConfig

```typescript
interface ExtensionConfig {
  extensionDir: string
  workingDirectory: string
  mcpConfigPath?: string
}
```

## EngineEvent

Discriminated union of event types the extension can emit. The five named variants give autocomplete on the engine-recognised shapes; the open variant lets harnesses emit custom event types that the engine and desktop bridge pass through verbatim.

```typescript
type EngineEvent =
  | { type: 'engine_agent_state'; agents: any[] }
  | { type: 'engine_status'; fields: any }
  | { type: 'engine_working_message'; message: string }
  | { type: 'engine_notify'; message: string; level: string }
  | { type: 'engine_harness_message'; message: string; source?: string }
  | { type: string; [key: string]: unknown }   // open variant — custom harness events
```

**Custom event types.** Pick a `type` value that won't collide with current or future engine-emitted events. Convention: prefix with the extension or harness name (`jarvis_inbox_update`, `ion-meta_persona_loaded`). The engine validates only `engine_agent_state` payloads; every other type is forwarded to all connected socket clients unchanged. The desktop bridge passes events through without type-based dispatch, so any custom payload your renderers know how to handle is fair game.

```typescript
ctx.emit({ type: 'jarvis_inbox_update', count: 3, source: 'mail' })
```

If a downstream renderer doesn't recognize the type, it's silently dropped — there's no global registry. Build the consumer side alongside the producer.

## DispatchAgentOpts

```typescript
interface DispatchAgentOpts {
  name: string              // agent name (required)
  task: string              // task description (required)
  model?: string            // model override
  extensionDir?: string     // extension directory for the child session
  systemPrompt?: string     // injected system prompt
  projectPath?: string      // working directory for the agent
}
```

## DispatchAgentResult

```typescript
interface DispatchAgentResult {
  output: string    // agent's final output text
  exitCode: number  // 0 = success
  elapsed: number   // wall time in seconds
}
```

## DiscoverAgentsOpts

```typescript
interface DiscoverAgentsOpts {
  sources?: ("extension" | "user" | "project")[]  // default: all three
  bundleName?: string                              // filter by bundle name
}
```

Sources are checked in precedence order: `extension` (lowest), `user`, `project` (highest). When the same agent name appears in multiple sources, the higher-precedence source wins.

## DiscoveredAgent

```typescript
interface DiscoveredAgent {
  name: string              // agent name (derived from filename)
  source: string            // which source provided it
  bundleName: string        // originating extension/bundle
  path: string              // absolute path to agent definition
}
```

**`discoverAgents(opts?)`** -- discover available agent definitions from configured sources.

```typescript
const agents = await ctx.discoverAgents({ sources: ['extension', 'project'] })
// [{ name: 'researcher', source: 'project', bundleName: 'my-ext', path: '/path/to/researcher.md' }]
```

## ProcessInfo

```typescript
interface ProcessInfo {
  name: string
  pid: number
  task: string
  startedAt: string   // ISO 8601 timestamp
}
```
