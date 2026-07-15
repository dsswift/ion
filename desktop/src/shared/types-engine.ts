// ─── Engine Types (native Ion extension runtime) ───

import type { Message } from './types-session'

// ─── Dispatch info ───

/** Structured dispatch info extracted from agent metadata. */
export interface DispatchInfo {
  id: string
  task: string
  model: string
  conversationId: string
  elapsed?: number
  status: string
  startTime?: number
}

/**
 * Flat dispatch telemetry entry recorded from engine_dispatch_start/end.
 * Keyed by dispatchSessionId (unique per dispatch instance). The depth and
 * parentDispatchId fields enable tree derivation in selectors without
 * storing the tree structure itself.
 */
export interface DispatchTelemetryEntry {
  dispatchAgent: string
  dispatchSessionId: string
  dispatchModel: string
  dispatchTask: string
  dispatchDepth: number
  dispatchParentId: string
  /** Stable unique id for this dispatch instance. Set from engine dispatchId field. */
  dispatchId: string
  /** Set once engine_dispatch_end arrives. The conversation id the dispatched agent used. */
  conversationId?: string
  /** Set once engine_dispatch_end arrives. */
  exitCode?: number
  elapsed?: number
  cost?: number
}

// ─── Resource subsystem types (D-007) ───

export interface ResourceItem {
  id: string
  kind: string
  title?: string
  content: string
  createdAt: string
  conversationId?: string
  metadata?: Record<string, unknown>
  updatedAt?: string
  read?: boolean
}

export interface ResourceDelta {
  op: 'create' | 'update' | 'delete' | 'mark_read'
  item: ResourceItem
}

export interface ResourceFilter {
  kind: string
  conversationId?: string
  since?: string
  limit?: number
}

// ─── Notification types (D-009) ───

export interface NotifyOpts {
  kind: string
  resourceId?: string
  title: string
  body: string
  sound?: string
  scope?: 'user' | 'device' | 'all'
  conversationId?: string
  targetSessionKey?: string
}

export interface EngineProfile {
  id: string
  name: string
  extensions: string[]
  defaultMode?: 'auto' | 'plan'
}

export interface EngineConfig {
  profileId: string
  extensions: string[]
  workingDirectory: string
  sessionId?: string
  model?: string
  maxTokens?: number
  thinking?: { enabled: boolean; budgetTokens?: number }
  systemHint?: string
  /**
   * Override the engine's default ignore-glob list for the
   * workspace_file_changed watcher. When omitted or empty the engine uses
   * its built-ins (`.git/**`, `node_modules/**`, `dist/**`, etc.). A
   * non-empty array REPLACES the defaults entirely (not merge). Patterns
   * use doublestar syntax and match against forward-slash repo-relative
   * paths.
   */
  workspaceWatchIgnore?: string[]
  /**
   * Enable Claude Code compatibility features — loading skills from
   * `~/.claude/skills/` on the engine side, and expanding `.claude/commands/`
   * templates on the desktop side. When false or absent, only Ion-native
   * `.ion/` paths are active.
   */
  claudeCompat?: boolean
  /**
   * Request a brand-new conversation for this session key even when the engine's
   * durable binding store holds a prior conversationId for it. Without this flag,
   * a start_session with an empty sessionId resumes the bound conversation
   * (restart resilience, issue #230). Set true to start fresh on a reused key
   * (e.g. "new conversation" on an existing tab): the engine mints a new id and
   * replaces the stored binding. An explicit non-empty sessionId still takes
   * precedence over both this flag and the binding store. (#231)
   */
  forceNewConversation?: boolean
  /**
   * Records that a freshly-minted conversation for this session descends from a
   * prior one. Written as the new conversation file's `parentId` when this run
   * creates a fresh file (a client-driven checkpoint cut — e.g. "clear context"
   * starting a new conversation for an existing tab). Ignored when resuming.
   */
  parentConversationId?: string
}

export interface ConversationRef {
  id: string        // crypto.randomUUID().slice(0,8)
  label: string     // "cos 1", "cos 2"
}

/**
 * Per-conversation state for an engine instance.
 *
 * Engine instances are sub-conversations under a single engine tab. This
 * interface collects the fields that belong to an individual conversation so
 * they can travel with the instance rather than living in flat global Maps
 * keyed by `${tabId}:${instanceId}`.
 *
 * All per-instance state lives here. The 8 parallel Maps that previously
 * held this data (engineMessages, engineModelOverrides, etc.) were removed
 * in #203. Event handlers, selectors, snapshot, and persistence all read
 * from and write to these fields on the instance directly.
 */
export interface ConversationInstance {
  /** Scrollback messages for this instance */
  messages: Message[]
  /**
   * Persisted message count, used as the blank-tab / lazy-load proxy when
   * `messages` is loaded but the on-disk count needs to survive a skeleton
   * (unopened) restore. Set to `messages.length` whenever messages are
   * loaded; read as `messages?.length ?? messageCount ?? 0`. Mirrors the
   * old `TabState.messageCount` semantics, now instance-scoped — a normal
   * tab's `main` instance carries the count its `TabState` used to hold.
   */
  messageCount: number
  /** Model override in effect for this instance (null = use tab/profile default) */
  modelOverride: string | null
  /**
   * Engine-reported active model for this conversation (from `session_init`
   * for normal tabs, mirrored from `statusFields.model` for engine tabs).
   * Distinct from `modelOverride` (the user's picker selection): this is the
   * model the engine actually ran. Used as the picker's display fallback.
   * Null until the first session_init / status event.
   */
  sessionModel: string | null
  /** Permission mode for this instance */
  permissionMode: 'auto' | 'plan'
  /** Per-instance extended-thinking effort (engine subtab). Default 'off'. Applied live on the next prompt. */
  thinkingEffort?: import('./types-session').ThinkingEffort
  /** Pending permission-denied tools (null = no pending denial) */
  permissionDenied: { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> } | null
  /**
   * Live interactive permission requests awaiting a user click for this
   * conversation. CLI/normal tabs populate this from `permission_request`
   * events on their `main` instance; engine instances gain the same
   * per-instance queue (the snapshot already scopes denial cards by
   * instanceId). Distinct from `permissionDenied`, which is the
   * non-interactive fallback card built from task_complete denials.
   */
  permissionQueue: import('./types-session').PermissionRequest[]
  /**
   * Live extension elicitations awaiting a user decision for this
   * conversation. Populated from `engine_elicitation_request` events (an
   * extension called `ctx.elicit()`). Each entry renders an approval/dialog
   * card; the user's choice is sent back via the `elicitation_response`
   * command keyed by `requestId`. Distinct from `permissionQueue`
   * (tool-call permission) and `permissionDenied` (plan-ready fallback).
   */
  elicitationQueue: import('./types-session').ElicitationRequest[]
  /** Conversation IDs accumulated by this instance across sessions */
  conversationIds: string[]
  /**
   * Reasoned session ledger for this instance: every engine conversation it has
   * owned, oldest first, each tagged with WHY it was cut (clear / compaction /
   * fork / unknown). Distinct from the raw `conversationIds` chain — the ledger
   * records cut reasons and parentId linkage so session history is auditable and
   * so a restart provably cannot append (only a checkpoint cut grows it). Built
   * from the persisted ledger on restore (or migrated from `conversationIds`);
   * appended only by explicit checkpoint handlers. Optional: instances that have
   * never been persisted with a ledger carry only `conversationIds`.
   */
  sessions?: import('./types-persistence').SessionLedgerEntry[]
  /**
   * Transient: the reason to tag the NEXT new session id this instance receives
   * (set by a checkpoint cut handler — e.g. Implement clear-context sets
   * 'clear' — and consumed once by the session_init append site, then cleared).
   * Undefined means the next id is the engine's own session lifecycle and is
   * tagged `unknown`. Never persisted; it only bridges a cut action to the
   * subsequent session_init that carries the freshly minted id.
   */
  pendingCutReason?: import('./types-persistence').SessionCutReason
  /** Draft input text for this instance's input bar */
  draftInput: string
  /** Latest agent-state snapshot from the engine */
  agentStates: AgentStateUpdate[]
  /** Latest status fields from the engine (null = none received yet) */
  statusFields: StatusFields | null
  /** Path to the active plan file (null = not in plan mode / no plan yet) */
  planFilePath: string | null
  /**
   * Flat dispatch telemetry entries recorded from engine_dispatch_start/end
   * events. Keyed by dispatchSessionId. Consumers derive the dispatch tree
   * via selectors (selectDispatchTree) from this flat data.
   */
  dispatchTelemetry: DispatchTelemetryEntry[]
  /** Set after rewind — the conversation ID chain before rewind. Used to inject
   *  prior-conversation context on the next prompt. Cleared after first send. */
  forkedFromConversationIds: string[] | null
  /**
   * Most recent context breakdown from the engine_context_breakdown event.
   * Replaced wholesale on each emission (snapshot semantics — the engine
   * rebuilds the full breakdown on every turn). Null until the first run.
   * The Status Drawer reads this synchronously on open; no fetch required.
   */
  contextBreakdown: ContextBreakdownPayload | null
  /**
   * Whether the on-disk scrollback for this conversation has been loaded into
   * `messages`. Skeleton (lazy-load) panes are created with `false`; the
   * hydration path (`loadSkeletonMessages`) sets `true` on completion. This is
   * the PRECISE hydration marker — "messages is empty" is NOT a reliable
   * proxy, because live streamed events (and cross-window user-message echoes)
   * append to a never-hydrated skeleton pane, after which an emptiness check
   * silently skips loading the history (the ATV-mirror last-turn-only bug).
   * `undefined` (legacy panes created by paths that don't set it) falls back
   * to the empty-messages+messageCount heuristic in `needsHistoryHydration`.
   * Client-only and transient: never persisted, not part of the Go contract.
   */
  historyHydrated?: boolean
}

export interface ConversationPane {
  instances: Array<ConversationRef & ConversationInstance>
  activeInstanceId: string | null
}

export interface AgentStateUpdate {
  name: string
  id?: string
  status: 'idle' | 'running' | 'done' | 'error'
  metadata?: Record<string, any>
}

/** Process registration handle for per-agent abort/steer */
export interface AgentHandle {
  pid?: number
  stdinWrite?: (message: string) => boolean
  parentAgent?: string
}

export interface StatusFields {
  label: string
  state: string
  sessionId?: string
  team?: string
  model: string
  contextPercent: number
  contextWindow: number
  /** Cost of the most recent run in USD (cache-aware, descendants included).
   *  Replaces the former totalCostUsd field; the rename makes the scope
   *  unambiguous — "run" not "conversation". */
  runCostUsd?: number
  /** Cumulative cost of the entire conversation (this session + all descendant
   *  dispatches) in USD. Computed via the cost.ConversationCost dispatch-tree
   *  walk on every TaskComplete. */
  conversationCostUsd?: number
  /** Backend mode: 'api' (direct) or 'cli' (CC CLI proxy) */
  backend?: 'api' | 'cli'
  permissionDenials?: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }>
  /** Friendly display name broadcast by the extension (e.g. "Chief of Staff"). */
  extensionName?: string
  /** Number of background dispatch agents still running when the parent LLM
   *  turn ends. When > 0, the engine is "idle" but background work is in
   *  progress. Clients use this to keep the tab status active and the
   *  interrupt button visible. */
  backgroundAgents?: number
  /** Number of LLM turns completed in the most recent run. Stamped from
   *  TaskCompleteEvent.NumTurns; absent on idle and heartbeat status events. */
  numTurns?: number
  /** Conversation-lifetime prompt count: the number of real user prompts
   *  across the whole conversation, not just the most recent run. Stamped from
   *  TaskCompleteEvent.ConversationTurns; absent on idle and heartbeat status
   *  events. The drawer "Turns" row renders this (lifetime), whereas numTurns
   *  is the per-run round-trip count. */
  conversationTurns?: number
}

/**
 * Mirror of Go's `types.SessionStatus`. Phase 3 of the state-management
 * overhaul carries the engine's authoritative per-session status in one
 * typed payload that consumers can map onto their local cache without
 * inferring state from heterogeneous events (text deltas, message-end,
 * task-complete). See engine/internal/types/types.go for per-field
 * semantics; the wire shape is identical.
 *
 * Emitted by the engine alongside the legacy `engine_status` during the
 * transition window. Both events carry the same authoritative state;
 * Phase 4 removes the legacy emission once every in-repo consumer has
 * migrated to read this type.
 */
export interface SessionStatus {
  key: string
  state: string
  /** Unix-ms timestamp when the engine entered the current state.
   *  Zero means "not tracked yet"; populated once Phase 5 lands the
   *  per-session state-machine. */
  stateSince?: number
  /** Unix-ms timestamp when the engine last emitted a session-status
   *  event for this key. Always populated on inbound events. */
  lastEmittedAt: number
  /** True iff the backend has a live run for this key. The engine
   *  cross-checks `requestID` against the backend's run set so this
   *  flag cannot drift the way `tab.status === 'running'` did. */
  hasInflightRun?: boolean
  /** Number of background dispatch agents still running. Same
   *  semantics as `StatusFields.backgroundAgents`. */
  backgroundAgentCount?: number
  /** Unresolved AskUserQuestion / ExitPlanMode entries retained
   *  across status emissions. Same shape as
   *  `StatusFields.permissionDenials`. */
  permissionDenialsPending?: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }>
  model?: string
  contextPercent?: number
  contextWindow?: number
  /** Cost of the most recent run in USD. Matches StatusFields.runCostUsd semantics. */
  runCostUsd?: number
  /** Cumulative cost of the entire conversation (this session + all descendant dispatches) in USD. */
  conversationCostUsd?: number
  sessionId?: string
  extensionName?: string
}

/**
 * Slash-command listing carried inside engine_command_registry snapshots.
 * Mirror of Go's types.EngineCommandListing. The desktop's prompt pipeline
 * uses the `name` set as a routing hint so it can short-circuit `.md`
 * template lookups for command names the session's extensions own. The
 * `description` is the same hint the iOS autocomplete already shows for
 * filesystem-discovered `.md` commands.
 */
export interface EngineCommandListing {
  name: string
  description?: string
}

/**
 * Mirror of Go's `types.LlmContentBlock`. This is the wire shape for
 * every block carried inside an `LlmMessage` — providers, persistence,
 * and the conversation history all serialize through it.
 *
 * The desktop does NOT currently render `LlmMessage` payloads directly
 * (the engine emits normalized events instead), but the type is mirrored
 * for two reasons:
 *
 *   1. Cross-language contract sync — the Go side adds field-level
 *      coverage via `contract_test.go`, and this mirror keeps drift
 *      detectable. The `compact_boundary` variant added in the
 *      gentle-knitting-cup plan ships with several optional metadata
 *      fields (`trigger`, `summary`, `clearedBlocks`, etc.) that future
 *      desktop work may want to render in a compaction marker UI; the
 *      type being already mirrored avoids a churn-PR when that lands.
 *
 *   2. Unknown block types must not crash a renderer. Any future
 *      renderer that walks an `LlmContentBlock[]` should fall through
 *      `type` it doesn't recognise — the field is open-string by design
 *      because the engine ships new block variants additively.
 */
export interface LlmContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
  is_error?: boolean
  thinking?: string
  source?: { type: string; media_type: string; data: string }
  // compact_boundary structured fields. All optional; only populated
  // when `type === 'compact_boundary'`. See Go-side llm.go for canonical
  // semantics.
  trigger?: string
  messagesSummarized?: number
  messagesBefore?: number
  messagesAfter?: number
  clearedBlocks?: number
  tokensBefore?: number
  summary?: string
  factCount?: number
  recentFiles?: string[]
  // context_injection structured field. Populated only when
  // `type === 'context_injection'` (read-triggered nested AGENTS.md/ION.md
  // descent). Carries the absolute instruction-file paths the block injected;
  // it is the engine's structural dedup key. See Go-side llm.go.
  contextPaths?: string[]
}

// EngineEvent — the engine's outbound wire event union — lives in
// types-engine-event.ts (extracted to keep this file under the 600-line cap).
// Re-exported here so existing `import { EngineEvent } from './types-engine'`
// sites are unchanged.
export type { EngineEvent } from './types-engine-event'

// ─── Context Breakdown (engine_context_breakdown wire payload) ───
//
// Mirrors Go's ContextBreakdownCategory and ContextBreakdownPayload in
// engine/internal/types/engine_event.go. The desktop and iOS use these to
// render the per-category context-usage readout in the Status Drawer.
//
// Cross-language contract: contract-sync.test.ts validates field parity against
// engine/internal/types/testdata/contracts.json. Update that manifest whenever
// the Go struct changes (go test ./internal/types/ -run TestContractManifest -update).

/** One row in a context breakdown: a named category with its token count and resolution tier. */
export interface ContextBreakdownCategory {
  name: string
  kind: string
  tokens: number
  /** How the count was obtained: provider endpoint, BPE, or char/4 heuristic. */
  tier: 'exact' | 'local' | 'approximate'
  /** Absolute path — populated for per-file rows (kind === 'file'). */
  path?: string
}

/** Wire payload for engine_context_breakdown. Mirrors Go's ContextBreakdownPayload. */
export interface ContextBreakdownPayload {
  categories: ContextBreakdownCategory[]
  contextWindow: number
  totalTokens: number
  /** Provider-reported input_tokens. Zero until reconciliation after first usage event. */
  apiReportedTotal?: number
  /** apiReportedTotal - totalTokens. Non-zero after reconciliation. */
  unaccounted?: number
  /**
   * Provider-reported cache-read tokens. Non-additive annotation — NOT included in
   * totalTokens. Zero/absent when the provider did not report cache activity.
   */
  cacheReadTokens?: number
  /**
   * Provider-reported cache-creation tokens. Non-additive annotation — NOT included in
   * totalTokens. Zero/absent when the provider did not report cache activity.
   */
  cacheCreationTokens?: number
  model: string
  /**
   * Sum of this session's LLM cost plus every descendant dispatch session's
   * cost, computed on demand from the conversation tree. Zero / absent for
   * sessions with no dispatches or no cost yet.
   */
  aggregateCostUsd?: number
  /**
   * Per-model cost breakdown for the conversation dispatch tree. Populated by
   * the on-demand breakdown (ComputeAndEmitContextBreakdown). Empty for
   * runloop-emitted breakdowns. Sorted by costUsd descending.
   */
  modelBreakdown?: ModelBreakdown[]
}

/** One row in the per-model cost breakdown. Mirrors Go's ModelBreakdown in types/model_breakdown.go. */
export interface ModelBreakdown {
  model: string
  conversations: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  /**
   * True when this row is the root/viewing conversation's OWN spend rather than
   * a dispatch. A model used by both the root and its dispatches yields two rows
   * (one isSelf=true count 1, one isSelf=false count n). Absent (omitted on the
   * wire) for dispatch rows. Lets consumers separate "this conversation cost $X"
   * from "the dispatches cost $Y".
   */
  isSelf?: boolean
}
