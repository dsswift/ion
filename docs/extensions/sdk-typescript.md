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

**`dispatchAgent(opts)`** -- dispatch an engine-native agent. In the default (foreground) mode, blocks until the agent completes and returns a `DispatchAgentResult`.

```typescript
const result = await ctx.dispatchAgent({
  name: 'researcher',
  task: 'Find all TODO comments in the codebase',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a research agent. Be thorough.',
  projectPath: ctx.cwd
})
// { name: 'researcher', output: '...', exitCode: 0, elapsed: 8.3, cost: 0.012, ... }
```

Pass `background: true` to run the agent asynchronously. The promise resolves immediately with a stub result; the terminal outcome is delivered via `onComplete`, `onError`, or `onRecall` callbacks:

```typescript
await ctx.dispatchAgent({
  name: 'code-reviewer',
  task: 'Review the latest changes',
  background: true,
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

Lifecycle callbacks provide real-time visibility into a dispatched agent's progress. They fire for both foreground and background dispatches:

- **`onToolStart(info)`** — a tool invocation began in the child session
- **`onToolEnd(info)`** — a tool completed successfully
- **`onToolError(info)`** — a tool completed with an error
- **`onUsage(info)`** — token/cost usage update from the child
- **`onTextDelta(info)`** — streaming text chunk from the child

```typescript
await ctx.dispatchAgent({
  name: 'implementer',
  task: 'Build the feature',
  background: true,
  onToolStart: (info) => log.debug(`tool started: ${info.toolName}`),
  onUsage: (info) => log.debug(`tokens: ${info.cumulativeInputTokens}+${info.cumulativeOutputTokens}`),
  onComplete: (result) => log.info(`done in ${result.elapsed}s, cost $${result.cost}`),
})
```

**`recallAgent(name, opts?)`** -- terminate a running background dispatch by agent name. Returns `true` if a dispatch was found and recalled, `false` otherwise. The recalled agent's `onRecall` callback fires with the provided reason. Has no effect on foreground dispatches.

```typescript
const found = await ctx.recallAgent('code-reviewer', { reason: 'user requested' })
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
  | { type: 'engine_agent_state'; agents: any[] }     // complete snapshot — see note below
  | { type: 'engine_status'; fields: any; metadata?: Record<string, unknown> }
  | { type: 'engine_working_message'; message: string; metadata?: Record<string, unknown> }
  | { type: 'engine_notify'; message: string; level: string; metadata?: Record<string, unknown> }
  | { type: 'engine_harness_message'; message: string; source?: string; metadata?: Record<string, unknown> }
  | { type: string; [key: string]: unknown }   // open variant — custom harness events
```

> **`engine_agent_state` is always a complete snapshot.** Every emission replaces the consumer's local view. Include every agent you want visible; consumers do not merge across events. See the [Agent State Contract](../architecture/agent-state.md).

**Pass-through `metadata`.** Four user-visible variants (`engine_harness_message`, `engine_notify`, `engine_working_message`, `engine_status`) carry an optional `metadata` map. The engine treats it as opaque — it forwards the field verbatim to clients and applies no semantics. Clients honor specific conventions; the canonical one today is `metadata.dedupKey` on `engine_harness_message`, which lets the desktop renderer suppress repeated emissions of the same logical message within an engine-instance scrollback (useful for "fire on every `session_start`" patterns like ion-meta's welcome). See the [well-known metadata keys table](../protocol/server-events.md#well-known-metadata-keys-for-engine_harness_message) in the wire-protocol reference. Pick small structured hints; this field is not a state-transfer channel.

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
  sessionId?: string        // resume an existing child session
  maxTurns?: number         // cap child agent loop turns (omit or <=0 = unlimited)
  planMode?: boolean        // start child in plan mode
  planFilePath?: string     // override plan file path (default: engine allocates one)
  planModeTools?: string[]  // override allowed tools during plan mode
  background?: boolean      // run async; return stub result immediately
  onComplete?: (result: DispatchAgentResult) => void   // background: success
  onError?: (err: DispatchError) => void               // background: failure
  onRecall?: (info: RecallInfo) => void                 // background: cancelled
  onToolStart?: (info: DispatchToolStartInfo) => void   // tool invocation began in child
  onToolEnd?: (info: DispatchToolEndInfo) => void       // tool completed in child
  onToolError?: (info: DispatchToolErrorInfo) => void   // tool errored in child
  onUsage?: (info: DispatchUsageInfo) => void           // token/cost usage update
  onTextDelta?: (info: DispatchTextDeltaInfo) => void   // streaming text chunks from child
  onPlanProposal?: (info: DispatchPlanProposalInfo) => void  // child proposed a plan
}
```

## DispatchAgentResult

```typescript
interface DispatchAgentResult {
  name: string        // agent name
  output: string      // agent's final output text
  exitCode: number    // 0 = success
  elapsed: number     // wall time in seconds
  cost: number        // USD cost
  inputTokens: number
  outputTokens: number
  sessionId?: string  // child session ID (for resume)
  planFilePath?: string  // plan file written by child (when planMode was true)
  planExited?: boolean   // true when child called ExitPlanMode
}
```

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

The intercept API emits an `engine_intercept` event on a target session's stream. The TypeScript SDK does not yet expose a convenience method for `ctx.intercept`; use the raw JSON-RPC method `ext/intercept` directly. See the [raw protocol docs](sdk-raw.md#extintercept) for the request shape.

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
