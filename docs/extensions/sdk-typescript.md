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
import { createIon, log } from './sdk/ion-sdk'

const ion = createIon()
```

Returns an `IonSDK` instance. Register all hooks, tools, and commands synchronously after calling `createIon()`. The SDK starts reading stdin on `process.nextTick()`, giving your registration code time to run first.

## Build identity

At init, the runtime reads `~/.ion/extensions/sdk/ion-sdk/build-identity.json` and returns its `buildIdentity` in the handshake. Release engines reject a TypeScript SDK stamped by another build, preventing stale installed SDK files from running against a newly installed engine.

A missing, unreadable, malformed, or shape-invalid stamp produces an empty identity for compatibility with older SDK installs and emits a structured `log` warning containing the path and read error when available. Development engines identified as `dev` accept any SDK identity. `ion install-assets` writes the stamp with the SDK files; extension authors do not set it manually.

## IonSDK

The main SDK interface.

```typescript
interface IonSDK {
  on(hook: string, handler: (ctx: IonContext, payload?: any) => any): void
  registerTool(def: ToolDef): void
  registerCommand(name: string, def: CommandDef): void
  registerAgentTools(opts?: RegisterAgentToolsOpts): void
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

### `registerAgentTools(opts?)`

Scan `agents/*.md` in the extension directory, parse each file's YAML frontmatter, and register a dispatch tool per agent. Called once at startup, synchronously after `createIon()`.

Each discovered agent with a `parent` field gets a tool named `dispatch_<name>` (hyphens replaced with underscores). When the LLM calls the tool, the SDK invokes `ctx.dispatchAgent()` with the agent's `systemPrompt`, `model`, and `task` from the tool input.

By default, root agents (no `parent` field) are excluded since they represent the conversation itself, not dispatch targets. Customize filtering, tool naming, and descriptions via `RegisterAgentToolsOpts`.

```typescript
const ion = createIon()
ion.registerAgentTools()

// Suppress the generic Agent tool so the model uses typed dispatch tools
ion.on('session_start', (ctx) => { ctx.suppressTool('Agent') })
```

## IonContext

Passed to every hook handler, tool execute function, and command execute function. Provides access to session state and engine communication.

```typescript
interface IonContext {
  sessionKey: string
  conversationId: string
  depth: number
  dispatchId: string
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
  callTool(name: string, input: Record<string, unknown>): Promise<ToolResult>
  sendPrompt(text: string, opts?: SendPromptOpts): Promise<void>
  dispatchAgent(opts: DispatchAgentOpts): Promise<DispatchAgentResult>
  recallAgent(name: string, opts?: RecallAgentOpts): Promise<boolean>
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

**`conversationId: string`** -- durable conversation identity (`{unix_millis}-{hex}`), stable across engine restarts and reattaches. Use it for resource scoping, audit trails, and persistent identity. Empty when no conversation is active.

**`depth: number`** -- dispatch depth of the session that fired the hook: `0` for the root (orchestrator) session, `1` for a directly dispatched child agent, `2` for a grandchild, and so on. This is the explicit root-vs-child discriminator for hooks whose payload carries no agent identity (`session_start`, `session_end`, `turn_start` and friends). A handler that should only act for the root session — a greeting toast, a startup git sync, a one-time bootstrap — branches on `ctx.depth === 0`. Mirrors `AgentInfo.isRoot` on `before_agent_start`, which discriminates per-firing rather than per-session.

```typescript
ion.on('session_start', (ctx) => {
  if (ctx.depth > 0) return // dispatched child — skip root-only bootstrap
  ctx.emit({ type: 'engine_notify', message: 'harness online', level: 'info' })
})
```

**`dispatchId: string`** -- dispatch ID owning this context. Empty for the root session (`depth === 0`); populated for child sessions with the ID minted when the agent was spawned, so per-dispatch state can be keyed without inventing a session-local identity.

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

> **Note: `engine_agent_state` emissions are interpreted as complete snapshots.** Include every agent you want visible in every emission — consumers do not merge across events. Sticky and always-visible agents that you stop emitting will disappear from client views. To wipe the panel, emit `agents: []`. See the [Agent State Contract](../architecture/agent-state.md) for the full semantics.

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

**`callTool(name, input)`** -- dispatch a tool call from extension code through the same registry the LLM uses. Resolves with a `ToolResult`. Covers built-in tools (Read, Write, Edit, Bash, Grep, Glob, Agent, ...), MCP-registered tools (`mcp__server__tool` form), and any tool registered by extensions in the loaded group.

```typescript
interface ToolResult {
  content: string
  isError?: boolean
  contentItems?: ToolContent[]
}
```

`content` is the text-only convenience field (all text items concatenated). `contentItems` carries the full ordered typed content when the tool returned non-text items -- embedded resources, base64 blobs, images, or annotated content. It is present only when the underlying tool produced typed content; for text-only results it is omitted and `content` is sufficient.

Each `ToolContent` item has a `type` discriminator (`"text"`, `"image"`, `"resource"`) and type-specific fields:

```typescript
interface ToolContent {
  type: string
  text?: string           // type "text"
  data?: string           // base64 image data (type "image")
  mimeType?: string       // MIME type for image or resource data
  resource?: EmbeddedResource  // type "resource"
  uri?: string
  name?: string
  annotations?: ToolAnnotations
}

interface EmbeddedResource {
  uri?: string
  mimeType?: string
  text?: string
  blob?: string           // base64 binary data
}
```

```typescript
ion.registerCommand('recall', {
  description: '/recall <query>',
  execute: async (args, ctx) => {
    const r = await ctx.callTool('memory_recall', { query: args, topK: 5 })
    ctx.sendMessage(r.content)
  },
})
```

When calling MCP tools that return embedded resources or images, use `contentItems` to access typed data. The engine does not decode or log blob bytes; keep processing in memory and do not include blobs in extension log messages or emitted events.

```typescript
ion.registerCommand('inspect-resource', {
  description: '/inspect-resource <name>',
  execute: async (args, ctx) => {
    const r = await ctx.callTool('mcp__files__get_resource', { name: args })
    for (const item of r.contentItems ?? []) {
      if (item.type === 'resource' && item.resource?.blob) {
        await parseInMemory(item.resource.mimeType, item.resource.blob)
      }
    }
  },
})
```

Subject to the session's permission policy. `deny` decisions resolve with `{ content, isError: true }` and a human-readable reason. `ask` decisions also resolve with `isError: true` -- extension calls cannot block on user elicitation, so configure an explicit allow rule for the specific tool/extension combination if you need it permitted from extension code.

`callTool` does **not** fire per-tool hooks (`bash_tool_call`, etc.) or `permission_request`. Both would re-enter the calling extension and create surprising recursion. The audit log entries from the permission engine still fire.

The promise rejects only when the named tool is not registered (programming error in the calling extension). Tool-internal failures resolve with `isError: true`.

**`http`** -- a pre-authenticated outbound HTTP surface. Each verb (`get`, `post`, `put`, `patch`, `delete`, plus the generic `request(method, url, opts?)`) resolves with `{ status, headers, body }`.

```typescript
const res = await ctx.http.get('https://graph.microsoft.com/v1.0/me', {
  scope: 'https://graph.microsoft.com/User.Read',
})
if (res.status === 200) {
  const me = JSON.parse(res.body)
}
```

**Engine-owned identity injection.** The request uses the configured operator or machine identity. OAuth/OIDC sources inject a bearer token for the declared `scope`/`audience`; AWS workload sources sign the request with SigV4 when `awsService` and `awsRegion` are supplied. Raw credentials never cross into extension code — request options carry no credential, and responses carry only `status`, `headers`, and `body`. Any extension-supplied `Authorization` header is overwritten. The call fails clearly when no compatible provider is configured. See [Machine identity](../deployment/machine-identity.md).

**SSRF / private-network policy.** By default the request is rejected if the target host resolves to a private or reserved address (`blocked: private/reserved address ...`). An operator-installed extension that legitimately needs to reach an intranet API sets `allowPrivateNetwork: true` to opt this single request out of the guard. Only `http` and `https` targets are allowed; other schemes are rejected.

```typescript
interface IonHttpRequestOptions {
  scope?: string                       // downstream token scope (e.g. 'api://<app-id>/Billing.Read')
  audience?: string                    // explicit token audience/resource (Auth0, RFC 8707)
  awsService?: string                   // selects AWS SigV4 instead of bearer auth
  awsRegion?: string                    // required SigV4 credential-scope region
  headers?: Record<string, string>     // Authorization is reserved and overwritten
  body?: string                        // request body, sent verbatim
  timeoutMs?: number                   // request deadline (default 30000)
  maxBytes?: number                    // response size cap (default 5 MB)
  allowPrivateNetwork?: boolean        // opt out of the private-address guard (default false)
}

interface IonHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}
```

### Tracing and correlation

Every hook context carries the identifiers Ion uses to correlate its own records. Reading them lets
an extension emit telemetry that joins Ion's, and forwarding `traceId` lets a downstream service
join the same trace.

| Field | Scope | Reach for it when |
|---|---|---|
| `ctx.traceId` | **One prompt-to-completion run.** W3C trace-context trace-id, 32 lowercase hex | Distributed tracing — a `traceparent` header, an APM operation id |
| `ctx.runId` | The same run, engine-native form (not W3C-shaped) | Joining your records to Ion's `run_id` in its logs and telemetry |
| `ctx.conversationId` | The durable conversation, across restarts | Long-lived correlation, audit, resource scoping |
| `ctx.sessionKey` | One engine session, spanning many runs | Per-session state (a module-level `Map` key) |
| `ctx.dispatchId` / `ctx.depth` | One sub-agent within a run | Attributing work to a child agent; `depth === 0` is the root |

`traceId` and `runId` are `''` when no run is in flight — `session_start`, a schedule or webhook
delivery, extension load. That is the accurate reading: there is no transaction to correlate
against. Guard on it rather than emitting a span with an empty parent.

**Forwarding the trace downstream.** `ctx.traceId` is valid verbatim as the trace-id in a
`traceparent` header. Mint your own span id — your span *is* a new span, so it becomes the
parent-id the callee sees:

```typescript
import { randomBytes } from 'node:crypto'

ion.on('tool_call', async (ctx, info) => {
  if (!ctx.traceId) return  // no run in flight: nothing to correlate to

  const spanId = randomBytes(8).toString('hex')
  const res = await ctx.http.post('https://api.corp.example.com/v1/audit', {
    scope: 'api://audit-api/Events.Write',
    headers: {
      'Content-Type': 'application/json',
      traceparent: `00-${ctx.traceId}-${spanId}-01`,
    },
    body: JSON.stringify({
      tool: info.name,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
    }),
  })
  if (res.status >= 400) {
    log.warn('audit post failed', { status: res.status, traceId: ctx.traceId })
  }
})
```

Because the trace-id is W3C-standard, the receiving service — and anything *it* calls — lands in
the same trace as the Ion run that triggered it. In an OTLP backend the whole chain reads as one
transaction: the prompt, the engine's turns and tool calls, your API, and its dependencies. In
Application Insights the trace-id becomes the `operation_Id`, so the end-to-end transaction view
works with no mapping.

This composes with `ctx.http` above: the engine authenticates the call using the configured operator or machine identity
while the `traceparent` you set carries the correlation, so an extension gets authenticated,
traced egress without handling a token or minting a trace identity of its own.

Ion's own records use the same vocabulary — see
[`docs/observability/log-schema.md`](../observability/log-schema.md) § "Correlation-ID vocabulary"
for the field reference and the LogQL/`jq` pivots.

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

**`suspend()`** -- end the current LLM run without completing it, then revive later.

Behaviour depends on depth, because the two cases are structurally different:

- **Inside a dispatched run (depth >= 1):** the dispatch stays alive and goes idle; the parent's `OnComplete` does NOT fire. A revive message via `sendPrompt` (typically a child's completion callback) restarts the run with the updated conversation. Use `suspendUntilAll(dispatchIds)` for N-child fan-out, or the `dispatch_agents` tool, which calls it for you.
- **At depth 0 (the orchestrator):** parks the ROOT session on its outstanding background bash commands — the same thing the engine does automatically at a turn boundary, exposed so an extension can end the turn deliberately. The root's run exits fully rather than parking a live goroutine, and a NEW run is started when a command completes. Each completion wakes the session once; if the next turn also ends with commands outstanding, it parks again. See [ADR-023](../architecture/adr/023-root-session-park-and-wake.md).

```typescript
// depth >= 1: park until a specific child reports back
await ctx.suspend()

// depth 0: park the orchestrator on its own background commands
await ctx.suspend()
```

It throws at depth 0 when there is no active run to park, or no outstanding **notifying** background commands to park on (`notify_on_complete: true` — a fire-and-forget command is not something the session waits for). Parking with nothing to wait for would strand the session, so the engine refuses rather than hanging. Passing `awaitingDispatchIds` at depth 0 also throws: those are child dispatches, which only exist inside a dispatched run.

**`dispatchAgent(opts)`** -- dispatch an engine-native agent asynchronously by default. The promise resolves with a `DispatchAgentResult` stub carrying `dispatchId`; engine returns terminal result automatically to dispatch owner. Pass `waitForCompletion: true` only when extension must block for final output.

```typescript
const result = await ctx.dispatchAgent({
  name: 'researcher',
  task: 'Find all TODO comments in the codebase',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a research agent. Be thorough.',
  projectPath: ctx.cwd
})
// { name: 'researcher', dispatchId: '...', ... }
```

Default dispatch is asynchronous. `background: true` remains accepted but is no longer required; `background: false` does not select foreground. Pass `waitForCompletion: true` only when final child output is required synchronously. Terminal lifecycle callbacks apply to asynchronous dispatches:
await ctx.dispatchAgent({
  name: 'code-reviewer',
  task: 'Review the latest changes',
  onComplete: (result) => {
    ctx.emit({ type: 'engine_notify', message: `Review done: ${result.output}`, level: 'info' })
  },
  onError: (err) => {
    ctx.emit({ type: 'engine_notify', message: `Review failed: ${err.message}`, level: 'error' })
  },
  onRecall: (info) => {
    ctx.emit({ type: 'engine_notify', message: `Review cancelled: ${info.reason}`, level: 'info' })
  },
})
```

**Park-on-children (default) vs `detached`.** An asynchronous dispatch holds its *dispatching* agent open by default: when the dispatcher's run ends its turn while this child is still running, the engine parks the dispatcher (status `suspended`, visible in `listDispatchState`) and revives it when the child completes — so the dispatcher consumes the child's result and finishes its own work instead of reporting completion with work still in flight. Pass `detached: true` for genuine fire-and-forget: the parent's run completes at its turn boundary regardless of this child.

**Sub-agent governance.** `allowedSubAgents` is the set of agent names the *dispatched* agent may dispatch in turn (the engine enforces membership on its nested dispatches). `subAgentPolicy` selects the enforcement mode: unset keeps the historic semantics (enforced only when the list is non-empty), `'allowlist'` enforces even an **empty** list (an empty list denies all nested dispatch — how a harness declares a leaf agent), and `'unrestricted'` opts out. The engine's self-dispatch rail applies in every mode.

**Dispatch wait metadata.** `await ctx.listDispatchState()` returns active entries. A suspended entry may carry `waitingOn`: `taskIds` names notifying background Bash tasks; `childDispatchIds` names dispatched children. Both arrays are exact current sets, sorted for stable snapshots. `pendingChildren` remains compatibility-only mirror of child IDs. Absent `waitingOn` means running, or a bare `suspend()` awaiting only a prompt.

```typescript
await ctx.dispatchAgent({
  name: 'ios-dev',            // a leaf specialist
  task: 'Fix the rig assembly',
  allowedSubAgents: [],       // no children...
  subAgentPolicy: 'allowlist' // ...and the empty list is ENFORCED: it may dispatch nothing
})
```

Lifecycle callbacks provide real-time visibility into a dispatched agent's progress. They are observational; engine automatic owner delivery does not depend on them:

- **`onToolStart(info)`** — a tool invocation began in the child session
- **`onToolEnd(info)`** — a tool completed successfully
- **`onToolError(info)`** — a tool completed with an error
- **`onUsage(info)`** — token/cost usage update from the child
- **`onTextDelta(info)`** — streaming text chunk from the child

```typescript
await ctx.dispatchAgent({
  name: 'implementer',
  task: 'Build the feature',
  onToolStart: (info) => log.debug(`tool started: ${info.toolName}`),
  onUsage: (info) => log.debug(`tokens: ${info.cumulativeInputTokens}+${info.cumulativeOutputTokens}`),
  onComplete: (result) => log.info(`done in ${result.elapsed}s, cost $${result.cost}`),
})
```

**`recallAgent(name, opts?)`** -- terminate a running asynchronous dispatch by agent name. Returns `true` if a dispatch was found and recalled, `false` otherwise. The recalled agent's `onRecall` callback fires with the provided reason. Has no effect on foreground dispatches.

```typescript
const found = await ctx.recallAgent('code-reviewer', { reason: 'user requested' })
```

**`ackDispatchLost(dispatchId)`** -- acknowledge durable handling of a `dispatch_lost` notice. The engine re-emits a loss after each engine restart until its consumer acknowledges it, so call this only after your handler has durably handled, delivered, or intentionally ignored the loss. Repeated acknowledgements succeed, making retry safe.

```typescript
ion.on('dispatch_lost', async (ctx, info) => {
  // ...handle the loss...
  await ctx.ackDispatchLost(info.dispatch_id)
})
```

**`llmCall(opts)`** -- run a single-turn, no-tools LLM completion through the engine's provider registry. Resolves with an `LLMCallResult` (text plus token/cost telemetry). This is the lightweight one-shot primitive for extraction, classification, routing, and summarisation prompts — it has no agent loop and no tool access. Going through `llmCall` (rather than calling a provider SDK directly) keeps the call visible to Ion's hook surface (it fires `before_provider_request` once per invocation) and to per-call observability (the `engine_llm_call` event).

```typescript
const { content } = await ctx.llmCall({
  model: 'claude-sonnet-4-6',
  system: 'Classify the message. Reply with one word: bug | feature | question.',
  prompt: userMessage,
  temperature: 0.1,
  jsonMode: false,
})
```

```typescript
interface LLMCallOpts {
  model: string          // required; resolves through the session's provider registry
  system?: string        // optional system prompt
  prompt: string         // required; the single user-role message
  jsonMode?: boolean      // request JSON output (see enforcement note below)
  maxTokens?: number     // response cap; 0 (or omitted) = provider default
  temperature?: number   // sampling temperature; omit for provider default
  signal?: AbortSignal   // optional per-call cancellation
}

interface LLMCallResult {
  content: string        // concatenated assistant text ('' if the model emitted none)
  inputTokens: number    // provider-reported usage
  outputTokens: number
  cost: number           // USD estimate; 0 means "unknown" (model not in registry), not "free"
}
```

**`jsonMode` enforcement is per-provider.** On OpenAI-compatible providers the engine sets `response_format: { type: 'json_object' }`, so the provider guarantees valid JSON. On Anthropic (and any provider with no native request-level JSON switch) the flag is **advisory** — forwarded only in observability metadata — so parse defensively there. The flag is always surfaced on the `engine_llm_call` event regardless of provider.

**`temperature` distinguishes "unset" from an explicit `0`.** Omit the field to request the provider default; pass `0` for fully deterministic sampling. The SDK forwards an internal `temperatureSet` flag alongside the value so the JSON `omitempty` tag does not silently erase a deliberate `0`. Use low values (e.g. `0.1`–`0.2`) for reproducible extraction/classification output.

**`signal` wires per-call cancellation.** When the supplied `AbortSignal` aborts, the engine cancels the in-flight provider request and the returned promise rejects. It composes with session-level abort — either source cancels the call. The signal itself never crosses the wire (it is non-serializable); the SDK translates it into a cancellation notification keyed to the in-flight call.

Useful for: classifying or routing user input before the main turn, extracting structured fields from free text, generating a one-off summary, and any "ask the model a quick question" pattern that should not spin up a full agent loop.

**`getContextUsage()`** -- query the active conversation's current token usage and percent of the model's context window. Returns `null` when no conversation is active (e.g. called from `session_start` before the first prompt). Reads the live counters maintained by the engine's session manager — no socket round-trip is needed for repeated calls within a single hook.

```typescript
ion.on('before_prompt', async (ctx, prompt) => {
  const usage = await ctx.getContextUsage()
  if (usage && usage.percent > 70) {
    ctx.emit({ type: 'engine_notify', message: `Context ${usage.percent}% full`, level: 'warning' })
  }
})
```

Useful for: warning the user before compaction kicks in; downgrading model selection under heavy context pressure; deciding whether to load expensive tools.

**`searchHistory(query, maxResults?)`** -- search the active conversation's persisted message history for content matching `query`. Returns up to `maxResults` matches (engine-capped; pass `0` or omit for the default cap). Returns `[]` when no conversation is active.

```typescript
ion.registerCommand('recall', {
  description: '/recall <query>',
  execute: async (args, ctx) => {
    const matches = await ctx.searchHistory(args, 5)
    ctx.sendMessage(matches.map(m => `[${m.index} ${m.role}] ${m.snippet}`).join('\n'))
  },
})
```

Useful for: recovering details lost to compaction (the persisted log survives compaction; the in-context messages do not), implementing custom recall commands, and building harness-side memory features. Searches the full persisted record, not just the currently-loaded context.

**`getSessionMemory()`** -- returns the current session memory content. Empty string when session memory is not active or no summary has been generated yet. Session memory is a structured summary of earlier conversation maintained in the background by the compaction system.

```typescript
ion.hook('session_compact', async (info, ctx) => {
  const memory = await ctx.getSessionMemory()
  if (memory) {
    // Persist to external knowledge base
    await externalDB.upsert('session-memory', memory)
  }
})
```

Useful for: reading the engine's conversation summary for external persistence, building custom compaction-aware features, and integrating with vector stores or knowledge graphs that need the full session context.

**`setSessionMemory(content)`** -- replaces the session memory with custom content and persists it to disk. Use this to provide your own summarization strategy, overriding the engine's background summarizer.

```typescript
ion.hook('turn_end', async (info, ctx) => {
  const customSummary = await myCustomSummarizer(ctx)
  await ctx.setSessionMemory(customSummary)
})
```

Useful for: replacing the engine's default summarization with a custom strategy (e.g. vector-store-backed, domain-specific extraction, or multi-modal summarization).

**`compact_summary_request` hook** -- substitute a harness-side summariser for the engine's regex fact extractor. The hook fires inside proactive (auto) and reactive (prompt_too_long) compaction, after the session-memory and LLM tiers and before the regex fallback. The handler receives the compaction strategy (`'auto'` or `'reactive'`) and the pre-compaction message slice (already filtered through the boundary firewall so prior summaries are not in scope). Return a non-empty string to short-circuit the regex fallback; return an empty string or skip the return to let the engine fall through to its regex pipeline.

```typescript
ion.hook('compact_summary_request', async (info, ctx) => {
  // info.strategy is 'auto' or 'reactive' — tune the summariser to the
  // trigger. Reactive summaries should be aggressive (fewer tokens)
  // because the provider just rejected the prompt; auto summaries can
  // afford a richer rendering.
  const targetWords = info.strategy === 'reactive' ? 80 : 250
  try {
    const summary = await myLLMSummarizer(info.messages, { targetWords })
    return summary // becomes the compact_boundary block's Summary field
  } catch (err) {
    ctx.log('warn', `compact summary failed, falling back to regex: ${err}`)
    return '' // empty return → engine uses regex fact extractor
  }
})
```

Useful for: replacing the engine's regex fact extractor with an LLM-based summariser, branching summary strategy on the compaction trigger, and integrating with external summarisation services. The engine never blocks on the handler — wrap any LLM call in a bounded timeout and return an empty string on failure rather than throwing or blocking.

**`context_injection` content block** -- the companion block type to `compact_boundary`. A `context_injection` block is inserted into the conversation when the engine performs read-triggered nested context loading (progressive `AGENTS.md`/`ION.md` descent). The block carries a `contextPaths` field -- an array of absolute instruction-file paths -- which is the structural dedup key the nested-context seeder uses to recover which files are already injected. The seeder reads `contextPaths` off typed blocks directly; it never substring-matches the rendered prose of arbitrary message text, so a user message that happens to contain an instruction-file header cannot interfere with the seed. Provider serializers translate the block to a plain text block on the wire (mirroring `compact_boundary`), so the model still sees the rendered context and external wire consumers never observe `contextPaths`.

**LlmContentBlock fields for `context_injection`:**

| Field          | Type       | Description                                                                                           |
|----------------|------------|-------------------------------------------------------------------------------------------------------|
| `type`         | `"context_injection"` | Block discriminator                                                                   |
| `text`         | string     | The rendered context text the model sees (filled by provider serializers from this block)             |
| `contextPaths` | string[]   | Absolute paths of the instruction files injected by this block. Structural dedup key -- not prose.    |

**`elicit(opts)`** -- ask the user a structured question via the connected client. Resolves with the user's response (or a cancellation signal). The engine blocks the calling extension's hook until the user replies or the client times out.

```typescript
ion.registerCommand('rename', {
  description: '/rename <new-title>',
  execute: async (args, ctx) => {
    const reply = await ctx.elicit({
      method: 'input',
      title: 'Confirm tab rename',
      message: `Rename this tab to "${args}"?`,
      schema: { type: 'object', properties: { confirm: { type: 'boolean' } } },
    })
    if (reply.cancelled || !reply.response?.confirm) return
    // proceed
  },
})
```

The wire protocol promotes this to `engine_elicitation_request` / `elicitation_response` so socket-only consumers (desktop, iOS) can present the prompt. See [Server Events](../protocol/server-events.md).

**`suppressTool(name)`** -- hide a built-in tool from the model on the current turn. Resolves when the suppression has been applied. Use sparingly — repeated suppression across turns becomes confusing for the model.

```typescript
// Suppress Bash for a one-off "read-only" turn
await ctx.suppressTool('Bash')
```

**`sandboxWrap(command, profile?)`** -- wrap a shell command in the engine's sandbox runner (per the configured profile). Returns the wrapped command and the sandbox metadata. Useful when an extension needs to spawn a subprocess with the same isolation guarantees that the engine applies to `Bash` calls.

## ToolDef

```typescript
interface ToolDef {
  name: string
  description: string
  parameters: any                    // JSON Schema
  planModeSafe?: boolean             // if true, available during plan mode
  execute: (params: any, ctx: IonContext) => Promise<ToolResult>
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

## Workspace Context

Clients can supply workspace context on `send_prompt` (per-prompt) or on `start_session` (session-wide default) via the `clientWorkspaceContext` field on the client command. The engine routes this context to extensions through two hooks:

- **`system_inject`** with `kind: "workspace_context"` -- the `workspace` field carries a `PromptContext` with structured bench/client data. Return replacement text or `{ suppress: true }` to control what the model sees.
- **`context_inject`** -- the `workspace` field on the payload carries the same `PromptContext`, letting handlers inject additional context entries based on workspace facts.

### ClientWorkspaceContext shape

```typescript
interface ClientWorkspaceContext {
  kind: string         // workspace type (e.g. "worktree", "bench", "project")
  cwd: string          // working directory
  bench?: Record<string, unknown>  // structured bench facts (desktop-specific)
  data?: Record<string, unknown>   // generic consumer-defined data
  text?: string        // pre-rendered prose for the model prompt
}
```

### WorkspacePromptContext (hook payload)

The `workspace` field on `system_inject` and `context_inject` payloads is a `PromptContext`:

```typescript
interface PromptContext {
  kind: string                        // context kind
  cwd: string                         // working directory
  worktree?: WorktreeContext           // engine-owned registry data (when kind is "worktree")
  bench?: Record<string, unknown>     // from ClientWorkspaceContext.bench
  client?: Record<string, unknown>    // from ClientWorkspaceContext.data
}
```

`bench` and `client` are pass-through: whatever the client sends in `ClientWorkspaceContext` arrives here unchanged. Extensions can read them to build workspace-aware behavior without depending on a specific client.

See [client-commands.md](../protocol/client-commands.md) for the wire shape and [engine.json](../configuration/engine-json.md) § `promptContext` for session-wide defaults.

## EngineEvent

Discriminated union of event types the extension can emit. The five named variants give autocomplete on the engine-recognised shapes; the open variant lets harnesses emit custom event types that the engine and desktop bridge pass through verbatim.

```typescript
type EngineEvent =
  | { type: 'engine_agent_state'; agents: any[] }     // complete snapshot — see note below
  | { type: 'engine_status'; fields: any; metadata?: Record<string, unknown> }
  | { type: 'engine_working_message'; message: string; metadata?: Record<string, unknown> }
  | { type: 'engine_notify'; message: string; level: string; metadata?: Record<string, unknown> }
  | { type: 'engine_harness_message'; message: string; source?: string; metadata?: Record<string, unknown> }
  | { type: string; [key: string]: unknown }   // open variant — custom harness events
```

> **`engine_agent_state` is always a complete snapshot.** Every emission replaces the consumer's local view. Include every agent you want visible; consumers do not merge across events. See the [Agent State Contract](../architecture/agent-state.md).

**Pass-through `metadata`.** Four user-visible variants (`engine_harness_message`, `engine_notify`, `engine_working_message`, `engine_status`) carry an optional `metadata` map. The engine treats it as opaque — it forwards the field verbatim to clients and applies no semantics. Clients honor specific conventions; the canonical one today is `metadata.dedupKey` on `engine_harness_message`, which lets the desktop renderer suppress repeated emissions of the same logical message within an engine-instance scrollback (useful for "fire on every `session_start`" patterns like a per-session welcome). See the [well-known metadata keys table](../protocol/server-events.md#well-known-metadata-keys-for-engine_harness_message) in the wire-protocol reference. Pick small structured hints; this field is not a state-transfer channel.

**Custom event types.** Pick a `type` value that won't collide with current or future engine-emitted events. Convention: prefix with the extension or harness name (`jarvis_inbox_update`, `myext_persona_loaded`). The engine validates only `engine_agent_state` payloads; every other type is forwarded to all connected socket clients unchanged. The desktop bridge passes events through without type-based dispatch, so any custom payload your renderers know how to handle is fair game.

```typescript
ctx.emit({ type: 'jarvis_inbox_update', count: 3, source: 'mail' })
```

If a downstream renderer doesn't recognize the type, it's silently dropped — there's no global registry. Build the consumer side alongside the producer.

## DispatchAgentOpts

```typescript
interface DispatchAgentOpts {
  name: string              // agent name (required)
  task: string              // task description (required)
  model?: string            // deterministic extension-selected model; may select another provider
  extensionDir?: string     // extension directory for the child session
  systemPrompt?: string     // injected system prompt
  projectPath?: string      // working directory for the agent
  sessionId?: string        // resume an existing child session
  maxTurns?: number         // cap child agent loop turns (omit or <=0 = unlimited)
  planMode?: boolean        // start child in plan mode
  planFilePath?: string     // override plan file path (default: engine allocates one)
  planModeTools?: string[]  // override allowed tools during plan mode
  waitForCompletion?: boolean // explicit foreground opt-in; default is async
  background?: boolean      // deprecated compatibility input; does not select foreground
  onComplete?: (result: DispatchAgentResult) => void // asynchronous success
  onError?: (err: DispatchError) => void             // asynchronous failure
  onRecall?: (info: RecallInfo) => void               // asynchronous cancellation
  onToolStart?: (info: DispatchToolStartInfo) => void // tool invocation began in child
  onToolEnd?: (info: DispatchToolEndInfo) => void     // tool completed in child
  onToolError?: (info: DispatchToolErrorInfo) => void // tool errored in child
  onUsage?: (info: DispatchUsageInfo) => void         // token/cost usage update
  onTextDelta?: (info: DispatchTextDeltaInfo) => void // streaming text chunks from child
  onPlanProposal?: (info: DispatchPlanProposalInfo) => void // child proposed a plan
}
```

## DispatchAgentResult

```typescript
interface DispatchAgentResult {
  name: string        // agent name; populated on terminal results
  output: string      // terminal output; empty on an asynchronous stub
  exitCode: number    // terminal 0 = success; stub is zero-valued
  elapsed: number     // terminal wall time in seconds
  cost: number        // terminal USD cost
  inputTokens: number
  outputTokens: number
  depthCapExceeded?: boolean // true when engine refused child at depth cap
  remainingDepthBudget?: number // child levels still available from caller
  dispatchId?: string // immediate asynchronous-stub identifier; steer/recall target
  sessionId?: string  // child session ID (for resume)
  planFilePath?: string // plan file written by child (when planMode was true)
  planExited?: boolean  // true when child called ExitPlanMode
}
```

**Depth-cap result.** A refused dispatch resolves normally rather than throwing, with `depthCapExceeded: true` and `remainingDepthBudget: 0`. Inspect these fields before treating a zero-valued result as a launched child. Other results may include `remainingDepthBudget` to expose how many child levels remain under the effective engine cap.

## DispatchError

```typescript
interface DispatchError {
  name: string       // agent name
  message: string    // error description
  exitCode: number   // non-zero
  elapsed: number    // wall time in seconds
}
```

## RecallInfo

```typescript
interface RecallInfo {
  name: string       // agent name
  reason: string     // recall reason
  elapsed: number    // wall time in seconds
  toolCount: number  // tools completed before recall
}
```

## AgentInfo budget

`before_agent_start` receives `AgentInfo.remainingDepthBudget`. It is number of child dispatch levels still available under the effective depth cap for that firing. `0` means this agent may run but cannot create another child. Use it to select work that fits available delegation depth, not as a replacement for handling `DispatchAgentResult.depthCapExceeded` after an attempted dispatch.

## RecallAgentOpts

```typescript
interface RecallAgentOpts {
  reason?: string    // human-readable reason for the recall
}
```

## RegisterAgentToolsOpts

```typescript
interface RegisterAgentToolsOpts {
  filter?: (agent: DiscoveredAgent) => boolean        // filter which agents get dispatch tools
  toolName?: (agent: DiscoveredAgent) => string       // customize tool name (default: dispatch_<name>)
  description?: (agent: DiscoveredAgent) => string    // customize tool description
}
```

## Dispatch Lifecycle Payloads

```typescript
interface DispatchToolStartInfo {
  name: string       // agent name
  toolName: string   // tool being invoked
  toolId: string     // tool call ID
}

interface DispatchToolEndInfo {
  name: string       // agent name
  toolName: string
  toolId: string
  content: string    // tool result content
}

interface DispatchToolErrorInfo {
  name: string       // agent name
  toolName: string
  toolId: string
  content: string    // error content
}

interface DispatchUsageInfo {
  name: string                 // agent name
  inputTokens: number          // per-turn input tokens
  outputTokens: number         // per-turn output tokens
  cumulativeInputTokens: number  // cumulative across dispatch
  cumulativeOutputTokens: number // cumulative across dispatch
  cumulativeCost: number       // cumulative USD cost
}

interface DispatchTextDeltaInfo {
  name: string       // agent name
  delta: string      // new text chunk
  accumulated: string // all text so far
}

interface DispatchPlanProposalInfo {
  name: string          // agent name
  agentId: string       // dispatch-generated agent ID
  planFilePath: string  // absolute path to the plan file
  planSlug: string      // human-readable slug (basename minus .md)
  planRequested: boolean // true when caller set planMode=true; false if child self-initiated
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

## Resource Subsystem

Extensions can declare resource collections and publish changes via the resource API. Resources flow to subscribers over the socket as `engine_resource_snapshot` and `engine_resource_delta` events.

**Global resources** (extension-scoped, not tied to a session):

```typescript
const handle = ion.resources.declare({ kind: 'tasks' })

// Publish a change
handle.publish('update', { id: 'task-1', title: 'New title', conversationId: '' })
```

**Session-scoped resources** (available inside hook and command handlers via `ctx`):

```typescript
const handle = ctx.resources.declare({ kind: 'notifications' })
handle.publish('create', { id: 'n-1', conversationId: ctx.sessionKey })
```

**Query handler** — called when a client subscribes to provide the initial snapshot:

```typescript
// Global query handler
ion.resources.onQuery('tasks', async () => {
  return await db.getAllTasks()  // returns ResourceItem[]
})

// Session-scoped query handler
ctx.resources.onQuery('notifications', async () => {
  return await db.getNotificationsForSession(ctx.sessionKey)
})
```

`declare()` returns a `ResourceHandle`:

```typescript
interface ResourceHandle {
  publish(op: 'create' | 'update' | 'delete' | 'mark_read', item: ResourceItem): void
}
```

## Notifications

Send a push notification through the engine/relay pipeline. Delivery to APNs (iOS) is gated on `push: true` and requires the relay to be connected.

```typescript
ctx.notify({
  kind: 'task_complete',
  title: 'Task finished',
  body: 'The analysis run completed successfully.',
  sound: true,
})
```

**`NotifyOpts`:**

| Field              | Type    | Required | Description                                                        |
|--------------------|---------|----------|--------------------------------------------------------------------|
| `kind`             | string  | yes      | Application-defined notification kind                             |
| `resourceId`       | string  | no       | Resource ID the notification relates to                           |
| `title`            | string  | yes      | Notification title                                                |
| `body`             | string  | yes      | Notification body                                                 |
| `sound`            | boolean | no       | Whether to play a sound on delivery                               |
| `scope`            | string  | no       | Scope hint: `"session"` or `"global"` (default: `"session"`)      |
| `conversationId`   | string  | no       | Conversation ID; routes to session broker when set                |
| `targetSessionKey` | string  | no       | Send to a specific session's subscribers instead of the caller's  |

## Cross-Session Messaging

Extensions can send structured messages to other sessions running the same extension type. The engine enforces same-type-only; cross-type sends return an error to the caller.

**List sessions:**

```typescript
const sessions = await ctx.sessions.list()
// [{ key: 'abc-123', hasActiveRun: true, extensionName: 'my-ext', conversationId: 'conv-1' }]
```

**Send a message:**

```typescript
await ctx.sessions.send('abc-123', 'task_update', { taskId: 't-1', status: 'done' })
```

**Receive messages** — register a handler on the `session_message` hook:

```typescript
ion.on('session_message', (ctx, info) => {
  if (info.kind === 'task_update') {
    // React: emit an event, update local state, or ignore
    ctx.emit({ type: 'engine_notify', message: `Task ${info.payload.taskId} is ${info.payload.status}`, level: 'info' })
  }
})
```

**`SessionListEntry`:**

| Field           | Type    | Description                          |
|-----------------|---------|--------------------------------------|
| `key`           | string  | Session key                          |
| `hasActiveRun`  | boolean | Whether a prompt is being processed  |
| `extensionName` | string  | Name of the extension loaded         |
| `conversationId`| string  | Conversation ID for this session     |

## Intercept

`ctx.intercept` emits an `engine_intercept` event on a session's stream. The engine routes the event and stamps the calling extension's name as the source, so an extension cannot attribute an intercept to another one.

```typescript
await ctx.intercept({
  level: 'redirect',
  title: 'Build is broken on main',
  message: 'Stop and fix the build before continuing.',
})
```

| Field              | Type   | Notes                                                                    |
|--------------------|--------|--------------------------------------------------------------------------|
| `level`            | string | Client hint: `banner` is informational, `redirect` is urgent. The engine does not branch on it. |
| `title`            | string | Short headline. Required.                                                 |
| `message`          | string | Body text. At `redirect` level a client may inject it as a user prompt.   |
| `targetSessionKey` | string | Which session receives the event. Omit to emit on the caller's own.       |
| `metadata`         | object | Opaque map forwarded to clients unchanged.                                |

What a client does with an intercept is that client's policy. The engine emits the typed event once and stops there.

## Session memory

`ctx.getSessionMemory` and `ctx.setSessionMemory` read and replace the conversation's `.memory.md`. This is conversation-scoped state the engine persists alongside the transcript, not cross-session memory — the engine deliberately does not own that.

`setSessionMemory` overwrites. Read first if you mean to append:

```typescript
const existing = await ctx.getSessionMemory()
await ctx.setSessionMemory(`${existing}\n\n- deploy target is staging`)
```

`getSessionMemory` returns an empty string when the conversation has no memory yet, or when the extension is running outside a session (a schedule or webhook firing).

## Interrupted-run recovery

`ctx.setRunRecovery()` sets extension-owned recovery policy for later runs in current session. `enabled` is required by current engines. It remains optional in TypeScript for compatibility with older callers, but an omitted value is rejected by current engines. `maxAttempts` is optional. `0` or omission uses engine default. This policy overrides `start_session` and `engine.json` values. It does not change journal for active run. Recovery applies only after engine process interruption, not provider failures, timeouts, or normal terminal exits.

```typescript
await ctx.setRunRecovery({ enabled: true, maxAttempts: 3 })
```

`before_run_recovery` runs after engine increments durable attempt count and before it resumes journaled root run. Return `action: 'skip'` to abandon recovery. Return `instruction` to replace engine continuation instruction. Empty result leaves engine policy unchanged.

```typescript
ion.on('before_run_recovery', async (_ctx, info) => {
  if (info.attempt > info.maxAttempts) return { action: 'skip' }
  return { instruction: 'Inspect external state before you retry interrupted work.' }
})
```

Recovery resumes durable checkpoint. It does not append original user prompt again. External tool effects interrupted by process loss can be unknown.

## Durable lost-dispatch acknowledgement

`dispatch_lost` can be delivered again after an extension or engine restart until acknowledged. After durably recording recovery work for `info.dispatch_id`, call `await ctx.ackDispatchLost(info.dispatch_id)`. This RPC is retry-safe: repeated calls for same dispatch ID succeed, so retry after transport uncertainty. Acknowledge only after local recovery state is durable.

```typescript
ion.on('dispatch_lost', async (ctx, info) => {
  await persistRecovery(info)
  await ctx.ackDispatchLost(info.dispatch_id)
})
```

## Cross-Instance Dedup (runOnce)

When multiple tabs load the same extension, `ctx.runOnce` ensures an operation runs on exactly one instance. The first instance to call wins; subsequent calls within the debounce window return immediately without executing.

```typescript
const result = await ctx.runOnce('daily-sync', { debounceMs: 60000 }, async () => {
  const data = await fetchExternalData()
  return data.summary
})

if (result.executed) {
  console.log('Sync completed:', result.result)
} else {
  console.log('Skipped:', result.reason) // 'in_progress' | 'debounced' | 'already_ran'
}
```

**`ctx.runOnce<T>(id, opts, fn)`**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Operation identifier. Shared across all instances of this extension. |
| `opts` | `{ debounceMs?: number }` | Minimum interval between executions in milliseconds. Default `60000` (1 minute). |
| `fn` | `() => Promise<T>` | The operation to execute. |

**Returns** `{ executed: true, result: T }` when this instance won the dedup check and `fn` completed, or `{ executed: false, reason: string }` when skipped.

**Failure handling:** If `fn` throws, the lock is released immediately so the next instance can retry without waiting for the debounce window to expire.

## Schedules

Schedules are async triggers — the engine fires them on their configured cadence and delivers a fresh `ctx`, the same way a hook handler gets one. They are registered through `ion.schedule.*`, not through `ion.on(...)`. The full reference is in [Scheduling SDK](scheduling.md); this section covers the complete surface including additive primitives.

### Registration

```typescript
// One fire per day at 09:00 New York time.
await ion.schedule.daily({
  id: 'morning-summary',
  time: '09:00',
  tz: 'America/New_York',
  handler: async (ctx) => {
    await ctx.dispatchAgent({ name: 'summariser', task: 'today' })
  },
})

// One fire per week.
await ion.schedule.weekly({
  id: 'weekly-digest',
  dayOfWeek: 'monday',
  time: '18:00',
  handler: async (ctx) => { /* ... */ },
})

// Repeating on a fixed interval (>= 1000 ms).
await ion.schedule.interval({
  id: 'inbox-poll',
  intervalMs: 30_000,
  handler: async (ctx) => { /* ... */ },
})

// One-shot: fires once after delayMs (>= 1000 ms), then self-deregisters.
await ion.schedule.once({
  id: 'startup-check',
  delayMs: 5_000,
  handler: async (ctx) => {
    await ctx.dispatchAgent({ name: 'checker', task: 'startup diagnostics' })
  },
})
```

All four return a `ScheduleHandle`:

```typescript
interface ScheduleHandle {
  id: string
  unregister(): Promise<void>
}
```

### `ion.schedule.once`

Registers a job that fires exactly once after `delayMs` milliseconds, then the engine removes it automatically. No second fire is possible.

```typescript
interface ScheduleOnce {
  id: string
  delayMs: number         // milliseconds after registration; must be >= 1000
  tz?: string             // IANA timezone; applies to daily/weekly, optional here
  timeoutMs?: number
  concurrency?: 'single' | 'all'
  enabled?: () => boolean | Promise<boolean>
  handler: ScheduleHandler
}
```

**Predicate skip does not spend the shot.** When `enabled` returns `false` at a tick, the once job is skipped for that tick but remains armed. It fires on the next tick where the predicate is true and `delayMs` has elapsed.

**Not persisted across engine restarts.** Like interval jobs, a once job has no catch-up mechanism. Re-arm it in `session_start` if survival across restarts matters.

### `ion.schedule.cancel(id)`

Cancel a registered schedule by its id. Equivalent to calling `ScheduleHandle.unregister()` but works when you have no handle reference (for example, a job registered statically at module scope):

```typescript
await ion.schedule.cancel('my-job-id')
```

Both paths issue the same deregistration RPC and emit `engine_schedule_deregistered`.

### Handler control argument

Every schedule handler receives an optional second argument:

```typescript
type ScheduleHandler = (ctx: IonContext, control?: ScheduleControl) => Promise<void> | void

interface ScheduleControl {
  jobId: string              // the stable id this job was registered under
  unregister(): Promise<void>  // cancel future fires from inside the handler
}
```

Existing handlers that only accept `(ctx)` continue to work unchanged. `control.unregister()` is useful for repeating jobs that want to stop themselves once a condition is met:

```typescript
ion.schedule.interval({
  id: 'wait-for-ready',
  intervalMs: 5_000,
  handler: async (ctx, control) => {
    if (await checkReady()) {
      await doWork(ctx)
      await control!.unregister()
    }
  },
})
```

For once jobs, `control.unregister()` inside the handler is a no-op — the engine auto-deregisters after the handler returns regardless.

### Idle-armed one-shot pattern

Arm a per-session once job on idle, cancel it on the next activity. The cancel-then-once pattern ensures at most one pending shot per session:

```typescript
function idleJobId(sessionKey: string) { return `idle-summary-${sessionKey}` }

ion.on('turn_end', async (ctx) => {
  // Cancel any previous shot, then arm a fresh one.
  await ion.schedule.cancel(idleJobId(ctx.sessionKey))
  await ion.schedule.once({
    id: idleJobId(ctx.sessionKey),
    delayMs: 5 * 60 * 1000,  // 5 minutes; must be >= 1000
    handler: async (handlerCtx) => {
      await handlerCtx.dispatchAgent({
        name: 'summariser',
        task: 'Session has been idle. Summarise what was accomplished.',
      })
    },
  })
})

ion.on('session_end', async (ctx) => {
  await ion.schedule.cancel(idleJobId(ctx.sessionKey))
})
```

### Observability

The scheduler emits `engine_schedule_deregistered` for all deregistration paths: explicit `unregister()` / `cancel()`, handler calling `control.unregister()`, and the automatic once-job teardown after the handler returns. The auto path carries `asyncReason: "once_complete"`. No new event types were introduced.

See [Scheduling SDK](scheduling.md) for the full reference covering catch-up behavior, in-process dedup, `engine.json` configuration, respawn behavior, and the veto-capable lifecycle hooks.
