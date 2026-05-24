// @file-size-exception: SDK public type registry. Single concept (the extension API surface) that extension authors import as one cohesive set; splitting fragments the discoverability of the API.
// Ion Extension SDK -- type definitions.
// All public types and interfaces. Imported by ./runtime.ts and re-exported
// from ./index.ts.

export interface ExtensionConfig {
  extensionDir: string
  model: string
  workingDirectory: string
  mcpConfigPath?: string
}

export interface ProcessInfo {
  name: string
  pid: number
  task: string
  startedAt: string
}

export interface DispatchAgentOpts {
  name: string
  task: string
  model?: string
  extensionDir?: string
  systemPrompt?: string
  projectPath?: string
  sessionId?: string
  /**
   * Cap the child session's agent loop turn count. Omit or pass <= 0 for
   * unlimited (the engine ships unopinionated). Lets harness engineers bound
   * dispatched agent budgets per-call without touching global engine config.
   */
  maxTurns?: number
  onEvent?: (event: EngineEvent) => void
}

export interface DispatchAgentResult {
  output: string
  exitCode: number
  elapsed: number
  cost: number
  inputTokens: number
  outputTokens: number
  sessionId?: string
}

export interface DiscoverAgentsOpts {
  /** Named sources in precedence order (later overrides earlier).
   *  "extension" = {extDir}/agents/, "user" = ~/.ion/agents/, "project" = {cwd}/.ion/agents/
   *  Default: ["extension", "user", "project"] */
  sources?: string[]
  /** Additional directories to scan (appended after named sources) */
  extraDirs?: string[]
  /** Filter to a specific bundle subdirectory (e.g., "cloudops") */
  bundleName?: string
  /** Walk subdirectories. Default true. */
  recursive?: boolean
}

export interface DiscoveredAgent {
  name: string
  path: string
  source: string       // "extension" | "user" | "project" | "extra"
  parent?: string
  description?: string
  model?: string
  tools?: string[]
  systemPrompt?: string
  meta?: Record<string, string>
}

export interface SandboxPattern {
  pattern: string
  reason: string
}

/**
 * Context window usage snapshot for the active run, returned by
 * {@link IonContext.getContextUsage}. Mirrors the Go SDK's `ContextUsage`
 * struct so TS and Go extensions see identical fields.
 *
 * - `percent`: 0-100 fraction of the model's context window consumed.
 *   Capped at 100 even if the heuristic overshoots.
 * - `tokens`: best-known token count of the conversation in the window.
 *   When the most recent API response cached an exact figure, that exact
 *   figure (plus an estimate for any messages added since) is returned;
 *   otherwise a heuristic estimate over all messages is used.
 * - `cost`: cumulative cost in USD for the active run. May be `0` when the
 *   engine has not yet wired cost-tracking into the per-run accessor --
 *   treat as "unknown" until non-zero.
 */
export interface ContextUsage {
  percent: number
  tokens: number
  cost: number
}

/**
 * A single match returned by {@link IonContext.searchHistory}. Mirrors the
 * Go SDK's `HistoryMatch` struct.
 *
 * - `index`: position of the matched message in the conversation's message
 *   array (0-based).
 * - `role`: `"user"`, `"assistant"`, `"tool"`, etc.
 * - `type`: discriminator for the matched content kind -- `"text"` for
 *   message bodies, `"tool_use"` / `"tool_result"` for tool-call segments.
 * - `snippet`: a short excerpt of the matched content with the query
 *   highlighted by context (engine-truncated; do not assume full content).
 * - `toolName` / `toolUseId`: populated when `type` references a tool
 *   segment; absent otherwise.
 */
export interface HistoryMatch {
  index: number
  role: string
  type: string
  snippet: string
  toolName?: string
  toolUseId?: string
}

/**
 * Sandbox profile for {@link IonContext.sandboxWrap}. All fields are optional.
 * - `fsAllowWrite` / `fsDenyWrite` / `fsDenyRead`: filesystem path lists.
 * - `netAllowedDomains` (allowlist) wins over `netBlockedDomains` (blocklist).
 * - `netAllowLocalBind`: permit binding to localhost ports.
 * - `extraPatterns`: additional dangerous-command regexes to reject before wrapping.
 * - `platform`: override target platform (defaults to engine host OS).
 */
export interface SandboxProfile {
  fsAllowWrite?: string[]
  fsDenyWrite?: string[]
  fsDenyRead?: string[]
  netAllowedDomains?: string[]
  netBlockedDomains?: string[]
  netAllowLocalBind?: boolean
  extraPatterns?: SandboxPattern[]
  platform?: 'darwin' | 'linux' | 'windows' | string
}

export interface SandboxWrapResult {
  /** Wrapped command string ready to pass to a shell. */
  wrapped: string
  /** Resolved platform the wrap was generated for. */
  platform: string
}

/**
 * Spec for an LLM-visible agent registered at runtime via
 * {@link IonContext.registerAgentSpec}. Mirrors the markdown frontmatter
 * shape (name, description, model, tools, parent, systemPrompt). Specs
 * persist for the session's lifetime in memory; file persistence is the
 * harness's job.
 */
export interface AgentSpec {
  name: string
  description?: string
  model?: string
  tools?: string[]
  parent?: string
  systemPrompt?: string
}

export interface IonContext {
  /**
   * Identifier of the engine session that fired this hook (the same key
   * clients pass on `start_session` / `send_prompt`). Empty string when the
   * context does not originate from a live session — for example, during
   * extension load before any session is bound.
   *
   * Use this as the key of a module-level `Map` to keep per-session state
   * across hook calls within a single extension subprocess.
   *
   * @example
   * ```ts
   * const intentBySession = new Map<string, string>()
   *
   * ion.on('before_prompt', (ctx, prompt) => {
   *   intentBySession.set(ctx.sessionKey, classify(prompt))
   * })
   *
   * ion.on('model_select', (ctx, info) => {
   *   const intent = intentBySession.get(ctx.sessionKey)
   *   if (intent === 'cloud') return 'claude-sonnet-4-6'
   *   return info.requestedModel
   * })
   * ```
   */
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
  suppressTool(name: string): Promise<void>

  /**
   * Dispatch an extension-initiated tool call through the session's tool
   * registry. The call routes to the same registry the LLM uses: built-in
   * tools (Read, Write, Edit, Bash, Grep, Glob, Agent, ...), MCP-registered
   * tools (`mcp__server__tool` form), and any tool registered by extensions
   * in the loaded group.
   *
   * Subject to the session's permission policy. "deny" decisions resolve
   * with `{ content, isError: true }` and a human-readable reason. "ask"
   * decisions also resolve with `isError: true` because extension calls
   * cannot block on user elicitation -- configure an explicit allow rule
   * for the specific tool/extension combination.
   *
   * Side effects: per-tool hooks (`bash_tool_call`, etc.) and
   * `permission_request` do NOT fire on these calls. Both would re-enter
   * the calling extension and create surprising recursion.
   *
   * Throws when the named tool is not registered (treated as a programming
   * error in the calling extension).
   *
   * @example
   * ```ts
   * ion.registerCommand('recall', {
   *   description: '/recall <query>',
   *   execute: async (args, ctx) => {
   *     const r = await ctx.callTool('memory_recall', { query: args, topK: 5 })
   *     ctx.sendMessage(r.content)
   *   },
   * })
   * ```
   */
  callTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ content: string; isError?: boolean }>

  /**
   * Queue a fresh prompt on this session's agent loop. Returns once the
   * engine has accepted the prompt; does NOT wait for the LLM to finish.
   * Pass `opts.model` to override the model for this single prompt.
   *
   * Slash commands and hook handlers can both call this. Common patterns:
   *   /cloud <message>  -- force remote model + send.
   *   session_start     -- prime the agent with a kickoff prompt.
   *
   * Recursion hazard: calling sendPrompt from inside `before_prompt` (or
   * any pre-prompt hook) triggers a new run, which fires the same hook
   * again. The extension is responsible for guarding its own loops --
   * a per-session "in-flight" flag stored in a `sessionKey`-keyed Map
   * is the canonical pattern.
   *
   * @example
   * ```ts
   * ion.registerCommand('cloud', {
   *   description: '/cloud <message>',
   *   execute: async (args, ctx) => {
   *     await ctx.sendPrompt(args, { model: 'claude-sonnet-4-6' })
   *   },
   * })
   * ```
   */
  sendPrompt(text: string, opts?: SendPromptOpts): Promise<void>
  dispatchAgent(opts: DispatchAgentOpts): Promise<DispatchAgentResult>
  discoverAgents(opts?: DiscoverAgentsOpts): Promise<DiscoveredAgent[]>
  /**
   * Wrap a shell command with platform-appropriate sandbox restrictions.
   * macOS uses `sandbox-exec` (Seatbelt); Linux uses `bwrap` (bubblewrap);
   * Windows uses PowerShell path-restriction checks. Rejects commands that
   * match the engine's dangerous-pattern library before wrapping.
   *
   * @example
   * ```ts
   * ion.on('bash_tool_call', async (ctx, payload) => {
   *   const { wrapped } = await ctx.sandboxWrap(payload.input.command, {
   *     fsAllowWrite: [ctx.cwd],
   *     netAllowedDomains: ['api.example.com'],
   *   })
   *   return { input: { ...payload.input, command: wrapped } }
   * })
   * ```
   */
  sandboxWrap(command: string, profile?: SandboxProfile): Promise<SandboxWrapResult>

  /**
   * Register an LLM-visible agent spec at runtime. The next Agent tool call
   * with `name` matching this spec will dispatch a child session using the
   * spec's `model`, `tools`, and `systemPrompt`.
   *
   * Designed for self-hire flows: a `capability_match` handler proposes a
   * specialist, calls `registerAgentSpec`, and the original Agent tool call
   * resolves on the same dispatch — no retry loop required.
   */
  registerAgentSpec(spec: AgentSpec): Promise<void>

  /**
   * Remove an agent spec previously registered via {@link registerAgentSpec}.
   */
  deregisterAgentSpec(name: string): Promise<void>

  /**
   * Raise an elicitation request. The engine fans out an
   * `engine_elicitation_request` event to every connected client so any
   * front-end (TUI, desktop, Slack bridge, etc.) can render Accept / Edit /
   * Reject UI. The returned Promise resolves when either a client sends an
   * `elicitation_response` command or another extension's
   * `elicitation_request` hook handler returns a non-nil reply.
   *
   * Defaults to a 5-minute timeout on the engine side. Cancelled responses
   * resolve with `{ cancelled: true }`.
   *
   * @example
   * ```ts
   * const reply = await ctx.elicit({
   *   mode: 'approval',
   *   schema: { action: 'register_agent', spec: agentSpec },
   * })
   * if (reply.cancelled) return
   * if (reply.response?.decision === 'accept') {
   *   await registerAgent(agentSpec)
   * }
   * ```
   */
  elicit(opts: ElicitOptions): Promise<ElicitResult>

  /**
   * Return a snapshot of the active run's context window usage, or `null`
   * when no run is active (e.g. the extension is called from a slash
   * command before the first prompt, or from extension load time).
   *
   * Use this to make proactive decisions before the LLM round-trips:
   *   - Skip expensive memory-recall or context-injection steps when the
   *     window is already near capacity.
   *   - Surface a warning event to the user before reactive compaction
   *     fires (which happens at >80%).
   *   - Downgrade model selection under heavy context pressure.
   *
   * @example
   * ```ts
   * ion.on('before_prompt', async (ctx, prompt) => {
   *   const usage = await ctx.getContextUsage()
   *   if (usage && usage.percent > 70) {
   *     ctx.emit({ type: 'engine_notify', message: `Context ${usage.percent}% full`, level: 'warn' })
   *   }
   * })
   * ```
   */
  getContextUsage(): Promise<ContextUsage | null>

  /**
   * Search the active conversation's message history for content matching
   * `query`. Returns up to `maxResults` matches (engine-capped; pass `0`
   * or omit for the default cap). Returns an empty array when no
   * conversation is active.
   *
   * Useful for recovering details lost to compaction -- after a
   * `session_compact`, earlier messages live only in the persisted log;
   * `searchHistory` searches the full persisted record, not just the
   * in-context messages.
   *
   * @example
   * ```ts
   * ion.registerCommand('recall', {
   *   description: '/recall <query>',
   *   execute: async (args, ctx) => {
   *     const matches = await ctx.searchHistory(args, 5)
   *     ctx.sendMessage(matches.map(m => `[${m.index} ${m.role}] ${m.snippet}`).join('\n'))
   *   },
   * })
   * ```
   */
  searchHistory(query: string, maxResults?: number): Promise<HistoryMatch[]>
}

/** Options for {@link IonContext.sendPrompt}. */
export interface SendPromptOpts {
  /** Per-prompt model override. Empty/undefined uses the session default. */
  model?: string
}

export interface ElicitOptions {
  /** Optional client-supplied request id; engine assigns one if omitted. */
  requestId?: string
  /** JSON Schema describing the expected response shape (harness-defined). */
  schema?: Record<string, unknown>
  /** Optional URL clients can deep-link to (web flows). */
  url?: string
  /** Mode label clients use to choose a renderer ("approval", "select", ...) */
  mode?: string
}

export interface ElicitResult {
  /** Response payload from the client or peer extension. */
  response?: Record<string, unknown>
  /** True when the user cancelled or the request timed out. */
  cancelled: boolean
}

/**
 * Events the extension can emit via {@link IonContext.emit}. The five named
 * variants give autocomplete on the common engine-recognised shapes; the
 * open variant lets harnesses define their own event types and emit them
 * verbatim. The engine and the desktop bridge pass unknown types through
 * unchanged, so any custom payload your renderers know how to handle is
 * fair game.
 *
 * Pick a `type` value that won't collide with current or future engine-
 * emitted events. Convention: prefix with your extension name, e.g.
 * `jarvis_inbox_update` or `ion-meta_persona_loaded`.
 */
export type EngineEvent =
  | { type: 'engine_agent_state'; agents: any[] }
  | { type: 'engine_status'; fields: { extensionName?: string; [key: string]: unknown } }
  | { type: 'engine_working_message'; message: string }
  | { type: 'engine_notify'; message: string; level: string }
  | { type: 'engine_harness_message'; message: string; source?: string }
  | { type: string; [key: string]: unknown }

export interface ToolDef {
  name: string
  description: string
  parameters: any // JSON Schema
  execute: (params: any, ctx: IonContext) => Promise<{ content: string; isError?: boolean }>
}

export interface CommandDef {
  description: string
  execute: (args: string, ctx: IonContext) => Promise<void>
}

// ---------------------------------------------------------------------------
// Hook payload types
// ---------------------------------------------------------------------------
// Every hook the engine fires has a typed payload below. Field names match
// the wire format (camelCase for engine-typed structs, snake_case for the
// permission/elicitation/file/task/capability_invoke families that ship over
// JSON-RPC with explicit snake_case tags). The on() overloads further down
// route hook names to these types so handler parameters are inferred.

/** Payload for `tool_call` and `*_tool_call` hooks (block to refuse a call). */
export interface ToolCallInfo {
  toolName: string
  toolId: string
  input: Record<string, unknown>
}

/** Optional return from a `tool_call` handler to block the call. */
export interface ToolCallResult {
  block?: boolean
  reason?: string
}

/** Optional return from a per-tool hook (`bash_tool_call`, etc). */
export interface PerToolCallResult {
  block?: boolean
  reason?: string
  /** Replacement input fields. Engine merges over the original input. */
  mutate?: Record<string, unknown>
}

/** Payload for `tool_start`. */
export interface ToolStartInfo {
  toolName: string
  toolId: string
}

/** Payload for the `tool_result` hook (engine-side ToolResultEntry shape). */
export interface ToolResultInfo {
  tool_use_id: string
  content: string
  is_error?: boolean
}

/** Payload for `on_error`. */
export interface ErrorInfo {
  message: string
  errorCode?: string
  category?:
    | 'tool_error'
    | 'provider_error'
    | 'permission_error'
    | 'mcp_error'
    | 'compaction_error'
  retryable?: boolean
  retryAfterMs?: number
  httpStatus?: number
}

/** Payload for `turn_start` and `turn_end`. */
export interface TurnInfo {
  turnNumber: number
}

/** Payload for `agent_start`, `agent_end`, and `before_agent_start`. */
export interface AgentInfo {
  name: string
  task?: string
}

/**
 * Payload for `before_provider_request`.
 *
 * Fired immediately before each outbound LLM provider request from the agent
 * loop, describing the wire request the engine is about to dispatch. The hook
 * is observe-only — handler return values are ignored.
 *
 * Contract: new fields may be added with safe defaults; existing fields are
 * stable. Mirrors `engine/internal/extension/sdk_hook_types.go::BeforeProviderRequestInfo`.
 */
export interface BeforeProviderRequestInfo {
  /** Provider ID resolved for this request (e.g. "anthropic", "openai"). */
  provider: string
  /** Model name the request will be sent to (post-fallback). */
  model: string
  /** Agent-loop turn number that triggered this request (1-based, matches turn_start). */
  turnNumber: number
  /** Number of messages in the request payload. */
  messageCount: number
  /** Number of tool definitions attached to the request. */
  toolCount: number
  /** True when the request carries a non-empty system prompt. */
  hasSystemPrompt: boolean
  /** Configured response cap; absent or 0 means provider default. */
  maxTokens?: number
}

/** Optional return from `before_agent_start`. */
export interface BeforeAgentStartResult {
  systemPrompt?: string
}

/** Optional return from `before_prompt`. */
export interface BeforePromptResult {
  prompt?: string
  systemPrompt?: string
}

/** Optional return from `plan_mode_prompt`. */
export interface PlanModePromptResult {
  prompt?: string
  tools?: string[]
  /** Custom text for the per-turn sparse reminder; empty/omitted = use engine default. */
  sparseReminder?: string
}

/**
 * A single structured fact extracted from messages that were about to be
 * compacted away. Surfaced on `session_compact` so extensions maintaining
 * external memory (vector store, knowledge graph, SQLite, etc.) can durably
 * persist them before the source messages are discarded.
 *
 * `type` is one of: `decision`, `file_mod`, `error`, `preference`, `discovery`.
 * `content` is a short human-readable snippet (sentence or path).
 */
export interface CompactionFact {
  type: string
  content: string
}

/**
 * Payload passed to `session_before_compact` and `session_compact`.
 * - `strategy`: `auto` (proactive, context > 80%) or `reactive` (API returned prompt_too_long)
 * - `messagesBefore`: message count before compaction
 * - `messagesAfter`: message count after compaction (only set in `session_compact`)
 * - `facts`: structured facts extracted from the pre-compaction message set
 *   (only populated on `session_compact`). May be empty or absent when no
 *   patterns matched. Treat each fact as self-contained — message indices are
 *   intentionally not exposed because they reference messages that no longer
 *   exist after the hook fires.
 */
export interface CompactionInfo {
  strategy: 'auto' | 'reactive'
  messagesBefore: number
  messagesAfter: number
  facts?: CompactionFact[]
}

/** Payload for `session_before_fork` and `session_fork`. */
export interface ForkInfo {
  sourceSessionKey: string
  newSessionKey: string
  forkMessageIndex: number
}

/** Payload for `message_update`. */
export interface MessageUpdateInfo {
  role: string
  content: string
}

/** Payload for `model_select`. */
export interface ModelSelectInfo {
  requestedModel: string
  availableModels?: string[]
}

/** Payload for `context_discover`. */
export interface ContextDiscoverInfo {
  path: string
  source: string
}

/** Payload for `context_load` and `instruction_load`. */
export interface ContextLoadInfo {
  path: string
  content: string
  source: string
}

/** Payload for `context_inject`. */
export interface ContextInjectInfo {
  workingDirectory: string
  discoveredPaths: string[]
}

/** Return value from a `context_inject` handler. */
export interface ContextEntry {
  label: string
  content: string
}

/** Payload for `permission_request`. */
export interface PermissionRequestInfo {
  tool_name: string
  input: Record<string, unknown>
  decision: 'allow' | 'deny' | 'ask' | string
  rule_name?: string
  /**
   * Tier label assigned by the classifier (built-in `SAFE` / `UNSAFE`, or any
   * label returned by a `permission_classify` handler). Empty when the
   * classifier did not run for this tool.
   */
  tier?: string
}

/** Payload for `permission_denied`. */
export interface PermissionDeniedInfo {
  tool_name: string
  input: Record<string, unknown>
  reason: string
}

/**
 * Payload for `permission_classify`. Return a tier label string from the
 * handler to label the tool call (e.g., `SAFE`, `LOW`, `MEDIUM`, `HIGH`,
 * `CRITICAL` — whatever taxonomy your harness defines). The first non-empty
 * label wins. If no handler returns a label, the engine's built-in classifier
 * runs and emits `SAFE` or `UNSAFE`.
 */
export interface PermissionClassifyInfo {
  tool_name: string
  input: Record<string, unknown>
}

/**
 * Payload for `file_changed`.
 *
 * Fires only after the LLM's Write or Edit tool successfully writes a file.
 * This is NOT a filesystem watcher: external edits (user saving in their
 * editor, shell scripts, MCP servers) do NOT trigger it. For external-edit
 * notifications subscribe to `workspace_file_changed` instead.
 */
export interface FileChangedInfo {
  path: string
  action: string
}

/**
 * Payload for `workspace_file_changed`.
 *
 * Fires whenever a non-ignored file or directory inside the session's
 * working directory is created, modified, or deleted by anything (including
 * the LLM, the user's editor, shell scripts). Backed by an engine-owned
 * recursive fsnotify watcher rooted at `EngineConfig.workingDirectory`.
 *
 * - `path` is the absolute, OS-native path.
 * - `relPath` is forward-slash separated and relative to the working
 *   directory, so glob-matching is portable.
 * - `action` is one of `"create"`, `"modify"`, `"delete"`. Rename is
 *   reported as a paired delete + create -- cross-editor rename detection
 *   is unreliable.
 *
 * Out-of-tree paths are NOT covered. Extensions that need to watch paths
 * outside the working directory install their own watchers via
 * `node:fs.watch` inside their subprocess.
 */
export interface WorkspaceFileChangedInfo {
  path: string
  relPath: string
  action: string
}

/** Payload for `task_created` and `task_completed`. */
export interface TaskLifecycleInfo {
  task_id: string
  name?: string
  status?: string
  extra?: Record<string, unknown>
}

/** Payload for `elicitation_request`. */
export interface ElicitationRequestInfo {
  request_id: string
  schema?: Record<string, unknown>
  url?: string
  mode: string
}

/** Payload for `elicitation_result`. */
export interface ElicitationResultInfo {
  request_id: string
  response?: Record<string, unknown>
  cancelled: boolean
}

/** Payload for `capability_match`. */
export interface CapabilityMatchInfo {
  input: string
  capabilities: string[]
}

/** Optional return value from `capability_match`. */
export interface CapabilityMatchResult {
  matchedIds: string[]
  args?: Record<string, unknown>
}

/** Payload for `capability_invoke`. */
export interface CapabilityInvokeInfo {
  capability_id: string
  input: Record<string, unknown>
}

/**
 * Payload for `extension_respawned` -- fires on the new instance after the
 * engine auto-respawns a crashed subprocess. Lets the harness rebuild
 * caches or re-acquire resources lost when the prior instance died.
 */
export interface ExtensionRespawnedInfo {
  attemptNumber: number
  prevExitCode?: number | null
  prevSignal?: string
}

/**
 * Payload for `turn_aborted` -- fires on the new instance when the prior
 * subprocess died with a turn in flight. Reset any per-turn state since
 * the turn's hook lifecycle was interrupted.
 */
export interface TurnAbortedInfo {
  reason: 'extension_died'
}

/**
 * Payload for `peer_extension_died` and `peer_extension_respawned` -- fire
 * on every Host in the group except the one that changed state. Useful
 * for multi-extension coordination.
 */
export interface PeerExtensionInfo {
  name: string
  exitCode?: number | null
  signal?: string
  attemptNumber?: number
}

/**
 * Payload for the `before_plan_mode_enter` hook. Fired when the LLM calls
 * the EnterPlanMode tool (or any future mechanism that requests a
 * model-initiated transition into plan mode). Handlers may return a
 * {@link BeforePlanModeEnterResult} to deny the transition; the default is
 * allow.
 *
 * Mirrors `extension.PlanModeEnterInfo` in the Go SDK.
 */
export interface PlanModeEnterInfo {
  /**
   * Identifies what triggered the request. `"model_tool"` when the LLM
   * called the EnterPlanMode sentinel tool directly.
   */
  source: string
}

/**
 * Optional return value from a `before_plan_mode_enter` handler. A handler
 * that returns `undefined` (or omits `allow`) defers to the engine default
 * (allow). The last non-nil `allow` across all hosts wins (last-writer
 * semantics).
 */
export interface BeforePlanModeEnterResult {
  /**
   * Controls whether plan mode entry is permitted. `undefined` / `null`
   * defers to the engine default (allow). `true` explicitly allows.
   * `false` denies.
   */
  allow?: boolean | null
  /**
   * Optional human-readable explanation returned to the LLM in the tool
   * result when `allow` is `false`.
   */
  reason?: string
}

/**
 * Payload for the `before_plan_mode_exit` hook. Fired when the LLM calls
 * the ExitPlanMode sentinel tool, before the run is terminated and the
 * plan-ready card is surfaced to the user. Handlers may return a
 * {@link BeforePlanModeExitResult} to veto the exit (e.g. send the model
 * back for more planning) or to allow it.
 */
export interface BeforePlanModeExitInfo {
  /** Path of the plan file being submitted for review. */
  planFilePath: string
  /** Always `"model_tool"` today; future kinds may include `"extension"`. */
  source: string
}

/**
 * Optional return value from a `before_plan_mode_exit` handler. A handler
 * that returns `undefined` (or omits `allow`) defers to the engine default
 * (allow). The last non-nil `allow` across all hosts wins.
 */
export interface BeforePlanModeExitResult {
  /**
   * Controls whether the plan-mode exit proceeds. `undefined` / `null`
   * defers to the default (allow). `false` denies (keeps the model in
   * plan mode).
   */
  allow?: boolean | null
  /**
   * Returned to the LLM in the tool result when `allow` is `false`,
   * explaining why the exit was denied and what the model should do
   * next.
   */
  reason?: string
}

/**
 * Payload for the `before_early_stop_decision` hook. Fires after the
 * model emits `end_turn` / `stop` and after the engine has updated its
 * cumulative output-token counter, but **before** it evaluates the
 * continuation criteria.
 *
 * Mirrors `extension.EarlyStopDecisionInfo` in the Go SDK. See the
 * [Early-Stop Continuation](../hooks/reference.md) section and
 * [ADR-002](../architecture/adr/002-engine-vs-harness-early-stop.md).
 */
export interface EarlyStopDecisionInfo {
  /** Engine-issued request ID for this run. */
  runId: string
  /** Model identifier that just stopped. */
  model: string
  /** Turn that ended (1-based, matches `turn_start`). */
  turnNumber: number
  /**
   * Provider-reported stop reason that triggered this decision
   * (`"end_turn"` or `"stop"`). Always non-empty.
   */
  stopReason: string
  /**
   * Running total of output tokens across every turn of this run
   * (including the turn that just ended).
   */
  cumulativeOutputTokens: number
  /**
   * Effective output-token budget for this run after engine-config +
   * RunOptions merging (before any handler override).
   */
  budget: number
  /** Effective completion-threshold percent. */
  thresholdPct: number
  /**
   * Number of times the engine has already nudged the model on this run
   * (0 before the first nudge).
   */
  continuationCount: number
  /** Configured cap. */
  maxContinuations: number
  /**
   * Output-token delta from the previous continuation (0 on the first
   * decision). Used by the diminishing-returns guard.
   */
  lastContinuationDelta: number
  /**
   * Engine's tentative verdict before this hook runs. Handlers may flip
   * it via {@link EarlyStopDecisionResult.forceContinue}.
   */
  wouldContinue: boolean
  /**
   * True when this run is a child agent dispatched by the Agent tool.
   * The engine defaults the feature off for subagents; the hook still
   * fires so harness can force-on with `forceContinue: true`.
   */
  isSubagent?: boolean
}

/**
 * Optional return value from a `before_early_stop_decision` handler. Any
 * combination of fields may be set; omitted / `undefined` values mean
 * "defer to the engine's decision." The last non-nil result across hosts
 * wins for each individual field.
 */
export interface EarlyStopDecisionResult {
  /**
   * Overrides the engine's verdict. `true` forces a continuation (even
   * if `wouldContinue=false`); `false` forces a stop (even if
   * `wouldContinue=true`). `undefined` / `null` defers to engine logic.
   */
  forceContinue?: boolean | null
  /**
   * Bumps (or shrinks) the effective output-token budget for the
   * remainder of the run. `0` / omitted means "no override." Useful when
   * scope expands mid-run.
   */
  overrideBudget?: number
  /**
   * Adjusts the completion threshold for the remainder of the run.
   * `0` / omitted means "no override."
   */
  overrideThresholdPct?: number
  /**
   * Replaces the default continuation prompt text. Empty / omitted means
   * "use the engine's default phrasing." Per ADR-002 the engine ships
   * no default text — at least one handler in the chain (or the
   * wire-protocol responder) must supply one for any injection to fire.
   */
  continueMessage?: string
}

/**
 * Payload for the `early_stop_continued` hook. Fires after the engine
 * has decided to continue, the message has been written, and the loop
 * is about to start a new turn. Observe-only — return values are
 * ignored.
 */
export interface EarlyStopContinuedInfo {
  /** Engine-issued request ID for this run. */
  runId: string
  /**
   * Turn that just ended (the new turn has not started yet).
   */
  turnNumber: number
  /** New continuation count after this nudge (1-based). */
  continuationCount: number
  /** Percent-of-budget the model reached before stopping. */
  pct: number
  /** Running total across the run. */
  cumulativeOutputTokens: number
  /**
   * Effective budget at the moment of injection (after any
   * `overrideBudget` from a `before_early_stop_decision` handler).
   */
  budget: number
  /**
   * Final continuation prompt text that landed in the conversation
   * (after `system_inject` rewrites). Empty when the downstream
   * `system_inject` hook suppressed the injection.
   */
  injectedText: string
}

/**
 * Payload for the `system_inject` hook. Fired before the engine injects
 * a system message into the conversation. Handlers can rewrite the text
 * or suppress the injection entirely by returning a
 * {@link SystemInjectResult}.
 *
 * The `kind` field discriminates the injection reason. Known kinds:
 * `"plan_mode_reminder"`, `"turn_limit_warning"`, `"max_token_continue"`,
 * `"early_stop_continue"`. Unknown kinds should be treated as
 * forward-compatible.
 */
export interface SystemInjectInfo {
  /** Discriminator for the injection reason. */
  kind: string
  /** Engine's default injection text. May be empty (e.g. early-stop). */
  defaultText: string
  /** Current turn number. */
  turn: number
  /** Configured max turns (0 = unlimited). */
  maxTurns: number
}

/**
 * Optional return value from a `system_inject` handler.
 */
export interface SystemInjectResult {
  /**
   * Replacement text. Empty / omitted means "use the default."
   */
  text?: string
  /**
   * `true` cancels the injection entirely. The engine logs the
   * suppression and does not write the message to the conversation. For
   * `early_stop_continue` specifically, suppression also prevents the
   * re-run-turn loop.
   */
  suppress?: boolean
}

/**
 * Map of hook name -> payload type. Used by the {@link IonSDK.on} overloads
 * to give handlers strongly-typed `payload` parameters when the hook name is
 * a string literal. Hooks that fire with no payload map to `void`.
 */
export interface HookPayloadMap {
  // Lifecycle (13)
  session_start: void
  session_end: void
  before_prompt: string
  turn_start: TurnInfo
  turn_end: TurnInfo
  message_start: void
  message_end: void
  tool_start: ToolStartInfo
  tool_end: void
  tool_call: ToolCallInfo
  on_error: ErrorInfo
  agent_start: AgentInfo
  agent_end: AgentInfo

  // Session (5)
  session_before_compact: CompactionInfo
  session_compact: CompactionInfo
  session_before_fork: ForkInfo
  session_fork: ForkInfo
  session_before_switch: void

  // Pre-action (2)
  before_agent_start: AgentInfo
  before_provider_request: BeforeProviderRequestInfo

  // Content (7)
  context: unknown
  message_update: MessageUpdateInfo
  tool_result: ToolResultInfo
  input: string
  model_select: ModelSelectInfo
  user_bash: string
  plan_mode_prompt: string

  // Per-tool call (7) -- payload is the tool's raw input map
  bash_tool_call: Record<string, unknown>
  read_tool_call: Record<string, unknown>
  write_tool_call: Record<string, unknown>
  edit_tool_call: Record<string, unknown>
  grep_tool_call: Record<string, unknown>
  glob_tool_call: Record<string, unknown>
  agent_tool_call: Record<string, unknown>

  // Per-tool result (7) -- payload is the engine ToolResultEntry shape
  bash_tool_result: ToolResultInfo
  read_tool_result: ToolResultInfo
  write_tool_result: ToolResultInfo
  edit_tool_result: ToolResultInfo
  grep_tool_result: ToolResultInfo
  glob_tool_result: ToolResultInfo
  agent_tool_result: ToolResultInfo

  // Context (3)
  context_discover: ContextDiscoverInfo
  context_load: ContextLoadInfo
  instruction_load: ContextLoadInfo

  // Permission (3 — including the new pluggable classifier)
  permission_request: PermissionRequestInfo
  permission_denied: PermissionDeniedInfo
  permission_classify: PermissionClassifyInfo

  // File (1)
  file_changed: FileChangedInfo
  workspace_file_changed: WorkspaceFileChangedInfo

  // Task (2)
  task_created: TaskLifecycleInfo
  task_completed: TaskLifecycleInfo

  // Elicitation (2)
  elicitation_request: ElicitationRequestInfo
  elicitation_result: ElicitationResultInfo

  // Context inject (1)
  context_inject: ContextInjectInfo

  // Capability (3)
  capability_discover: void
  capability_match: CapabilityMatchInfo
  capability_invoke: CapabilityInvokeInfo

  // Extension lifecycle (4)
  extension_respawned: ExtensionRespawnedInfo
  turn_aborted: TurnAbortedInfo
  peer_extension_died: PeerExtensionInfo
  peer_extension_respawned: PeerExtensionInfo

  // Plan mode (3) -- workflow + state transitions on the plan-mode lifecycle.
  // See docs/architecture/adr/003-state-events-vs-workflow-events.md for the
  // state-vs-workflow distinction these hooks live alongside.
  before_plan_mode_enter: PlanModeEnterInfo
  before_plan_mode_exit: BeforePlanModeExitInfo

  // System inject (1) -- fired before the engine injects any system message.
  // The `kind` discriminator carries the reason (plan_mode_reminder,
  // turn_limit_warning, max_token_continue, early_stop_continue).
  system_inject: SystemInjectInfo

  // Early-stop continuation (2) -- engine provides the mechanism, harness
  // owns the policy and the prompt text. See
  // docs/architecture/adr/002-engine-vs-harness-early-stop.md.
  before_early_stop_decision: EarlyStopDecisionInfo
  early_stop_continued: EarlyStopContinuedInfo
}

/** Convenience type: union of all hook names. */
export type HookName = keyof HookPayloadMap

/**
 * Handler signature for a hook with payload type `P`. Return value is
 * hook-specific — most hooks ignore it; some (like `before_prompt`,
 * `tool_call`, `permission_classify`) interpret the return as policy.
 * See `docs/hooks/reference.md` for return semantics per hook.
 */
export type HookHandler<P> = (
  ctx: IonContext,
  payload: P,
) => unknown | Promise<unknown>

export interface IonSDK {
  /**
   * Register a hook handler. The `payload` parameter type is inferred from
   * the hook name when you pass a string literal.
   *
   * @example
   * ```ts
   * ion.on('session_before_compact', (ctx, info) => {
   *   // info: CompactionInfo
   *   if (info.strategy === 'reactive') { ... }
   *   return false // return true to cancel engine compaction
   * })
   *
   * ion.on('tool_call', (ctx, info) => {
   *   // info: ToolCallInfo
   *   if (info.toolName === 'Bash' && /rm -rf/.test(String(info.input.command))) {
   *     return { block: true, reason: 'destructive command' }
   *   }
   * })
   *
   * ion.on('permission_classify', (ctx, info) => {
   *   // info: PermissionClassifyInfo -- return a tier label
   *   if (info.tool_name === 'Bash') return 'HIGH'
   *   return 'SAFE'
   * })
   *
   * ion.on('extension_respawned', (ctx, info) => {
   *   // info: ExtensionRespawnedInfo
   *   log.info(`respawn (attempt ${info.attemptNumber})`)
   * })
   * ```
   *
   * See `docs/hooks/reference.md` for the complete hook list (59 total).
   */
  on<K extends HookName>(hook: K, handler: HookHandler<HookPayloadMap[K]>): void
  on(hook: string, handler: HookHandler<any>): void
  registerTool(def: ToolDef): void
  registerCommand(name: string, def: CommandDef): void
}
