// ─── Engine Types (native Ion extension runtime) ───

import type { Message } from './types-session'
import type { ToolGateConfig } from './types-tool-gate'
import type { ContextBreakdownPayload } from './types-context-breakdown'

// ─── Abort scope ───

/**
 * How much of a session's work a stop tears down. Rides the engine `abort`
 * command's `abortScope` field. `all` cancels the active run and recalls
 * background dispatches; `orchestrator` cancels only the active run.
 * Omitting the field preserves historical `all` behavior.
 */
export type AbortScope = 'all' | 'orchestrator' | 'all_work'

/** One running session-owned background Bash process. */
export interface BackgroundTaskState {
  taskId: string
  toolId?: string
  command: string
  startedAt: number
  notifyOnComplete?: boolean
}

// ─── Dispatch info ───

/** Structured dispatch info extracted from agent metadata. */
export interface DispatchInfo {
  id: string
  task: string
  model: string
  conversationId: string
  elapsed?: number
  status: string
  /** What this dispatch is blocked on while its own run is not foreground work. */
  waitingOn?: 'children' | 'shell'
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

// ─── Resource subsystem + notifications ───
// Extracted to types-resource.ts (file-size cap); re-exported here so every
// existing `from './types-engine'` import keeps resolving unchanged.
export type { ResourceItem, ResourceDelta, ResourceFilter, NotifyOpts } from './types-resource'

export interface ResolvedNewConversationDefaults {
  path: string
  baseDirectory?: string
  profileName?: string
  profileId?: string
  extensions?: string[]
  profileLocked?: boolean
}

export interface EngineProfile {
  id: string
  name: string
  extensions: string[]
  defaultMode?: 'auto' | 'plan'
}

/**
 * Extended-thinking configuration. Mirrors the Go `types.ThinkingConfig`
 * (engine/internal/types/types.go) field for field.
 *
 * Carried on `EngineConfig.thinking` as a per-session default, which sits
 * between the engine-wide `engine.json` default and the per-prompt
 * `thinkingEffort` in the precedence chain:
 *
 *   engine.json ← EngineConfig.thinking ← send_prompt.thinkingEffort
 */
export interface ThinkingConfig {
  /** Whether runs carry a thinking directive by default. */
  enabled: boolean
  /**
   * Cross-provider reasoning level: 'low' | 'medium' | 'high'. The preferred
   * control — the engine maps it onto each provider's mechanism. Takes
   * precedence over `budgetTokens`.
   */
  effort?: string
  /**
   * Legacy explicit thinking-token budget. Used only by models whose
   * capability mode is `budget`, and only when `effort` is empty.
   */
  budgetTokens?: number
  /**
   * Whether per-token `engine_thinking_delta` events reach the wire.
   * Absent means ON — block-boundary events emit regardless.
   */
  streamDeltas?: boolean
  /**
   * Whether reasoning TEXT is retained in conversation history for later
   * display. Absent means ON. Never affects provider re-submission.
   */
  persist?: boolean
}

export interface RunRecoveryConfig {
  /** Explicit per-session recovery decision. Absent inherits engine.json. */
  enabled?: boolean
  /** Durable automatic-recovery limit. Absent inherits engine config. */
  maxAttempts?: number
}

export interface RunRecoveryRuntimeConfig extends RunRecoveryConfig {
  /** Process-wide cap for restart recovery launches. Only engine.json owns it. */
  maxConcurrent?: number
}
export interface EngineConfig {
  profileId: string
  extensions: string[]
  workingDirectory: string
  /** Source Project policy root. Needed when workingDirectory is a worktree. */
  projectDirectory?: string
  sessionId?: string
  model?: string
  maxTokens?: number
  thinking?: ThinkingConfig
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
  /**
   * Marks this session as exempt from the engine's orphaned-session reaper. When
   * true, the engine will not automatically stop the session when all owning
   * client connections disconnect. Intended for headless daemon sessions that host
   * long-lived extensions with schedules and hooks but have no persistent UI owner.
   * An explicit stop_session or engine shutdown still terminates pinned sessions.
   */
  pinned?: boolean
  /**
   * Opt-in client tool gate: the engine emits engine_tool_gate_request before
   * matching tool calls and blocks each until tool_gate_response arrives or
   * the declared timeout applies the declared fallback. See types-tool-gate.ts.
   */
  toolGate?: ToolGateConfig
  clientWorkspaceContext?: ClientWorkspaceContext
  runRecovery?: RunRecoveryConfig
}

export interface ClientWorkspaceContext {
  kind: string
  cwd: string
  bench?: Record<string, unknown>
  data?: Record<string, unknown>
  text?: string
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
  /** Model selection in effect for this instance (null = use tab/profile default). */
  modelOverride: string | null
  /**
   * Why `modelOverride` exists. User selection is a published per-prompt
   * preference; automatic selection comes from plan/implementation mode or a
   * workflow. Slash-command frontmatter supersedes automatic selection, while
   * a direct user choice remains an explicit override.
   */
  modelOverrideSource: 'user' | 'automatic' | null
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
   * silently skips loading the history (the Studio window-mirror last-turn-only bug).
   * `undefined` (legacy panes created by paths that don't set it) falls back
   * to the empty-messages+messageCount heuristic in `needsHistoryHydration`.
   * Client-only and transient: never persisted, not part of the Go contract.
   */
  historyHydrated?: boolean
  /**
   * Set when `loadSkeletonMessages` failed (engine unreachable, unreadable
   * store). The pane is still marked `historyHydrated: true` so it renders
   * and tab switches don't hammer a down engine — this flag is what the
   * engine-reconnect path (`rehydrateFailedHistory`) uses to find panes whose
   * hydration must be retried now that the engine is back. Cleared on retry.
   * Client-only and transient: never persisted, not part of the Go contract.
   */
  historyHydrationFailed?: boolean
  /**
   * Lazy-load state for externalized scrollback (schema v4). 'pending' is set
   * on restore when the persisted instance carries `hasExternalContent` and
   * its content file was not eager-merged (only the active tab merges at
   * startup); `loadSkeletonMessages` resolves it to 'loaded' (content file
   * read) or 'error' (unreadable — the pane renders count-only, still
   * usable). Undefined means the instance never had external content.
   * Client-only and transient: never persisted, not part of the Go contract.
   */
  externalContentStatus?: 'pending' | 'loaded' | 'error'
}

export interface ConversationPane {
  instances: Array<ConversationRef & ConversationInstance>
  activeInstanceId: string | null
}

export interface AgentStateUpdate {
  name: string
  id?: string
  /**
   * Agent lifecycle status. `suspended` is a live (non-terminal) state: the
   * dispatch is parked waiting on child completions or a revive message
   * (engine dispatch_agent.go sets it on park; agents/registry.go ranks it
   * above terminal states). `cancelled` is terminal (user/parent/system
   * abort). Consumers should degrade gracefully on unknown values per
   * docs/architecture/agent-state.md — this union mirrors the engine's
   * documented vocabulary, it does not gate it.
   */
  status: 'idle' | 'running' | 'suspended' | 'done' | 'error' | 'cancelled'
  metadata?: Record<string, any>
}

/** Process registration handle for per-agent abort/steer */
export interface AgentHandle {
  pid?: number
  stdinWrite?: (message: string) => boolean
  parentAgent?: string
}


// The two engine status-snapshot shapes (StatusFields, SessionStatus) live in
// types-engine-status.ts — extracted to keep this file under the 600-line cap.
// Re-exported here so every existing `from './types-engine'` import site keeps
// resolving; the split is a file boundary, not an API change. The plain import
// is separate from the re-export because ConversationInstance.statusFields
// references StatusFields in this file, and a bare `export type { ... } from`
// re-exports a name without binding it locally.
import type { StatusFields } from './types-engine-status'
export type { StatusFields, SessionStatus, PollState } from './types-engine-status'

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
  // skill_content and skill_listing fields. The engine uses these internal
  // structural markers to manage one-time skill instructions and listings;
  // clients must tolerate them without rendering transcript rows.
  skillName?: string
  skillSource?: string
  skillInvokedAt?: number
  skillNames?: string[]
  restoredSkills?: Array<{
    name: string
    source?: string
    content: string
    invokedAt: number
  }>
}

// EngineEvent — the engine's outbound wire event union — lives in
// types-engine-event.ts (extracted to keep this file under the 600-line cap).
// Re-exported here so existing `import { EngineEvent } from './types-engine'`
// sites are unchanged.
export type { EngineEvent } from './types-engine-event'

// Context breakdown types (ContextBreakdownCategory, ContextBreakdownPayload,
// ModelBreakdown) moved to types-context-breakdown.ts at the 600-line cap
// split; re-exported here so existing imports keep working.
export type { ContextBreakdownCategory, ContextBreakdownPayload, ModelBreakdown } from './types-context-breakdown'

// Enterprise policy types (ResourceLimits, EnterpriseProviderDefinition,
// ExtensionAllowlistEntry, EnterprisePolicy, IonDesktopPolicyFields) moved
// to types-enterprise.ts at the 600-line cap split; re-exported here so
// existing imports keep working.
export type {
  ResourceLimits,
  EnterpriseProviderDefinition,
  ExtensionAllowlistEntry,
  EnterprisePolicy,
  IonDesktopPolicyFields,
} from './types-enterprise'
