// @file-size-exception: SDK public type registry. Single concept (the extension API surface) that extension authors import as one cohesive set; splitting fragments the discoverability of the API.
// Ion Extension SDK -- type definitions.
// All public types and interfaces. Imported by ./runtime.ts and re-exported
// from ./index.ts.

import type { DispatchControlContext } from './types-dispatch-control'

export interface ExtensionConfig {
  extensionDir: string
  model: string
  workingDirectory: string
  mcpConfigPath?: string
  buildIdentity?: string
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
  /**
   * Deterministic extension-selected model. Extensions may select another
   * provider; model-authored Agent tool requests cannot.
   */
  model?: string
  /**
   * Extension to load into the child session so the child receives the
   * extension's hooks, persona composition, AND its registered tools
   * (including this extension's own dispatch tool, enabling n-tier
   * delegation). Accepts a directory (resolved to the conventional entry
   * point: extension.ts, index.ts, extension.js, index.js, extension.mjs,
   * index.mjs — first match wins) or a direct entry-point file path.
   * Pass `ctx.config.extensionDir` to give the child the same extension
   * as the dispatcher.
   */
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
  /**
   * Overrides the engine-config dispatch-depth cap for this dispatch tree.
   * When > 0, the child and its descendants use this cap instead of the
   * global config value; omit or pass <= 0 to use the engine default. Lets a
   * caller grant one dispatch tree more (or fewer) nesting levels without
   * changing the engine-wide cap.
   */
  maxDispatchDepth?: number
  /**
   * Declares whether this dispatch is expected to produce work — that is, to
   * call at least one tool. Tri-state:
   *
   * - `undefined` — no expectation declared. The engine reports
   *   {@link DispatchAgentResult.toolCount} and never judges it. This is the
   *   default, so existing callers keep today's behavior exactly.
   * - `true` — a completion with zero tool calls is not success. The engine
   *   gives the child ONE continuation naming the expectation; if the second
   *   attempt also calls no tools the dispatch reports exit code 3 (declined)
   *   and its delivered status is `declined`, distinct from both `completed`
   *   and `failed`.
   * - `false` — explicitly exempt. Analysis, summarization, and advisory
   *   dispatches legitimately produce text and call nothing.
   *
   * Declare this on execution dispatches (implement, edit, fix, refactor) and
   * leave it unset on planning, review, and summarization dispatches. The
   * engine never infers the expectation from task text: only the caller knows
   * which kind of dispatch it issued.
   */
  requireToolUse?: boolean
  onEvent?: (event: EngineEvent) => void

  // --- Async dispatch ---

  /**
   * Dispatches run asynchronously by default. Set this to true only when the
   * caller needs terminal child output before continuing. Foreground dispatch
   * does not deliver terminal lifecycle callbacks.
   */
  waitForCompletion?: boolean

  /**
   * Legacy compatibility flag. Dispatch is asynchronous regardless of this
   * value; set `waitForCompletion: true` for explicit foreground dispatch.
   * @deprecated Use `waitForCompletion`.
   */
  background?: boolean

  /**
   * Reserved for raw-protocol clients. The TypeScript runtime replaces any
   * caller-supplied value with a unique token for each dispatch.
   */
  callbackId?: string

  /**
   * Fires when an asynchronous dispatch finishes successfully (exit code 0).
   * Not called for foreground dispatches.
   */
  onComplete?: (result: DispatchAgentResult) => void

  /**
   * Fires when an asynchronous dispatch finishes with an error (non-zero exit
   * code or child error). Not called for foreground dispatches.
   */
  onError?: (err: DispatchError) => void

  /**
   * Fires when an asynchronous dispatch is cancelled via
   * {@link IonContext.recallDispatch}. Not called for foreground dispatches.
   */
  onRecall?: (info: RecallInfo) => void

  // --- Lifecycle event callbacks ---

  /**
   * Fires when the dispatched agent begins a tool invocation. Delivers
   * structured data parsed from the child session's ToolCallEvent.
   */
  onToolStart?: (info: DispatchToolStartInfo) => void

  /**
   * Fires when a dispatched agent's tool invocation completes successfully
   * (isError=false on the ToolResultEvent).
   */
  onToolEnd?: (info: DispatchToolEndInfo) => void

  /**
   * Fires when a dispatched agent's tool invocation completes with an error
   * (isError=true on the ToolResultEvent).
   */
  onToolError?: (info: DispatchToolErrorInfo) => void

  /**
   * Fires when the dispatched agent emits a usage event, carrying both
   * per-turn usage and cumulative totals across the dispatch.
   */
  onUsage?: (info: DispatchUsageInfo) => void

  /**
   * Fires when the dispatched agent emits a text chunk, carrying the delta
   * and accumulated text so far.
   */
  onTextDelta?: (info: DispatchTextDeltaInfo) => void

  // --- Plan mode ---

  /**
   * When true, starts the child session in plan mode. The child receives a
   * plan-mode-filtered tool set and the ExitPlanMode sentinel tool. When the
   * child calls ExitPlanMode, the run terminates with the plan file path in
   * the result (DispatchAgentResult.planFilePath, planExited=true).
   */
  planMode?: boolean

  /**
   * Overrides the plan file path for the child session. When empty and
   * planMode is true, the engine allocates a fresh plan file with a
   * word-slug name (the default behavior for any plan-mode session).
   */
  planFilePath?: string

  /**
   * Overrides the set of allowed tools during plan mode for the child
   * session. When nil/empty and planMode is true, the engine uses the
   * default plan-mode tool set.
   */
  planModeTools?: string[]

  /**
   * Restricts the child session's tool set for the entire dispatch (not just
   * plan mode). When non-empty, the child runs with exactly this allowlist;
   * when empty the child inherits the engine's default tool set (no
   * restriction). Use it to scope a dispatched agent to a narrow remit.
   * Distinct from planModeTools, which applies only while in plan mode.
   */
  allowedTools?: string[]

  /**
   * The set of agent names this dispatch's agent is permitted to dispatch in
   * turn. The engine enforces it as an allowlist: when non-empty, a nested
   * dispatch whose name is not a member is rejected. When empty/unset the
   * allowlist layer is inert -- but the engine's self-dispatch rail (an agent
   * may not dispatch its own name) still applies regardless. The harness owns
   * this: it knows its agent graph (e.g. a lead's parent-derived children) and
   * passes the permitted set per dispatch. See `subAgentPolicy` to make an
   * EMPTY list mean "may dispatch nothing" instead of "unrestricted".
   */
  allowedSubAgents?: string[]

  /**
   * How `allowedSubAgents` is enforced for this dispatch's own nested
   * dispatches:
   *
   * - unset — historic semantics: the allowlist is enforced only when
   *   non-empty (an empty list means no restriction).
   * - `'allowlist'` — membership is enforced even when the list is empty: an
   *   empty `allowedSubAgents` denies ALL nested dispatch. This is how a
   *   harness expresses "this agent is a leaf and may dispatch nothing",
   *   which the historic semantics cannot say — under them a leaf handed an
   *   empty list could dispatch anything (including re-dispatching its own
   *   lead into the depth cap).
   * - `'unrestricted'` — explicitly opt out of the allowlist layer (the
   *   self-dispatch rail still applies).
   */
  subAgentPolicy?: 'allowlist' | 'unrestricted'

  /**
   * Excludes this asynchronous dispatch from its PARENT's park-on-children set. By
   * default (false/unset) a background dispatch holds its dispatcher open:
   * when the dispatcher's run ends its turn with this child still running,
   * the engine parks the dispatcher (status `suspended`) and revives it when
   * the child completes, so the dispatcher consumes the child's result and
   * finishes its own work instead of reporting completion with work still in
   * flight. Set `detached: true` for genuine fire-and-forget: the parent's
   * run completes at its turn boundary regardless of this child, and the
   * child's completion routes wherever your lifecycle callbacks send it.
   */
  detached?: boolean

  /**
   * Marks this dispatch as the "implement" half of a plan-then-implement
   * flow: the plan is already approved and the child must execute it
   * directly. When true, the engine skips injecting the EnterPlanMode
   * sentinel tool into the child run, so the child can never stall by
   * proposing plan mode mid-implementation. Set this on every dispatch that
   * hands over an approved plan or a pre-investigated execute-mode brief.
   */
  implementationPhase?: boolean

  /**
   * Removes the named tools from the child session's tool set. Unlike
   * allowedTools (a whitelist replacing the default set), this is a targeted
   * blacklist layered on top of whatever set the child would otherwise get.
   * Canonical use: suppress the engine's built-in Agent tool in children
   * whose delegation must route through the harness's own dispatch tool, so
   * the child cannot bypass the harness's tier resolution and allowlists.
   */
  suppressTools?: string[]

  /**
   * Ordered list of alternative model IDs the child run's retry loop walks
   * when the primary model is overloaded (typically the tail of a resolved
   * tier chain). When empty, the child relies only on the engine's default
   * model for the unresolvable-model case.
   */
  fallbackChain?: string[]

  /**
   * Overrides the human-readable label shown on the dispatched agent's pill.
   * When empty, the engine resolves a display name from the matched agent
   * spec's description, then the extension roster, then the agent name.
   */
  displayName?: string

  /**
   * Fires when the dispatched agent calls ExitPlanMode, proposing a plan
   * for approval. Observational: the plan proposal event is always
   * forwarded to the parent session via onEvent regardless of whether this
   * callback is set.
   */
  onPlanProposal?: (info: DispatchPlanProposalInfo) => void

  /**
   * Fires when a dispatched child calls AskUserQuestion. The dispatcher
   * receives the question, answers it, and the child run CONTINUES.
   * Return { answer: string } to resume the child; { cancelled: true }
   * to let the child terminate; omit for default termination behavior.
   */
  onChildQuestion?: (info: DispatchChildQuestionInfo) => Promise<DispatchChildQuestionAnswer>

  /**
   * Per-dispatch context-layer override (level 4 of the four-level context
   * cascade). Overrides the session default (set via
   * {@link IonContext.setDispatchContextDefaults}), the engine.json
   * dispatchContext config, and the built-in default (all layers on). Tri-state
   * fields: omit a field to inherit from the level below.
   */
  contextPolicy?: ContextPolicy
}

/**
 * Controls which context layers a dispatched agent receives. All fields are
 * tri-state (undefined = inherit from the level above).
 */
export interface ContextPolicy {
  /** Include home roots (~/.ion, ~/.claude under compat). Default: true. */
  includeGlobalContext?: boolean
  /** Include the child's cwd + ancestor walk. Default: true. */
  includeProjectContext?: boolean
  /** Override ClaudeCompat for this walk. Default: inherit from engine. */
  claudeCompat?: boolean
  /**
   * Cap total injected context-file bytes for this dispatch. Omit or pass <= 0
   * for no cap. Files are included WHOLE, nearest-first (cwd, then ancestors,
   * then home roots), until the budget is spent; the remainder are skipped and
   * each is logged by name. A file is never truncated mid-content.
   *
   * Context injection repeats full file content on every dispatch, so a large
   * global instruction file is a recurring per-dispatch cost paid before the
   * task text. Set this on fan-out dispatches where the child only needs its
   * own repo's guidance.
   */
  maxContextBytes?: number
}

/** A single context file discovered during a walk. */
export interface DiscoveredContext {
  path: string
  content: string
  source: 'global' | 'project' | 'parent' | 'include'
  level: number
}

/** Options for {@link IonContext.walkContextFiles}. */
export interface WalkContextFilesOpts {
  cwd?: string
  includeGlobal?: boolean
  includeProject?: boolean
  claudeCompat?: boolean
}

export interface DispatchAgentResult {
  name: string
  output: string
  exitCode: number
  elapsed: number
  cost: number
  inputTokens: number
  outputTokens: number
  /** SDK-generated identifier for routing pre-stub callbacks. Internal to extension-host RPC. */
  callbackId?: string
  /** True when engine refused to launch child at dispatch-depth cap. */
  depthCapExceeded?: boolean
  /** Remaining child levels available from caller at dispatch-depth cap. */
  remainingDepthBudget?: number
  /** Engine-assigned unique identifier for this dispatch instance. Collision-safe. */
  dispatchId?: string
  sessionId?: string
  /**
   * The absolute path of the plan file written by the child session. Non-empty
   * only when the child was in plan mode and wrote a plan (regardless of whether
   * it called ExitPlanMode).
   */
  planFilePath?: string
  /**
   * True when the child called ExitPlanMode (the run terminated because the
   * model proposed a plan for approval). When false and planFilePath is
   * non-empty, the child was in plan mode but finished without proposing
   * (e.g. hit max turns or was recalled).
   */
  planExited?: boolean
}

/** Describes a failed asynchronous dispatch. Delivered via {@link DispatchAgentOpts.onError}. */
export interface DispatchError {
  name: string
  callbackId?: string
  dispatchId?: string
  message: string
  exitCode: number
  elapsed: number
}

/** Describes a recalled (cancelled) asynchronous dispatch. Delivered via {@link DispatchAgentOpts.onRecall}. */
export interface RecallInfo {
  name: string
  callbackId?: string
  dispatchId?: string
  reason: string
  elapsed: number
  toolCount: number
}

/**
 * Semantic classification of an engine-side injected turn.
 *
 * The engine publishes the classification and derives a `machineAuthored`
 * flag from it; it never dictates what a consumer does with either. Whether a
 * machine-authored turn is hidden, dimmed, or rendered verbatim is the
 * consumer's policy.
 *
 * - `agent_completion` — a dispatch callback: a child agent's result routed
 *   back to the parent that dispatched it.
 * - `slash_command` — the expanded body of a slash command whose display turn
 *   is persisted separately as the raw invocation.
 * - `background_task_completion` — a finished background bash command's
 *   result, routed back to wake a parked session.
 * - `checkin` — a scheduled heartbeat delivered to a session that went idle
 *   with work still running.
 * - `revive` — waking an idle session for a reason that is neither a
 *   completion payload nor a periodic check-in.
 * - `steer` — a message steered onto a live run. Not machine-authored by
 *   default: the common case is a human typing mid-turn.
 *
 * The union stays open (`| string`) so a consumer may define its own kinds.
 * The engine treats a kind it does not recognise as user-authored, because it
 * cannot vouch for a classification it did not make.
 */
export type InjectionKind =
  | 'agent_completion'
  | 'slash_command'
  | 'background_task_completion'
  | 'checkin'
  | 'revive'
  | 'steer'
  | string

/** Options for {@link IonContext.steerSelf}. */
export interface SteerSelfOpts {
  /**
   * Classification for the injected turn. Supply this for any
   * machine-to-machine message; omit it only when the message genuinely is a
   * user turn.
   */
  kind?: InjectionKind
}

/** Result of {@link IonContext.steerDispatch} and {@link IonContext.steerSelf}. */
export interface SteerDispatchResult {
  /** True when the message reached a run (steered or sent). */
  delivered: boolean
  /**
   * Delivery verdict. `steerDispatch` returns one of 'delivered',
   * 'channel_full', 'no_run', 'not_found'. `steerSelf` returns 'steered'
   * (injected onto a live owning run) or 'sent' (owning run was idle, so the
   * message was delivered as a fresh prompt).
   */
  outcome: 'delivered' | 'channel_full' | 'no_run' | 'not_found' | 'steered' | 'sent'
}

// --- Dispatch lifecycle callback payloads ---

/** Payload for {@link DispatchAgentOpts.onToolStart}. */
export interface DispatchToolStartInfo {
  name: string
  callbackId?: string
  toolName: string
  toolId: string
}

/** Payload for {@link DispatchAgentOpts.onToolEnd}. */
export interface DispatchToolEndInfo {
  name: string
  callbackId?: string
  toolName: string
  toolId: string
  content: string
}

/** Payload for {@link DispatchAgentOpts.onToolError}. */
export interface DispatchToolErrorInfo {
  name: string
  callbackId?: string
  toolName: string
  toolId: string
  content: string
}

/** Payload for {@link DispatchAgentOpts.onUsage}. */
export interface DispatchUsageInfo {
  name: string
  callbackId?: string
  /** Per-turn input tokens from the current UsageEvent. */
  inputTokens: number
  /** Per-turn output tokens from the current UsageEvent. */
  outputTokens: number
  /** Cumulative input tokens across all turns in this dispatch. */
  cumulativeInputTokens: number
  /** Cumulative output tokens across all turns in this dispatch. */
  cumulativeOutputTokens: number
  /** Cumulative USD cost across all turns. Updated from TaskCompleteEvent. */
  cumulativeCost: number
}

/** Payload for {@link DispatchAgentOpts.onTextDelta}. */
export interface DispatchTextDeltaInfo {
  name: string
  callbackId?: string
  /** The new text chunk. */
  delta: string
  /** All text accumulated so far across the dispatch. */
  accumulated: string
}

/**
 * Payload for {@link DispatchAgentOpts.onPlanProposal}.
 *
 * Mirrors the Go DispatchPlanProposalInfo struct (sdk_types.go). Fires when
 * the dispatched agent calls ExitPlanMode, signalling that a plan has been
 * written and is ready for orchestrator review or surfacing to the user.
 */
export interface DispatchPlanProposalInfo {
  /** Canonical agent name (the name field from DispatchAgentOpts). */
  name: string
  callbackId?: string
  /** Engine-assigned dispatch ID for this dispatch instance. */
  agentId: string
  /** Absolute filesystem path of the plan markdown file. */
  planFilePath: string
  /** Human-readable slug portion of the plan file path (basename without extension). */
  planSlug: string
  /**
   * True when the caller explicitly set planMode=true on the dispatch opts.
   * False when the child agent self-initiated plan mode (called EnterPlanMode
   * without being told to).
   */
  planRequested: boolean
}

/**
 * Payload for {@link DispatchAgentOpts.onChildQuestion}.
 *
 * Mirrors the Go DispatchChildQuestionInfo struct (sdk_types.go). Carries the
 * question raised by a dispatched child via AskUserQuestion. The dispatcher
 * answers it (resuming the child) or escalates/declines.
 */
export interface DispatchChildQuestionInfo {
  /** Canonical agent name (the name field from DispatchAgentOpts). */
  name: string
  callbackId?: string
  /** Engine-assigned dispatch ID for this dispatch instance. */
  dispatchId: string
  /**
   * Engine-assigned request ID unique within this dispatch. Keyed together
   * with dispatchId on the engine's pending reply channel so a single dispatch
   * can ask multiple sequential questions without collisions. The SDK runtime
   * sends this back via ext/answer_dispatch_question to unblock the child.
   */
  requestId: string
  /** The text from the child's AskUserQuestion call. */
  question: string
  /** Dispatch nesting depth of the child (1 = direct child of orchestrator). */
  depth: number
}

/**
 * Return value of {@link DispatchAgentOpts.onChildQuestion}.
 *
 * Return `{ answer }` to resume the child with that answer injected as the
 * AskUserQuestion tool result. Return `{ cancelled: true }` to let the child
 * run terminate. Returning an empty object resumes the child with a
 * best-judgment placeholder.
 */
export interface DispatchChildQuestionAnswer {
  answer?: string
  cancelled?: boolean
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

/** Options for {@link IonSDK.registerAgentTools}. All fields are optional. */
export interface RegisterAgentToolsOpts {
  /** Filter which agents get dispatch tools. Default: agents with a parent
   *  (excludes root orchestrators). */
  filter?: (agent: DiscoveredAgent) => boolean
  /** Customize the tool name. Default: `dispatch_<name>` with hyphens→underscores. */
  toolName?: (agent: DiscoveredAgent) => string
  /** Customize the tool description. Default: "Dispatch the <description> specialist". */
  description?: (agent: DiscoveredAgent) => string
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
 * A single in-flight dispatch entry returned by {@link IonContext.listDispatchState}.
 *
 * - `dispatchId`: collision-safe unique ID for this dispatch instance. Use this
 *   to address {@link IonContext.recallDispatch} / {@link IonContext.steerDispatch}
 *   when multiple dispatches of the same agent name may be running.
 * - `name`: the agent name (e.g. `"code-reviewer"`).
 * - `status`: `"running"` for an actively working dispatch, `"suspended"` for
 *   a parked one (waiting on child dispatches or a revive message — alive,
 *   not terminal). Terminal entries are deregistered on completion and absent
 *   from the snapshot.
 * - `parentDispatchId`: the dispatch ID of the parent that spawned this dispatch.
 *   Empty for top-level dispatches (depth 1) whose parent is the depth-0
 *   orchestrator (which has no dispatch ID).
 * - `depth`: nesting depth. `1` = direct child of the orchestrator, `2` =
 *   grandchild, etc.
 * - `startedAt`: UTC ISO-8601 timestamp (RFC3339Nano) when the dispatch was
 *   registered in the engine registry.
 * - `elapsedMs`: milliseconds elapsed since `startedAt` at snapshot time.
 * - `toolCount`: cumulative tool calls the dispatched child has executed.
 * - `lastWork`: truncated most-recent activity snippet (streamed text or
 *   `"Using <tool>..."`).
 * - `lastActivityMs`: milliseconds since the child's last observed event at
 *   snapshot time — THE liveness discriminator. Small and stable means the
 *   child is producing right now; large and growing means it is wedged. `0`
 *   means no activity observed yet (child still starting).
 * - `childConversationId`: the child session's conversation ID once known.
 *   Read the child's live transcript (or harvest partial work) from the
 *   conversation store by this ID.
 * - `waitingOn`: complete async work set holding a suspended dispatch parked.
 *   `taskIds` are notifying Bash tasks; `childDispatchIds` are child dispatches.
 * - `pendingChildren`: compatibility projection of `waitingOn.childDispatchIds`.
 */
export interface DispatchEntry {
  dispatchId: string
  name: string
  status: 'running' | 'suspended'
  parentDispatchId?: string
  depth: number
  startedAt: string
  elapsedMs: number
  toolCount: number
  lastWork?: string
  lastActivityMs: number
  childConversationId?: string
  pendingChildren?: string[]
  waitingOn?: DispatchWaitingOn
}

/** Complete task and child wait metadata for a parked dispatch. */
export interface DispatchWaitingOn {
  taskIds?: string[]
  childDispatchIds?: string[]
}

/**
 * Options for {@link IonContext.llmCall}. The lightweight one-shot
 * inference primitive — a single round-trip to the provider with no
 * tools, no agent loop, no fallback chain.
 *
 * Designed for harness-internal extraction / classification / routing
 * prompts that previously had to bypass Ion entirely (direct provider
 * HTTP) to avoid the cost of a full {@link IonContext.dispatchAgent}.
 * Going through `llmCall` keeps these calls visible to Ion's hook
 * surface (notably `before_provider_request`) and to per-call
 * observability (`engine_llm_call` event).
 *
 * - `model`: the model to call. Required. Resolves through the same
 *   provider registry the agent loop uses, so any model the session
 *   can dispatch is callable here.
 * - `system`: optional system prompt. Omit for none.
 * - `prompt`: the single user-role message. Required.
 * - `jsonMode`: request JSON-formatted output. Enforcement is per-provider:
 *   on OpenAI-compatible providers the engine sets
 *   `response_format: { type: 'json_object' }` so valid JSON is guaranteed;
 *   on Anthropic (and any provider with no native request-level JSON switch)
 *   it remains advisory — forwarded only in observability metadata — so parse
 *   defensively there. The flag is always surfaced on `engine_llm_call`.
 * - `maxTokens`: response cap (0 = provider default).
 * - `temperature`: sampling temperature for deterministic extraction /
 *   classification / routing (e.g. 0.1–0.2). When omitted the provider
 *   default applies. `0` is a valid, meaningful value (fully deterministic)
 *   and is forwarded as-is — omitting the field is how you request the
 *   provider default.
 * - `signal`: optional AbortSignal for per-call cancellation. When the signal
 *   aborts, the engine cancels the in-flight provider request and the
 *   returned promise rejects. The signal also composes with session-level
 *   abort: either cancels the call.
 */
export interface LLMCallOpts {
  model: string
  system?: string
  prompt: string
  jsonMode?: boolean
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

/**
 * Result from {@link IonContext.llmCall}. Carries the model's text
 * response plus token / cost telemetry mirroring the data the engine
 * emits on the `engine_llm_call` observability event.
 *
 * - `content`: the concatenated assistant text. Empty when the model
 *   produced no text output (rare; llmCall has no tools to call so
 *   tool_use-only completions yield empty content).
 * - `inputTokens` / `outputTokens`: provider-reported usage.
 * - `cost`: USD cost estimate via the model registry. `0` when the
 *   model is not in the registry (e.g. a custom model without cost
 *   metadata) — treat as "unknown" not "free".
 */
export interface LLMCallResult {
  content: string
  inputTokens: number
  outputTokens: number
  cost: number
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
 * Options for {@link IonContext.intercept}. The engine routes the resulting
 * `engine_intercept` event and stamps the source; how a client reacts is that
 * client's policy, not something the engine enforces.
 */
export interface InterceptOpts {
  /**
   * Client hint about severity. "banner" is informational and
   * non-disruptive; "redirect" is urgent and a client may abort the run and
   * re-prompt. The engine does not validate or branch on this value.
   */
  level: 'banner' | 'redirect' | string
  /** Short headline. Required. */
  title: string
  /**
   * Body content. At "redirect" level a client may use this as the injected
   * user prompt if it chooses to redirect.
   */
  message?: string
  /**
   * Which session receives the event. Empty emits on the caller's own
   * session.
   */
  targetSessionKey?: string
  /** Opaque map forwarded to clients unchanged. */
  metadata?: Record<string, unknown>
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

/**
 * Options for a pre-authenticated HTTP request (see {@link IonContext.http}).
 */
export interface IonHttpRequestOptions {
  /** Downstream resource scope for the minted token (e.g.
   *  `api://<app-id>/Billing.Read`). Omit for the base grant's scope. */
  scope?: string
  /** Explicit audience/resource for the minted token, for identity
   *  providers that bind grants to one (Auth0, RFC 8707) instead of
   *  encoding the resource in the scope string. Omit to use the
   *  provider's configured default audience. */
  audience?: string
  /** AWS service name for Signature V4 authentication (for example `s3`,
   *  `execute-api`, or `dynamodb`). Setting this selects the engine-owned AWS
   *  credential provider instead of OAuth bearer authentication. */
  awsService?: string
  /** AWS region used in the SigV4 credential scope. Required with awsService. */
  awsRegion?: string
  /** Request headers. `Authorization` is reserved and overwritten by the
   *  engine-owned bearer token or SigV4 signature. */
  headers?: Record<string, string>
  /** Request body, sent verbatim. */
  body?: string
  /** Request deadline in milliseconds (default 30 000). */
  timeoutMs?: number
  /** Response size cap in bytes (default 5 MB). */
  maxBytes?: number
  /** Opt this request out of the private/reserved-address guard to reach
   *  intranet APIs. Default false. */
  allowPrivateNetwork?: boolean
}

/** Response from a pre-authenticated HTTP request. Carries no token. */
export interface IonHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** Pre-authenticated HTTP surface (see {@link IonContext.http}). */
export interface IonHttp {
  request(method: string, url: string, opts?: IonHttpRequestOptions): Promise<IonHttpResponse>
  get(url: string, opts?: IonHttpRequestOptions): Promise<IonHttpResponse>
  post(url: string, opts?: IonHttpRequestOptions): Promise<IonHttpResponse>
  put(url: string, opts?: IonHttpRequestOptions): Promise<IonHttpResponse>
  patch(url: string, opts?: IonHttpRequestOptions): Promise<IonHttpResponse>
  delete(url: string, opts?: IonHttpRequestOptions): Promise<IonHttpResponse>
}

export interface EmbeddedResource {
  uri?: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface ToolAnnotations {
  audience?: string[]
  priority?: number
  lastModified?: string
}

/** One ordered typed item from an MCP tool result. Binary data stays base64. */
export interface ToolContent {
  type: string
  text?: string
  data?: string
  mimeType?: string
  resource?: EmbeddedResource
  uri?: string
  name?: string
  title?: string
  description?: string
  size?: number
  annotations?: ToolAnnotations
  unknown?: unknown
}

/** Result from `ctx.callTool` or an extension tool handler. */
export interface ToolResult {
  content: string
  isError?: boolean
  contentItems?: ToolContent[]
}

export interface IonContext extends DispatchControlContext {
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
  /** Durable conversation identity ({unix_millis}-{hex}). Stable across
   *  engine restarts. Use this for resource scoping, audit trails, and
   *  persistent identity. Empty when no conversation is active. */
  conversationId: string
  /**
   * Identifies the prompt-to-completion run in flight when the hook fired.
   * Empty (`''`) when no run is active — `session_start`, a schedule or
   * webhook delivery, extension load.
   *
   * This is the engine-native run identity: the same value that appears as
   * `run_id` in Ion's own logs and telemetry, so it is the key to join your
   * extension's records against the engine's. For distributed tracing across
   * process boundaries use {@link IonContext.traceId} instead — run IDs are
   * not W3C-shaped.
   */
  runId: string
  /**
   * W3C trace-context trace-id of the run in flight: 32 lowercase hex
   * characters, scoped to ONE prompt-to-completion run. Empty (`''`) when no
   * run is active.
   *
   * Every engine log line and telemetry event emitted during the run carries
   * this same value, so spans you export correlate with Ion's own records.
   * Place it directly in a `traceparent` header on a downstream call and the
   * whole chain — prompt, engine, your API, its dependencies — lands in one
   * trace in any OTLP backend (Application Insights `operation_Id`, Jaeger,
   * Tempo, ...):
   *
   * ```ts
   * ion.on('tool_call', async (ctx, info) => {
   *   const spanId = randomBytes(8).toString('hex') // your span, your id
   *   await ctx.http.post('https://api.example.com/v1/work', {
   *     scope: 'api://my-api/Work.Write',
   *     headers: { traceparent: `00-${ctx.traceId}-${spanId}-01` },
   *     body: JSON.stringify({ task: info.input }),
   *   })
   * })
   * ```
   *
   * Scope is the run, not the session or conversation, because a trace
   * represents one logical transaction. For long-lived correlation use
   * {@link IonContext.conversationId}; for the engine session use
   * {@link IonContext.sessionKey}.
   */
  traceId: string
  /**
   * Dispatch depth of the session that fired the hook: `0` for the root
   * (orchestrator) session, `1` for a directly dispatched child agent,
   * `2` for a grandchild, and so on.
   *
   * This is the explicit root-vs-child discriminator for hooks whose
   * payload carries no agent identity — `session_start`, `session_end`,
   * `turn_start` and friends. A handler that should only act for the root
   * session (a greeting toast, a startup git sync, a one-time bootstrap)
   * branches on `ctx.depth === 0`. Mirrors `AgentInfo.isRoot` on
   * `before_agent_start`, which discriminates per-firing rather than
   * per-session.
   *
   * @example
   * ```ts
   * ion.on('session_start', (ctx) => {
   *   if (ctx.depth > 0) return // dispatched child — skip root-only bootstrap
   *   ctx.emit({ type: 'engine_notify', message: 'harness online', level: 'info' })
   * })
   * ```
   */
  depth: number
  /** Dispatch ID owning this context. Empty for the root session
   *  (`depth === 0`); populated for child sessions with the ID minted when
   *  the agent was spawned, so per-dispatch state can be keyed without
   *  inventing a session-local identity. */
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
  ): Promise<ToolResult>

  /**
   * Pre-authenticated outbound HTTP using the configured operator or machine
   * identity.
   *
   * For OAuth/OIDC sources, the engine injects an `Authorization: Bearer`
   * header carrying an access token minted for the declared `scope` and
   * `audience`. For native AWS workload identities, set `awsService` and
   * `awsRegion`; the engine acquires temporary credentials and signs the
   * request with Signature V4. Raw credentials are NEVER exposed to extension
   * code: request options contain no credential and responses contain only
   * status/headers/body. Any `Authorization` header supplied by the extension
   * is overwritten. Extensions needing unauthenticated HTTP should use plain
   * fetch or WebFetch; this surface always authenticates.
   *
   * `scope` names the downstream resource (e.g.
   * `api://<app-id>/Billing.Read`); omit it to use the base grant's scope.
   * Requests to private/reserved addresses are blocked by default; set
   * `allowPrivateNetwork: true` per request to reach intranet APIs.
   *
   * Fails when no compatible identity provider is configured under
   * `auth.identityProvider` in engine.json.
   *
   * @example
   * ```ts
   * const res = await ctx.http.post('https://api.example.com/v1/items', {
   *   scope: 'api://my-api/Items.Write',
   *   headers: { 'Content-Type': 'application/json' },
   *   body: JSON.stringify({ name: 'widget' }),
   * })
   * if (res.status === 201) ctx.sendMessage('created')
   * ```
   */
  http: IonHttp

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

  /**
   * End the LLM run for this dispatch without completing it. The agent goes
   * idle/suspended in the UI and the parent's OnComplete does NOT fire. The
   * dispatch stays alive; when a revive message arrives via sendPrompt (from
   * a child agent's completion callback or any other source), the LLM run
   * restarts with the updated conversation context.
   *
   * Use `suspend()` when you have dispatched a single background child and
   * have nothing more to do until it completes. Use `suspendUntilAll()` for
   * N-child fan-out (or use the dispatch_agents tool which calls it for you).
   *
   * At depth 0 this parks the ROOT session on its outstanding background bash
   * commands instead — the same thing the engine does automatically at a turn
   * boundary, exposed so an extension can end the orchestrator's turn
   * deliberately. The root's run exits fully rather than parking a live
   * goroutine, and it is revived by a NEW run when a command completes (see
   * ADR-023). It throws at depth 0 when there is no active run to park, or no
   * outstanding notifying background commands to park on — parking with
   * nothing to wait for would strand the session.
   */
  suspend(): Promise<void>

  /**
   * Like `suspend()` but waits for ALL listed child dispatches to complete
   * before reviving. Each completion decrements the pending set; the run
   * revives only when the set empties.
   *
   * Used internally by the `dispatch_agents` fan-out tool; prefer that tool
   * over calling `suspendUntilAll()` directly for parallel fan-out.
   */
  suspendUntilAll(dispatchIds: string[]): Promise<void>

  dispatchAgent(opts: DispatchAgentOpts): Promise<DispatchAgentResult>

  /**
   * Walk context files (read-only). Returns discovered AGENTS.md/ION.md/
   * CLAUDE.md files for the given cwd. Does not inject — use it in
   * before_agent_start to compose custom context. Part of the four-level
   * context cascade seam (see docs/context-loading.md).
   */
  walkContextFiles(opts?: WalkContextFilesOpts): Promise<DiscoveredContext[]>

  /**
   * Set the session-level default context policy for all subsequent dispatches
   * (level 3 of the four-level cascade). A per-dispatch
   * {@link DispatchAgentOpts.contextPolicy} overrides it.
   */
  setDispatchContextDefaults(policy: ContextPolicy): Promise<void>


  /**
   * Deliver a steering message to a running asynchronous dispatch. The message
   * is injected into the child's conversation as a user message at the next
   * run-loop checkpoint, reusing the existing steer channel mechanism.
   *
   * @param dispatchId - The dispatch ID returned by {@link IonContext.dispatchAgent}.
   * @param message - The steering message to inject.
   * @returns A result describing the delivery outcome.
   */
  steerDispatch(dispatchId: string, message: string): Promise<SteerDispatchResult>
  /**
   * Deliver a steering message to a running asynchronous dispatch identified by
   * its agent **name**. This is the name-based peer of {@link steerDispatch}:
   * where `steerDispatch` requires the full collision-safe dispatch ID returned
   * by {@link dispatchAgent}, `steerDispatchByName` resolves by the
   * human-readable agent name (e.g. `'code-reviewer'`). When multiple
   * dispatches share a name, the first one found is steered (non-deterministic
   * order, matching {@link recallDispatch}'s name-based semantics). Use
   * {@link steerDispatch} when the exact dispatch ID is available for precise
   * targeting.
   *
   * @param name    - The agent name as registered (e.g. `'code-reviewer'`).
   * @param message - The steering message to inject.
   * @returns A result describing the delivery outcome.
   */
  steerDispatchByName(name: string, message: string): Promise<SteerDispatchResult>
  /**
   * Answer a pending child dispatch question raised via AskUserQuestion.
   * Normally called by the SDK runtime on the dispatcher's behalf after the
   * `onChildQuestion` callback resolves; harnesses implementing custom
   * dispatch wiring may call it directly.
   *
   * @param dispatchId - The dispatch ID of the child that asked.
   * @param requestId  - The engine-assigned id echoed from the question event.
   * @param answer     - The answer to inject as the child's tool result, or
   *                     undefined to let the engine use a best-judgment placeholder.
   * @param cancelled  - When true, the child run terminates instead of resuming.
   */
  answerDispatchQuestion(dispatchId: string, requestId: string, answer: string | undefined, cancelled: boolean): Promise<void>
  /** Acknowledge durable delivery of a lost-dispatch notice. */
  ackDispatchLost(dispatchId: string): Promise<void>
  /**
   * Deliver a message to the run that OWNS this context, letting the engine
   * pick the mechanism based on that run's live state:
   *
   * - If the owning run is live, the message is steered onto it and surfaces
   *   at the next run-loop checkpoint (mid-turn). Outcome: `'steered'`.
   * - If the owning run is idle, the message is sent as a fresh prompt via the
   *   normal prompt path. Outcome: `'sent'`. The engine emits additive
   *   `engine_steer_degraded` and persists a steer marker on this arm.
   *
   * `engine_steer_injected` remains exclusive to a live run-loop checkpoint
   * draining a steer before the next LLM call. Consumers that render delivery
   * confirmation can render both events similarly, but their distinct types
   * preserve whether a live run actually consumed the message.
   *
   * Use this to bubble an asynchronous dispatch's completion back to the
   * dispatching agent without polling: a busy parent is steered immediately
   * instead of the completion queueing behind its live run until it goes idle.
   * Depth-aware — at depth 0 the owning run is the session's main loop; at
   * depth N it is this dispatch's own child run. The engine resolves the run;
   * the caller never names it.
   *
   * Pass `opts.kind` whenever the message is machine-to-machine (a dispatch
   * completion, a scheduled check-in, a revive). The engine threads the kind
   * through BOTH delivery arms and marks the turn machine-authored, so
   * consumers can classify it. Omitting the kind on a machine message leaves
   * the turn indistinguishable from something the user typed, and every client
   * renders it as a user bubble.
   *
   * @param message - The message to deliver to the owning run.
   * @param opts    - Optional classification for the injected turn.
   * @returns A result describing the delivery outcome (`'steered'` or `'sent'`).
   */
  steerSelf(message: string, opts?: SteerSelfOpts): Promise<SteerDispatchResult>
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
   * Read the conversation's session memory (`.memory.md`). Returns an empty
   * string when the conversation has none, or when the extension is running
   * outside a session.
   *
   * Session memory is conversation-scoped state the engine persists alongside
   * the transcript. It is not cross-session memory, which the engine
   * deliberately does not own.
   */
  getSessionMemory(): Promise<string>

  /**
   * Replace the conversation's session memory (`.memory.md`).
   *
   * This overwrites rather than appends. Read first if you mean to add:
   *
   * ```ts
   * const existing = await ctx.getSessionMemory()
   * await ctx.setSessionMemory(`${existing}\n\n- new fact`)
   * ```
   */
  setSessionMemory(content: string): Promise<void>

  /**
   * Emit an `engine_intercept` event on a session's stream.
   *
   * The engine routes the event and stamps the calling extension's name as
   * the source; an extension cannot spoof it. Everything past that is client
   * policy: `level` is a hint, not a behaviour the engine enforces.
   *
   * @example
   * ```ts
   * await ctx.intercept({
   *   level: 'redirect',
   *   title: 'Build is broken on main',
   *   message: 'Stop and fix the build before continuing.',
   * })
   * ```
   */
  intercept(opts: InterceptOpts): Promise<void>

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

  /**
   * Returns a point-in-time snapshot of every dispatch currently active in
   * this session's engine registry. Entries carry `status: "running"` while
   * actively working and `status: "suspended"` while parked. Terminal entries
   * are deregistered on completion and absent from the snapshot.
   *
   * Use this to enumerate running asynchronous agents and their nesting
   * relationships without subscribing to `engine_agent_state` events.
   * Complements {@link IonContext.recallDispatch} and
   * {@link IonContext.steerDispatch}: get the `dispatchId` from here, then
   * target the specific dispatch precisely.
   *
   * Returns an empty array when no dispatches are active or when the engine
   * does not support this RPC (older engine builds).
   */
  listDispatchState(): Promise<DispatchEntry[]>

  /**
   * One-shot lightweight inference call. Fires a single round-trip to
   * the provider — no tools, no agent loop, no fallback chain. The
   * lightweight counterpart to {@link IonContext.dispatchAgent}.
   *
   * Use this for harness-internal classification, extraction, and
   * routing prompts that don't need the full agent machinery. Examples:
   *   - "Is this user message about coding?" (intent classification)
   *   - "Extract the city from this query." (slot filling)
   *   - "Pick a specialist agent for this task." (router prompts)
   *
   * `llmCall` fires `before_provider_request` once per invocation so
   * extensions that count or tag outbound model traffic see uniform
   * telemetry across both the agent loop and lightweight inference.
   * After the call completes, the engine emits exactly one
   * `engine_llm_call` event carrying model / provider / latency /
   * tokens / cost / jsonMode — but never the prompt or response
   * content (privacy-by-default for harness-internal prompts).
   *
   * Errors reject the promise with a normal Error. On error no
   * `engine_llm_call` event fires; the harness decides whether to
   * surface a failure event of its own.
   *
   * If a path needs tools, that's {@link IonContext.dispatchAgent}.
   * `llmCall` is intentionally the no-tools, no-loop primitive.
   *
   * @example
   * ```ts
   * ion.on('turn_end', async (ctx, payload) => {
   *   const { content } = await ctx.llmCall({
   *     model: 'qwen2-7b',
   *     system: 'Reply with one word: yes or no.',
   *     prompt: `Does this turn mention scheduling? "${payload.lastMessage}"`,
   *     maxTokens: 5,
   *   })
   *   if (content.trim().toLowerCase().startsWith('yes')) {
   *     await ctx.emit({ type: 'jarvis_scheduling_signal', message: payload.lastMessage })
   *   }
   * })
   * ```
   */
  llmCall(opts: LLMCallOpts): Promise<LLMCallResult>

  // --- Resource subsystem (D-007) ---

  /**
   * Resource producer API. Use `ctx.resources.declare(...)` to register
   * this extension as the producer for a resource kind, then call
   * `handle.publish(...)` to push deltas to subscribers.
   * Use `ctx.resources.onQuery(...)` to register a handler invoked when
   * a client subscribes (for the initial snapshot).
   */
  resources: {
    /** Declare this extension as the producer for a resource kind. */
    declare(decl: ResourceDeclaration): Promise<ResourceHandle>
    /** Register a query handler for the given kind. Called when clients subscribe. */
    onQuery(kind: string, handler: (filter: ResourceFilter) => Promise<ResourceItem[]> | ResourceItem[]): void
  }

  /**
   * Send a push notification through the engine's notification pipeline.
   * The engine routes the payload through the relay's push channel.
   * Notifications are signals — they identify the resource and surface it to
   * the user; they don't carry full content payloads.
   *
   * @example
   * ```ts
   * await ctx.notify({ kind: 'briefing', title: 'New Brief', body: 'Summary ready.' })
   * ```
   */
  notify(opts: NotifyOpts): Promise<void>

  /** List all active sessions in the engine. Extensions use this to discover
   *  other sessions (e.g. for cross-session notification targeting). The engine
   *  returns all sessions; filter by extensionName on your side. */
  sessions: {
    list(): Promise<SessionListEntry[]>
    /** Send a structured message to another session of the same extension
     *  type. The target must have a session_message hook registered.
     *  Same extension type only — the engine enforces this. */
    send(targetKey: string, kind: string, payload: Record<string, unknown>): Promise<void>
  }

  /**
   * Trigger an immediate fire of the named schedule job. Reuses the engine's
   * existing fireJob machinery (in-flight guard, single-concurrency
   * arbitration, last-run recording). The handler receives a
   * {@link ScheduleFireMeta} with `backfill: true` so it can distinguish
   * a backfill from a live tick fire. Returns when the fire is queued (the
   * handler runs asynchronously).
   */
  fireSchedule(id: string): Promise<void>

  /**
   * Query the status of registered schedule jobs. When `id` is provided,
   * returns only the matching job (or an empty array when not found). When
   * `id` is omitted, returns all schedule jobs on this session.
   */
  getScheduleStatus(id?: string): Promise<ScheduleStatus[]>

  /**
   * Run an operation on exactly one instance when multiple sessions load the
   * same extension simultaneously.
   *
   * All instances call `runOnce`. The engine picks one winner; the others
   * skip `fn` and return `{ executed: false }`. The winner runs `fn` and
   * returns `{ executed: true, result }`. If `fn` throws, the lock releases
   * immediately so the next caller can retry.
   *
   * Scoped per extension path — `ion-dev` and `chief-of-staff` have
   * independent namespaces even if they use the same `id`.
   *
   * @param id      Operation identifier. Unique within this extension.
   * @param opts    Debounce options. Defaults to 60-second window.
   * @param fn      Async function to execute on the winning instance only.
   *
   * @example
   * ```ts
   * ion.on('session_start', async (ctx) => {
   *   await ctx.runOnce('git-sync', { debounceMs: 300_000 }, async () => {
   *     await gitPullRebase()
   *   })
   * })
   * ```
   */
  runOnce<T = void>(id: string, opts: RunOnceOpts, fn: () => Promise<T>): Promise<RunOnceResult<T>>

  /**
   * Programmatically enter plan mode for this session. The engine flips the
   * session into plan mode, allocates a plan file if needed, and emits
   * `engine_plan_mode_changed` so all subscribers see the transition.
   * Fires the existing `before_plan_mode_enter` hook so observation-only
   * extensions receive the same signal they would from a client-initiated
   * plan-mode entry. No-op when the session is already in plan mode.
   *
   * Useful for safety-gated workflows, approval loops, and headless sessions
   * that want to capture a plan before execution.
   */
  enterPlanMode(): Promise<void>

  /**
   * Programmatically exit plan mode for this session. The engine transitions
   * the session back to normal mode and emits `engine_plan_mode_changed`.
   * Fires the existing `before_plan_mode_exit` hook. No-op when the session
   * is already not in plan mode.
   */
  exitPlanMode(): Promise<void>

  /**
   * Query the current plan-mode state for this session.
   * Returns whether plan mode is enabled and the plan file path (non-empty
   * whenever a plan file has been allocated, even when plan mode is currently
   * off — the path is preserved across toggles until the session is reset).
   */
  getPlanMode(): Promise<PlanModeState>

  /**
   * Configure restart recovery for later runs in this session. The engine only
   * resumes work interrupted by engine process loss. Provider errors and normal
   * terminal exits are not retried.
   */
  setRunRecovery(config: RunRecoveryConfig): Promise<void>
}

/** Describes a session as returned by ctx.sessions.list(). */
export interface SessionListEntry {
  key: string
  hasActiveRun: boolean
  extensionName?: string
  conversationId?: string
}

/** Result returned by {@link IonContext.getPlanMode}. */
export interface PlanModeState {
  /** Whether plan mode is currently active for this session. */
  enabled: boolean
  /**
   * The plan file path allocated for this session. Non-empty whenever a plan
   * file has been created (even when plan mode is currently off — the path is
   * preserved across toggles until the session resets). Empty when no plan
   * file has ever been allocated.
   */
  planFilePath: string
}

/** Options for {@link IonContext.sendPrompt}. */
export interface SendPromptOpts {
  /** Per-prompt model override. Empty/undefined uses the session default. */
  model?: string

  /**
   * Per-prompt, run-scoped plan-mode Bash command-prefix allowances.
   *
   * Each entry is a command prefix (e.g. `'gh issue create'`) that the
   * engine adds to the plan-mode Bash allowlist for the single run this
   * prompt starts. They are unioned with the session-scoped allowlist and
   * are **never persisted** — they apply only for the scope of this
   * prompt's execution turn, then are dropped at run end.
   *
   * This is how a slash command dispatched as an extension command (e.g.
   * one loaded from a `.ion/commands/*.md` file whose frontmatter declares
   * `allowed_bash_commands`) performs its side effect — running an allowed
   * Bash command such as `gh issue create` — while plan mode is active,
   * rather than waiting until plan mode exits.
   *
   * Like `model`, additions flow on **every** dispatch path — the
   * active-hook / command-execute path AND the timer/scheduler fallback path
   * (no active dispatch context). The engine carries the full
   * `SendPromptPayload` (text + model + bash-allowlist additions) to the
   * session manager via `onSendMessage`, which builds the run overrides the
   * same way the active-hook path does. There is no per-feature divergence
   * between the two paths.
   *
   * An empty/omitted array is a no-op.
   */
  bashAllowlistAdditions?: string[]

  /**
   * Semantic classification of this injection. See {@link InjectionKind} for
   * the set the engine defines and what each one means.
   *
   * Supply this for any machine-to-machine injection — a dispatch callback, a
   * scheduled check-in, a revive. The engine derives a `machineAuthored` flag
   * from it and publishes both; consumers read the flag to tell an internal
   * signal from a turn the user authored. Omitting it on a machine message
   * leaves the injection indistinguishable from something the user typed.
   *
   * Empty (the default) means a genuine extension-initiated turn with no
   * special classification. Consumers interpret the classification however
   * they choose — the engine carries no opinion about what any consumer
   * should do with it.
   */
  kind?: InjectionKind
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
 * Options for {@link IonContext.runOnce}.
 */
export interface RunRecoveryConfig {
  /** Required by current engines. Omit only when supporting older SDK callers. */
  enabled?: boolean
  maxAttempts?: number
}

export interface RunOnceOpts {
  /**
   * Debounce window in milliseconds. After a successful execution, the
   * engine suppresses re-execution for this many ms.
   *
   * - `debounceMs > 0` (default 60000): suppress within the window. After
   *   it expires the next caller wins. The window only applies while at
   *   least one session of the extension is alive — when all sessions
   *   close, the entry clears regardless of remaining TTL.
   * - `debounceMs = 0`: run once per extension lifecycle. Resets when all
   *   sessions for this extension stop.
   *
   * @default 60000
   */
  debounceMs?: number
}

/**
 * Return value from {@link IonContext.runOnce}.
 */
export interface RunOnceResult<T = void> {
  /**
   * True when this instance ran `fn` and it completed. False when the
   * engine decided another instance should handle it (or already has).
   */
  executed: boolean
  /**
   * Why execution was skipped. Only present when `executed` is false.
   * - `"in_progress"`: another instance is currently running the operation.
   * - `"debounced"`: the operation ran recently enough to be within the window.
   * - `"already_ran"`: debounceMs=0 and the operation already ran this lifecycle.
   */
  reason?: 'in_progress' | 'debounced' | 'already_ran'
  /**
   * The return value of `fn`, when `executed` is true and `fn` returned
   * a value.
   */
  result?: T
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
 * `jarvis_inbox_update` or `my-extension_persona_loaded`.
 */
export type EngineEvent =
  /**
   * Agent-state metadata is broadcast repeatedly in complete snapshots.
   * Use short display labels (for example task / lastWork summaries), not full
   * output or conversation content. Put durable content in conversation history
   * or a resource item so clients can retrieve it on demand.
   */
  | { type: 'engine_agent_state'; agents: Array<{ name: string; status: string; metadata?: Record<string, any>; [key: string]: unknown }> }
  | { type: 'engine_status'; fields: { extensionName?: string; [key: string]: unknown }; metadata?: Record<string, unknown> }
  | { type: 'engine_working_message'; message: string; metadata?: Record<string, unknown> }
  | { type: 'engine_notify'; message: string; level: string; metadata?: Record<string, unknown> }
  // `metadata` is an opaque pass-through map the engine forwards verbatim
  // to clients. The desktop renderer honors `metadata.dedupKey` on harness
  // messages to suppress repeated emissions within a single engine-instance
  // scrollback — useful for "fire on every session_start" patterns like
  // a per-session welcome message. See docs/protocol/server-events.md for the
  // well-known metadata keys. The convention is renderer-honored, not
  // engine-enforced; any extension may pick its own keys (namespace as
  // `<extensionName>:<messageKey>`).
  | { type: 'engine_harness_message'; message: string; source?: string; metadata?: Record<string, unknown> }
  | { type: string; [key: string]: unknown }

export interface ToolDef {
  name: string
  description: string
  parameters: any // JSON Schema
  planModeSafe?: boolean
  execute: (params: any, ctx: IonContext) => Promise<ToolResult>
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
  /**
   * True only on the `before_agent_start` root-loop firing (primary
   * system-prompt injection), where `name`/`task` are empty. Always
   * `false`/absent for sub-agent `before_agent_start` firings and for the
   * `agent_start` / `agent_end` hooks (which only ever describe sub-agents).
   * Branch on `!isRoot` to inject a sub-agent-only preamble rather than the
   * legacy `name !== ""` sentinel.
   */
  isRoot?: boolean
  /** Child dispatch levels available under effective depth cap. Present only on `before_agent_start`. */
  remainingDepthBudget?: number
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
  /** Override agent name; empty/absent means no change. */
  agentName?: string
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
  tokensBefore?: number
  tokenLimit?: number
  targetTokens?: number
  microCompactKeep?: number
  tokensAfter?: number
  sessionMemory?: string
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
  /**
   * The RAW user prompt for this turn, captured BEFORE any `before_prompt`
   * rewrite. `model_select` routes on this raw text (content/length routing:
   * pick the model that fits the request); `before_prompt` then adapts the
   * chosen model's prompt, readable via `ctx.model`. Absent when the firing
   * site has no prompt in hand.
   */
  prompt?: string
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
  /** Structured registry-backed workspace facts, when cwd is a registered worktree. */
  workspace?: WorkspacePromptContext
}

export interface WorkspacePromptContext {
  kind: 'worktree' | 'bench' | string
  cwd: string
  worktree?: Record<string, unknown>
  bench?: Record<string, unknown>
  client?: Record<string, unknown>
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

/**
 * Payload for `background_task_completed`.
 *
 * Reports a background bash command started with
 * `Bash({ run_in_background: true, notify_on_complete: true })` reaching a
 * terminal state. Distinct from `TaskLifecycleInfo`, which describes a TURN —
 * this describes a shell process, keyed by the tasks-registry task id.
 *
 * Fires for every notifying command regardless of the engine's configured
 * delivery mode, so a harness observes completions even when the engine is
 * configured not to start runs on them.
 */
export interface BackgroundTaskCompletedInfo {
  /** Tasks-registry id of the completed command ("bash-<n>-<millis>"). */
  task_id: string
  /** Session that started the command. */
  session_key: string
  /** The shell command that ran. */
  command?: string
  /** Terminal status: "completed" (exit 0), "failed", or "stopped". */
  status: string
  /** Process exit code; 0 for a command stopped before reporting one. */
  exit_code: number
  /** Wall-clock milliseconds from start to terminal transition. */
  elapsed_ms: number
  /** On-disk file holding the full interleaved stdout+stderr. */
  output_path?: string
  /** Bounded in-memory tail of the command's output. */
  tail?: string
  /**
   * The session's still-outstanding background commands at the instant this
   * one completed. Empty means this was the last one.
   */
  remaining_task_ids?: string[]
}

/**
 * Payload for `dispatch_lost`.
 *
 * Reports a dispatch that was running when the engine process died and is
 * therefore unrecoverable after restart: the dispatch registry is process
 * memory, so every in-flight dispatched child died with the old process and
 * no terminal callback (onComplete/onError/onRecall) ever fired for it.
 * Fires once per orphan during dispatch-state rehydration at session start.
 *
 * Observe-only: by the time handlers run, the engine has already emitted the
 * typed `engine_dispatch_lost` event and marked the rehydrated agent-state
 * row `error`. A harness may redispatch the task, harvest the child's
 * partial transcript from the conversation store (`child_conversation_id`),
 * or notify its orchestrator.
 */
export interface DispatchLostInfo {
  /** The lost dispatch's collision-safe unique ID. */
  dispatch_id: string
  /** The dispatched agent's name. */
  agent_name: string
  /** The task brief the dispatch was running. */
  task?: string
  /** Dispatch ID of the parent that spawned it; empty for top-level. */
  parent_dispatch_id?: string
  /** Persisted nesting-depth attribution. */
  depth?: number
  /**
   * The child session's conversation ID when known — the handle for
   * harvesting the partial transcript from disk.
   */
  child_conversation_id?: string
}

/** Payload for `elicitation_request`. */
export interface ElicitationRequestInfo {
  request_id: string
  schema?: Record<string, unknown>
  url?: string
  mode: string
  /** Origin: extension or MCP server. */
  source?: string
  /** MCP server name when source is mcp. */
  server?: string
  /** Human-readable MCP reason for the request. */
  message?: string
  /** Action when this payload reflects a resolved request. */
  action?: 'accept' | 'decline' | 'cancel'
}

/** Payload for `elicitation_result`. */
export interface ElicitationResultInfo {
  request_id: string
  response?: Record<string, unknown>
  cancelled: boolean
  /** User explicitly declined rather than dismissing. */
  declined?: boolean
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
 * Payload for the `before_plan_mode_auto_exit` hook. Fired immediately
 * before the engine synthesizes an ExitPlanMode call at end-of-turn — i.e.
 * when a plan-mode run ends with stop reason `end_turn` / `stop` but the
 * assistant never invoked ExitPlanMode or AskUserQuestion. The hook lets a
 * harness observe, suppress, or rewrite the synthesized exit (see
 * {@link BeforePlanModeAutoExitResult}).
 *
 * Mirrors `extension.BeforePlanModeAutoExitInfo` in the Go SDK.
 */
export interface BeforePlanModeAutoExitInfo {
  /** Engine session ID for this run. */
  sessionId: string
  /** Engine-issued request ID for this run. */
  runId: string
  /**
   * Provider stop reason (`"end_turn"` or `"stop"`) that triggered the
   * synthesis decision. Other stop reasons never reach this hook.
   */
  stopReason: string
  /**
   * Resolved plan file path the synthesized exit would reference. Never
   * empty when this hook fires — the engine short-circuits synthesis
   * (without firing the hook) when no path is resolvable.
   */
  planFilePath: string
  /**
   * Concatenated text content of the final assistant turn that triggered
   * synthesis. Useful for distinguishing "the model presented a plan" from
   * "the model just answered / dispatched."
   */
  assistantText: string
  /**
   * Tool names the assistant emitted on this turn (none of which were
   * ExitPlanMode / AskUserQuestion). Empty when the turn ended with
   * text-only content.
   */
  emittedTools?: string[]
}

/**
 * Optional return value from a `before_plan_mode_auto_exit` handler.
 * Returning `undefined` (or an all-empty object) means "no opinion —
 * proceed with synthesis using the engine defaults." Across multiple hosts,
 * the last non-empty value wins per field (last-writer semantics).
 *
 * Mirrors `extension.BeforePlanModeAutoExitResult` in the Go SDK.
 */
export interface BeforePlanModeAutoExitResult {
  /**
   * When `true`, blocks the synthesis. The run completes as a normal
   * `end_turn` with no plan-approval card surfaced; the conversation stays
   * parked in plan mode. Use this for a turn that produced no plan to
   * review (e.g. an informational or dispatch-only turn).
   */
  suppress?: boolean
  /**
   * When non-empty, overrides the resolved plan file path used in the
   * synthesized exit. Empty means "no change."
   */
  planFilePath?: string
  /**
   * When non-empty, replaces the engine's default reason string recorded
   * on the synthesized exit. Empty means "use the engine default."
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
  /** Structured workspace facts for `workspace_context`. */
  workspace?: WorkspacePromptContext
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
  // Lifecycle
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

  // Session
  session_before_compact: CompactionInfo
  session_compact: CompactionInfo
  session_before_fork: ForkInfo
  session_fork: ForkInfo
  session_before_switch: void

  // Pre-action
  before_agent_start: AgentInfo
  before_provider_request: BeforeProviderRequestInfo

  // Content
  context: unknown
  message_update: MessageUpdateInfo
  tool_result: ToolResultInfo
  input: string
  model_select: ModelSelectInfo
  user_bash: string
  plan_mode_prompt: string

  // Per-tool call -- payload is the tool's raw input map
  bash_tool_call: Record<string, unknown>
  read_tool_call: Record<string, unknown>
  write_tool_call: Record<string, unknown>
  edit_tool_call: Record<string, unknown>
  grep_tool_call: Record<string, unknown>
  glob_tool_call: Record<string, unknown>
  agent_tool_call: Record<string, unknown>

  // Per-tool result -- payload is the engine ToolResultEntry shape
  bash_tool_result: ToolResultInfo
  read_tool_result: ToolResultInfo
  write_tool_result: ToolResultInfo
  edit_tool_result: ToolResultInfo
  grep_tool_result: ToolResultInfo
  glob_tool_result: ToolResultInfo
  agent_tool_result: ToolResultInfo

  // Context
  context_discover: ContextDiscoverInfo
  context_load: ContextLoadInfo
  instruction_load: ContextLoadInfo

  // Permission -- including the pluggable classifier
  permission_request: PermissionRequestInfo
  permission_denied: PermissionDeniedInfo
  permission_classify: PermissionClassifyInfo

  // File
  file_changed: FileChangedInfo
  workspace_file_changed: WorkspaceFileChangedInfo

  // Task
  task_created: TaskLifecycleInfo
  task_completed: TaskLifecycleInfo

  // Background shell commands
  background_task_completed: BackgroundTaskCompletedInfo

  // Dispatch loss (engine restart while dispatches were in flight)
  dispatch_lost: DispatchLostInfo

  // Elicitation
  elicitation_request: ElicitationRequestInfo
  elicitation_result: ElicitationResultInfo

  // Context inject
  context_inject: ContextInjectInfo

  // Capability
  capability_discover: void
  capability_match: CapabilityMatchInfo
  capability_invoke: CapabilityInvokeInfo

  // Extension lifecycle
  extension_respawned: ExtensionRespawnedInfo
  turn_aborted: TurnAbortedInfo
  peer_extension_died: PeerExtensionInfo
  peer_extension_respawned: PeerExtensionInfo

  // Plan mode -- workflow + state transitions on the plan-mode lifecycle.
  // See docs/architecture/adr/003-state-events-vs-workflow-events.md for the
  // state-vs-workflow distinction these hooks live alongside.
  before_plan_mode_enter: PlanModeEnterInfo
  before_plan_mode_exit: BeforePlanModeExitInfo
  before_plan_mode_auto_exit: BeforePlanModeAutoExitInfo

  // System inject -- fired before the engine injects any system message.
  // The `kind` discriminator carries the reason (plan_mode_reminder,
  // turn_limit_warning, max_token_continue, early_stop_continue).
  system_inject: SystemInjectInfo

  // Early-stop continuation -- engine provides the mechanism, harness
  // owns the policy and the prompt text. See
  // docs/architecture/adr/002-engine-vs-harness-early-stop.md.
  before_early_stop_decision: EarlyStopDecisionInfo
  early_stop_continued: EarlyStopContinuedInfo

  // Cross-session messaging -- fires when another session of the same
  // extension type sends a message via ctx.sessions.send().
  session_message: SessionMessageInfo

  // Schedule missed -- fires when the scheduler detects a daily/weekly
  // slot was missed while the engine was down. Observation-only: no veto.
  schedule_missed: ScheduleMissedInfo

  // Compaction summary -- the harness's chance to supply a summary in
  // place of the engine's regex fact extractor. Return a non-empty string
  // (or `{ summary }`) to override; return nothing to abstain.
  compact_summary_request: CompactSummaryRequestInfo

  // Slash commands -- fires after the engine expands an invocation,
  // before the body is committed as the LLM-visible prompt. Return a string
  // to override the expansion.
  slash_command_resolved: SlashCommandResolvedInfo

  // Async-trigger registration lifecycle. The `*_registered` pair is
  // veto-capable: return `{ block: true, reason }` to refuse. The
  // `*_deregistered` pair is observation-only, because letting one extension
  // trap another's resources would be a footgun.
  webhook_registered: AsyncRegistrationInfo
  webhook_deregistered: AsyncRegistrationInfo
  schedule_registered: AsyncRegistrationInfo
  schedule_deregistered: AsyncRegistrationInfo

  // Run recovery -- fires before the engine re-executes a recovered run
  // after a crash or daemon restart.
  before_run_recovery: BeforeRunRecoveryInfo
}

/**
 * Payload for the `compact_summary_request` hook. Carries the pre-compaction
 * message slice, already cut at the last boundary so prior summaries are not
 * re-scanned.
 */
export interface CompactSummaryRequestInfo {
  /** Which compaction path fired: proactive or reactive. */
  strategy: string
  /** Number of messages in `messages`. */
  messageCount: number
  /**
   * The messages under consideration, in engine `LlmMessage` wire shape.
   * Typed loosely because the message wire shape is owned by the engine's
   * conversation layer, not by the extension contract.
   */
  messages: Array<Record<string, unknown>>
}

/**
 * Return shape for a `compact_summary_request` handler. A handler may also
 * return a bare string, which is treated as `{ summary }`. Returning nothing
 * (or an empty summary) abstains and the engine falls back to its regex path.
 */
export interface CompactSummaryRequestResult {
  /** Replacement summary text. Empty means "no opinion". */
  summary?: string
}

/**
 * Payload for the `slash_command_resolved` hook. Carries the full frontmatter
 * map — known and unknown keys alike — so an extension can branch on a key the
 * engine itself ignores.
 */
export interface SlashCommandResolvedInfo {
  /** The invoked command, e.g. `/diagram`. */
  command: string
  /** Raw argument string following the command name. */
  args: string
  /** Where the command was resolved from: extension|ion|claude|skill|project. */
  source: string
  /** The command file's full frontmatter map. */
  frontmatter: Record<string, unknown>
  /** The engine's expansion. A handler returning a string overrides this. */
  expandedBody: string
}

/**
 * Payload for the four async-trigger registration lifecycle hooks
 * (`webhook_registered`, `webhook_deregistered`, `schedule_registered`,
 * `schedule_deregistered`).
 */
export interface AsyncRegistrationInfo {
  /** "webhook" or "schedule". */
  kind: string
  /** The declaration's stable id within its kind (webhook path, job id). */
  id: string
  /**
   * "init" or "runtime" — distinguishes the bulk init handshake from a
   * dynamic add/remove RPC, so a policy handler can treat them differently.
   */
  origin: string
  /** The typed declaration: a {@link WebhookRoute} or a {@link ScheduleJob}. */
  decl?: WebhookRoute | ScheduleJob | Record<string, unknown>
}

/**
 * Return shape for a `*_registered` handler that wants to refuse a
 * registration. `reason` is surfaced verbatim to the registering extension
 * and to the observability event. Returning nothing means "no opinion".
 */
export interface AsyncRegistrationVeto {
  block: boolean
  reason?: string
}

/** Payload for the `session_message` hook. */
export interface SessionMessageInfo {
  /** Session key of the sender. */
  senderSessionKey: string
  /** Application-defined message kind. */
  kind: string
  /** Application-defined payload. */
  payload: Record<string, unknown>
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
   * See `docs/hooks/reference.md` for the complete hook list.
   */
  on<K extends HookName>(hook: K, handler: HookHandler<HookPayloadMap[K]>): void
  on(hook: string, handler: HookHandler<any>): void
  registerTool(def: ToolDef): void
  registerCommand(name: string, def: CommandDef): void
  /**
   * Auto-discover agents from the extension's `agents/*.md` directory and
   * register a dispatch tool per agent. Each tool calls `ctx.dispatchAgent`
   * with the agent's name hardcoded, giving the LLM deterministic dispatch
   * without relying on the optional `name` parameter of the generic Agent tool.
   *
   * Call this at module scope (before the init handshake) so the tools appear
   * in the LLM's tool list from the first turn. Pair with
   * `ctx.suppressTool('Agent')` in `session_start` to remove the generic
   * Agent tool and eliminate ambiguity.
   *
   * By default, root agents (no `parent` field) are excluded since they
   * represent the conversation itself, not dispatch targets.
   *
   * @example
   * ```ts
   * const ion = createIon()
   * ion.registerAgentTools()
   * ion.on('session_start', (ctx) => { ctx.suppressTool('Agent') })
   * ```
   */
  registerAgentTools(opts?: RegisterAgentToolsOpts): void

  /**
   * Webhook route registration. Call `.register(route)` to bind an
   * inbound HTTP path; static (module-scope) and dynamic (post-init)
   * calls share the same shape and return a `WebhookHandle` with
   * `.unregister()`.
   *
   * @example
   * ```ts
   * ion.webhooks.register({
   *   path: '/webhook/github',
   *   method: 'POST',
   *   auth: { kind: 'hmac-signature', headerName: 'X-Hub-Signature-256',
   *           algorithm: 'sha256', token: () => process.env.GH_SECRET ?? '' },
   *   handler: async (ctx, req) => {
   *     await ctx.dispatchAgent({ name: 'pr-reviewer', task: req.text() })
   *     return { status: 200, body: 'ok' }
   *   },
   * })
   * ```
   */
  webhooks: {
    register(route: WebhookRoute): Promise<WebhookHandle>
  }

  /**
   * Scheduled job registration. Four kinds: daily, weekly, interval, once.
   * Each returns a `ScheduleHandle` with `.unregister()`. Static and
   * dynamic registration share the same shape.
   *
   * @example
   * ```ts
   * ion.schedule.daily({
   *   id: 'morning-summary',
   *   time: '09:00',
   *   tz: 'America/New_York',
   *   handler: async (ctx) => {
   *     await ctx.dispatchAgent({ name: 'summariser', task: 'today' })
   *   },
   * })
   *
   * ion.schedule.interval({
   *   id: 'inbox-poll',
   *   intervalMs: 30_000,
   *   handler: async (ctx) => {
   *     // ...
   *   },
   * })
   *
   * // One-shot: fires once after 5s then self-deregisters.
   * ion.schedule.once({
   *   id: 'startup-check',
   *   delayMs: 5_000,
   *   handler: async (ctx) => {
   *     await ctx.dispatchAgent({ name: 'checker', task: 'startup' })
   *   },
   * })
   * ```
   */
  schedule: {
    daily(opts: ScheduleDaily): Promise<ScheduleHandle>
    weekly(opts: ScheduleWeekly): Promise<ScheduleHandle>
    interval(opts: ScheduleInterval): Promise<ScheduleHandle>
    /** Register a one-shot schedule that fires once after delayMs and self-deregisters. */
    once(opts: ScheduleOnce): Promise<ScheduleHandle>
    /** Imperatively cancel a registered schedule by its id. */
    cancel(id: string): Promise<void>
  }

  /**
   * Resource producer API. Declare resource kinds at module scope
   * (pre-init) so they appear in the init response; call
   * `handle.publish(op, item)` to push deltas to subscribers.
   *
   * @example
   * ```ts
   * const ion = createIon()
   * const notesHandle = await ion.resources.declare({ kind: 'note' })
   * ion.resources.onQuery('note', (filter) => fetchNotes(filter))
   * // later, when a note is created:
   * await notesHandle.publish('create', { id: '1', kind: 'note', content: '...', createdAt: new Date().toISOString() })
   * ```
   */
  resources: {
    /** Declare this extension as the producer for a resource kind. */
    declare(decl: ResourceDeclaration): Promise<ResourceHandle>
    /** Register a query handler for the given kind. Called when clients subscribe. */
    onQuery(kind: string, handler: (filter: ResourceFilter) => Promise<ResourceItem[]> | ResourceItem[]): void
  }
}

// ---------------------------------------------------------------------------
// Async-trigger types (webhooks, schedules) — D-010 / D-011.
// ---------------------------------------------------------------------------
//
// Extensions register webhook routes and scheduled jobs via the
// ion.webhooks.register and ion.schedule.{daily, weekly, interval}
// surfaces from the runtime. Static (module-scope) and dynamic
// (post-init) registration share the same shape and the same handle
// for later .unregister().

/** Authentication strategies a webhook route can declare. */
export type WebhookAuth =
  | { kind: 'none' }
  | { kind: 'bearer'; token: () => string | Promise<string> | string }
  | { kind: 'shared-secret'; headerName: string; token: () => string | Promise<string> | string }
  | { kind: 'hmac-signature'; headerName: string; algorithm: 'sha256'; token: () => string | Promise<string> | string }

/**
 * Single inbound webhook request as the engine hands it to the
 * extension handler. The body is materialised as a string; `json()`
 * and `text()` are sugar over it. Headers are single-valued (the
 * first value wins for multi-valued headers).
 */
export interface WebhookRequest {
  method: string
  path: string
  url: string
  query: string
  headers: Record<string, string>
  body: string
  remote: string
  /** Parse the body as JSON. Returns {} on malformed or empty body. */
  json<T = unknown>(): T
  /** Return the raw body as text. */
  text(): string
}

/**
 * Handler return shape for a webhook fire. The engine writes status
 * and body, plus any extra headers. Missing fields default to
 * status=200, body="" (no-content response).
 */
export interface WebhookResponse {
  status?: number
  body?: string
  headers?: Record<string, string>
}

/**
 * A single webhook route registration. Path is the URL the engine's
 * HTTP listener will match on (exact, must start with '/'). Method
 * defaults to POST on the engine side; specify explicitly to register
 * a GET endpoint.
 */
export interface WebhookRoute {
  path: string
  method?: string
  auth: WebhookAuth
  /** Body size cap in bytes. Zero/omitted inherits the engine config default (1 MiB). */
  maxBodyBytes?: number
  /** Override bind interface (advanced — usually inherited from engine config). */
  interface?: string
  /** Concurrency mode: "single" (default) fires on one instance, "all" fires on every instance. */
  concurrency?: 'single' | 'all'
  /**
   * Handler invoked for each matching request. The ctx is freshly
   * built per fire; ctx.dispatchAgent / sendPrompt / emit /
   * setPlanMode / etc. all work normally.
   *
   * Return the response shape or void (treated as `{status: 200}`).
   */
  handler: (ctx: IonContext, req: WebhookRequest) => Promise<WebhookResponse> | WebhookResponse
}

/** Handle returned by ion.webhooks.register. */
export interface WebhookHandle {
  id: string
  unregister(): Promise<void>
}

/** Daily schedule: fires once per day at the configured wall-clock time. */
export interface ScheduleDaily {
  id: string
  time: string // "HH:MM" 24-hour
  tz?: string  // IANA timezone; empty inherits engine default
  timeoutMs?: number
  /** Concurrency mode: "single" (default) fires on one instance, "all" fires on every instance. */
  concurrency?: 'single' | 'all'
  /** Missed-slot policy. `latest` selects the newest missed job in catchUpGroup. */
  catchUp?: 'auto' | 'manual' | 'none' | 'latest'
  /** Group used by `catchUp: 'latest'`. Empty makes this job its own group. */
  catchUpGroup?: string
  /** Limit `latest` recovery to the current local date. */
  catchUpScope?: 'same_day'
  /** Optional lowercased weekday filter. Empty retains the every-day cadence. */
  daysOfWeek?: Array<'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'>
  enabled?: () => boolean | Promise<boolean>
  handler: ScheduleHandler
}

/** Weekly schedule: fires once per week on dayOfWeek at time. */
export interface ScheduleWeekly {
  id: string
  time: string                       // "HH:MM" 24-hour
  dayOfWeek: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
  tz?: string
  timeoutMs?: number
  /** Concurrency mode: "single" (default) fires on one instance, "all" fires on every instance. */
  concurrency?: 'single' | 'all'
  /** Missed-slot policy. `latest` selects the newest missed job in catchUpGroup. */
  catchUp?: 'auto' | 'manual' | 'none' | 'latest'
  /** Group used by `catchUp: 'latest'`. Empty makes this job its own group. */
  catchUpGroup?: string
  /** Limit `latest` recovery to the current local date. */
  catchUpScope?: 'same_day'
  enabled?: () => boolean | Promise<boolean>
  handler: ScheduleHandler
}

/** Interval schedule: fires every intervalMs (>=1000ms required). */
export interface ScheduleInterval {
  id: string
  intervalMs: number
  timeoutMs?: number
  /** Concurrency mode: "single" (default) fires on one instance, "all" fires on every instance. */
  concurrency?: 'single' | 'all'
  enabled?: () => boolean | Promise<boolean>
  handler: ScheduleHandler
}

/**
 * One-shot schedule: fires exactly once after delayMs (>=1000ms required),
 * then self-deregisters. The engine removes the job from the registry after
 * the handler returns — no second fire is possible.
 *
 * A once job whose enabled predicate returns false is skipped for that tick
 * but remains armed; the predicate skip does NOT consume the shot.
 */
export interface ScheduleOnce {
  id: string
  /** Milliseconds after registration to fire. Minimum 1000ms. */
  delayMs: number
  tz?: string
  timeoutMs?: number
  /** Concurrency mode: "single" (default) fires on one instance, "all" fires on every instance. */
  concurrency?: 'single' | 'all'
  enabled?: () => boolean | Promise<boolean>
  handler: ScheduleHandler
}

/**
 * Handler function for any schedule kind. The second parameter carries a
 * {@link ScheduleControl} object that lets the handler inspect its own
 * job ID and imperatively unregister itself before the engine's natural
 * lifecycle removes it. The third parameter carries fire metadata so the
 * handler can distinguish a live tick fire from a backfill fire triggered
 * by {@link IonContext.fireSchedule}. Both optional parameters are
 * backward-compatible — existing handlers that only accept
 * `(ctx: IonContext)` continue to work unchanged.
 */
export type ScheduleHandler = (ctx: IonContext, control?: ScheduleControl, meta?: ScheduleFireMeta) => Promise<void> | void

/**
 * Control object passed to every schedule handler at invocation time.
 * Lets a handler inspect its own job ID or imperatively cancel future
 * fires without waiting for the engine's self-deregister lifecycle.
 */
export interface ScheduleControl {
  /** The stable job ID this handler was registered under. */
  jobId: string
  /**
   * Unregisters this job so no further fires occur. For once jobs the engine
   * auto-deregisters after the handler returns; calling this inside the
   * handler is a no-op for once (the result is the same). For interval /
   * daily / weekly jobs it lets the handler decide mid-execution that the
   * job should stop.
   */
  unregister(): Promise<void>
}

/**
 * Metadata passed as the third argument to a schedule handler. Lets the
 * handler distinguish a live tick fire from a backfill fire triggered by
 * {@link IonContext.fireSchedule}.
 */
export interface ScheduleFireMeta {
  /** RFC3339 UTC timestamp when the engine fired the job. */
  firedAt: string
  /** True when the fire was triggered by ctx.fireSchedule (a backfill). */
  backfill: boolean
  /** RFC3339 UTC of the missed slot that triggered the backfill (when backfill=true). */
  missedSlotUtc?: string
}

/**
 * Payload for the `schedule_missed` hook. Fired when the scheduler detects
 * a daily/weekly slot was missed while the engine was down.
 */
export interface ScheduleMissedInfo {
  /** The schedule job's stable identifier. */
  id: string
  /** "daily" or "weekly". */
  kind: 'daily' | 'weekly' | 'interval' | 'once'
  /** RFC3339 UTC of the missed slot. */
  missedSlotUtc: string
  /** True when a last-run marker existed on disk at detection time. */
  hadMarker: boolean
  /** True when the job ran inside its current interval-scope window. */
  ranWithinScope: boolean
}

/**
 * Status of a registered schedule job, returned by
 * {@link IonContext.getScheduleStatus}.
 */
export interface ScheduleStatus {
  /** The job's stable identifier. */
  id: string
  /** "daily", "weekly", "interval", or "once". */
  kind: string
  /** RFC3339 UTC of the last successful fire. Empty when never run. */
  lastRunUtc?: string
  /** True when the job ran inside its current interval-scope window. */
  ranWithinScope: boolean
  /** RFC3339 UTC of the next scheduled fire. */
  nextRunUtc?: string
}

/** Wire-format job (handler stripped — kept locally). Used internally
 *  by the SDK runtime to ship init-time and runtime declarations to
 *  the engine. Extension authors normally don't construct this shape
 *  directly; use the ScheduleDaily/Weekly/Interval/Once inputs above.
 */
export interface ScheduleJob {
  id: string
  kind: 'daily' | 'weekly' | 'interval' | 'once'
  time?: string
  dayOfWeek?: string
  /** Optional weekday filter for daily schedules. */
  daysOfWeek?: string[]
  intervalMs?: number
  /** Milliseconds-to-first-fire for once jobs. Ignored for other kinds. */
  delayMs?: number
  tz?: string
  timeoutMs?: number
  enabledRefName?: string
  /** Concurrency mode: "single" (default) fires on one instance, "all" fires on every instance. */
  concurrency?: 'single' | 'all'
  /** Missed daily/weekly slot policy. Omit for historic engine default behavior. */
  catchUp?: 'auto' | 'manual' | 'none' | 'latest'
  /** Group used by `catchUp: 'latest'`. */
  catchUpGroup?: string
  /** Limit `latest` recovery to the current local date. */
  catchUpScope?: 'same_day'
}

/** Handle returned by ion.schedule.daily/weekly/interval/once. */
export interface ScheduleHandle {
  id: string
  unregister(): Promise<void>
}

// ---------------------------------------------------------------------------
// Resource subsystem types (D-007).
// ---------------------------------------------------------------------------
//
// Extensions that produce resources declare a kind, register a query handler
// for the initial snapshot, and publish deltas as items change. Clients
// subscribe via the socket (resource_subscribe command) and receive
// engine_resource_snapshot + engine_resource_delta events.

/** A single resource instance. Content is an opaque string the engine
 *  never interprets — encoding is the producer's concern. */
export interface ResourceItem {
  id: string
  kind: string
  /** Engine-assigned extension identity. Extension publishes cannot set it. */
  readonly producer?: string
  title?: string
  content: string
  createdAt: string
  conversationId?: string
  metadata?: Record<string, unknown>
  updatedAt?: string
  read?: boolean
}

/** A single change to a resource collection. */
export interface ResourceDelta {
  op: 'create' | 'update' | 'delete' | 'mark_read'
  item: ResourceItem
}

/** Scopes a subscription or query. */
export interface ResourceFilter {
  kind: string
  /** Restrict a query or subscription to one extension producer. */
  producer?: string
  conversationId?: string
  since?: string
  limit?: number
  /** Restrict a producer query to one item. */
  id?: string
}

/** Passed to ion.resources.declare(). Multiple extensions can produce one kind. */
export interface ResourceDeclaration {
  kind: string
}

/** Handle returned by ion.resources.declare(). */
export interface ResourceHandle {
  /** Publish a delta (create/update/delete/mark_read) for this resource kind. */
  publish(op: ResourceDelta['op'], item: ResourceItem): Promise<void>
}

// ---------------------------------------------------------------------------
// Notification types (D-009)
// ---------------------------------------------------------------------------

/** Options for ctx.notify() / ion.notify(). Notifications are signals that
 *  identify a resource and surface to the user — not full content payloads. */
export interface NotifyOpts {
  /** Resource kind this notification relates to (e.g. "briefing"). */
  kind: string
  /** ID of the specific resource item, if applicable. */
  resourceId?: string
  /** Short notification title shown in the notification banner. */
  title: string
  /** Notification body text. */
  body: string
  /** Notification sound name. Omit for the default sound. */
  sound?: string
  /** Delivery scope: "user" (default), "device", "all". */
  scope?: 'user' | 'device' | 'all'
  /** Conversation/session ID this notification relates to. Clients use this
   *  to navigate to the correct tab when the user acts on the notification.
   *  Omit for workspace-level notifications. */
  conversationId?: string
  /** When set, the engine emits the notification on the target session's
   *  event stream instead of the caller's. The target must exist. */
  targetSessionKey?: string
}

// ---------------------------------------------------------------------------
// Run recovery hook types
// ---------------------------------------------------------------------------

/** Payload for the `before_run_recovery` hook. */
export interface BeforeRunRecoveryInfo {
  /** Engine-issued identifier for this recovery attempt. */
  recoveryId: string
  /** Conversation whose run is being recovered. */
  conversationId: string
  /** 1-based recovery attempt number for this run. */
  attempt: number
  /** Configured ceiling on recovery retries. */
  maxAttempts: number
  /** Original user prompt that initiated the recovered run. */
  prompt?: string
  /** Model that was in use when the run was interrupted. */
  model?: string
  /** Session key within the conversation. */
  sessionKey?: string
}

/** Result from a `before_run_recovery` handler. */
export interface BeforeRunRecoveryResult {
  /** "recover" (proceed) or "skip" (abandon). Empty means no opinion. */
  action?: 'recover' | 'skip'
  /** Optional replacement instruction for the recovered run's context. */
  instruction?: string
}
