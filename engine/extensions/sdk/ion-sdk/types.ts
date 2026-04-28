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
  | { type: 'engine_status'; fields: any }
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
}

/**
 * Payload passed to `session_before_compact` and `session_compact`.
 * - `strategy`: `auto` (proactive, context > 80%) or `reactive` (API returned prompt_too_long)
 * - `messagesBefore`: message count before compaction
 * - `messagesAfter`: message count after compaction (only set in `session_compact`)
 */
export interface CompactionInfo {
  strategy: 'auto' | 'reactive'
  messagesBefore: number
  messagesAfter: number
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

/** Payload for `file_changed`. */
export interface FileChangedInfo {
  path: string
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
  before_provider_request: unknown

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
