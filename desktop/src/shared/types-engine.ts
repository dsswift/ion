// ─── Engine Types (native Ion extension runtime) ───

import type { Message } from './types-session'

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
  /** Conversation IDs accumulated by this instance across sessions */
  conversationIds: string[]
  /** Draft input text for this instance's input bar */
  draftInput: string
  /** Latest agent-state snapshot from the engine */
  agentStates: AgentStateUpdate[]
  /** Latest status fields from the engine (null = none received yet) */
  statusFields: StatusFields | null
  /** Path to the active plan file (null = not in plan mode / no plan yet) */
  planFilePath: string | null
  /** Set after rewind — the conversation ID chain before rewind. Used to inject
   *  prior-conversation context on the next prompt. Cleared after first send. */
  forkedFromConversationIds: string[] | null
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
  totalCostUsd?: number
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
  totalCostUsd?: number
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
}

export type EngineEvent =
  | { type: 'engine_agent_state'; agents: AgentStateUpdate[] }
  | { type: 'engine_status'; fields: StatusFields; metadata?: Record<string, unknown> }
  | { type: 'engine_session_status'; sessionStatus: SessionStatus; metadata?: Record<string, unknown> }
  | { type: 'engine_working_message'; message: string; metadata?: Record<string, unknown> }
  | { type: 'engine_notify'; message: string; level: 'info' | 'warning' | 'error'; metadata?: Record<string, unknown> }
  | { type: 'engine_dialog'; dialogId: string; method: 'select' | 'confirm' | 'input'; title: string; message?: string; options?: string[]; defaultValue?: string }
  // `metadata` is an opaque pass-through map the harness sets via ctx.emit
  // that the engine forwards verbatim. The desktop renderer honors
  // `metadata.dedupKey` (string) to suppress repeated harness messages
  // within an engine-instance scrollback — see engine-event-slice.ts. The
  // convention is renderer-honored, not engine-enforced; other extensions
  // may pick their own keys (namespace as `<extensionName>:<messageKey>`).
  | { type: 'engine_harness_message'; message: string; source?: string; metadata?: Record<string, unknown> }
  | { type: 'engine_text_delta'; text: string }
  | { type: 'engine_message_end'; usage: { inputTokens: number; outputTokens: number; contextPercent: number; cost: number } }
  | { type: 'engine_tool_start'; toolName: string; toolId: string }
  | { type: 'engine_tool_end'; toolId: string; result?: string; isError?: boolean }
  | { type: 'engine_tool_update'; toolId: string; partialInput: string }
  | { type: 'engine_tool_complete'; index?: number }
  | { type: 'engine_dead'; exitCode: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'engine_error'; message: string; errorCode?: string; errorCategory?: string; retryable?: boolean; retryAfterMs?: number; httpStatus?: number }
  | { type: 'engine_permission_request'; questionId: string; permToolName: string; permToolDescription?: string; permToolInput?: Record<string, unknown>; permOptions: Array<{ id: string; label: string; kind?: string }> }
  | { type: 'engine_plan_mode_changed'; planModeEnabled: boolean; planFilePath?: string; planSlug?: string }
  // engine_plan_proposal is the workflow-level counterpart to
  // engine_plan_mode_changed: it fires when the model *proposes* a plan-mode
  // transition (e.g. by calling ExitPlanMode) but the actual mode change is
  // deferred to the consumer's user-approval chokepoint. The `kind` field
  // discriminates the proposal — `"exit"` is the only kind emitted today;
  // future kinds may include `"enter"` or `"amend"`. Consumers must treat
  // unknown kinds as forward-compatible. See
  // docs/architecture/adr/003-state-events-vs-workflow-events.md for the
  // state-vs-workflow distinction. PlanFilePath and PlanSlug are carried
  // directly so consumers don't have to scrape `permissionDenials.toolInput`
  // to recover them.
  | { type: 'engine_plan_proposal'; planProposalKind: 'exit' | string; planFilePath?: string; planSlug?: string }
  // engine_plan_mode_auto_exit fires when the engine deterministically
  // synthesizes an ExitPlanMode call at end-of-turn because the model
  // ended a plan-mode run without invoking ExitPlanMode or
  // AskUserQuestion (issue #187). It is a sibling to
  // engine_plan_proposal: both surface the plan-approval card, but
  // this event additionally tells consumers the exit was
  // engine-driven rather than model-driven.
  //
  // Emitted BEFORE the companion engine_plan_proposal{kind:"exit"} so
  // consumers that key off the synthesis specifically see it first.
  // The TaskCompleteEvent that follows carries the same synthesized
  // PermissionDenial as the model-driven path, so consumers keying
  // off the denial path continue to render approval cards unchanged.
  //
  // Use cases: telemetry on prompt quality (how often does the model
  // misroute plan exit?); subtle UI hints that the synthesis fired
  // ("Plan surfaced automatically — review carefully").
  | { type: 'engine_plan_mode_auto_exit'; stopReason: string; planFilePath?: string; planSlug?: string; reason?: string; sessionId?: string; runId?: string }
  | { type: 'engine_stream_reset' }
  | { type: 'engine_compacting'; active: boolean; summary?: string; messagesBefore?: number; messagesAfter?: number; clearedBlocks?: number; strategy?: string }
  | { type: 'engine_tool_stalled'; toolId: string; toolName: string; toolElapsed: number }
  // Mid-turn steer-drain confirmation. Engine emits this after the
  // runloop drainSteer helper captures a steer message (queued via the
  // steer channel) and injects it into the conversation as a user turn
  // before the next LLM call. `steerMessageLength` is the character
  // count; the body is not echoed back over the wire because it is
  // already part of the conversation. See
  // engine/internal/types/normalized_event.go (SteerInjectedEvent).
  | { type: 'engine_steer_injected'; steerMessageLength: number }
  // engine_run_stalled — advisory event emitted by the run-progress watchdog
  // when a run records no forward progress for longer than the configured
  // RunStall threshold. The authoritative completion signal is the follow-up
  // task_complete; this event is for observability only.
  | { type: 'engine_run_stalled'; runStalledDuration: number; runStalledLastActivity?: string }
  // engine_model_fallback — workflow signal emitted by the engine when
  // it fell back to its configured defaultModel because the requested
  // model didn't resolve to a provider. Mirrors the underlying
  // ModelFallbackEvent NormalizedEvent variant. The desktop renders a
  // small ⚠ glyph on the affected engine instance pill via the
  // engineModelFallbacks store map; iOS receives the fact through the
  // snapshot path (RemoteTabState.conversationInstances[i].modelFallback)
  // rather than as a live RemoteEvent. See CLAUDE.md §
  // "The typed-event corollary" for the broader rule.
  | { type: 'engine_model_fallback'; fallbackRequestedModel: string; fallbackModel: string; fallbackReason: string }
  | { type: 'engine_extension_died'; extensionName: string; exitCode: number | null; signal: string | null; stderrTail?: string[] }
  | { type: 'engine_extension_respawned'; extensionName: string; attemptNumber: number }
  | { type: 'engine_events_dropped'; count: number }
  | { type: 'engine_extension_dead_permanent'; extensionName: string; attemptNumber: number; stderrTail?: string[] }
  // ─── Async-trigger events (D-010 / D-011) ───
  //
  // The engine emits these for every webhook and schedule fire plus
  // every registration/deregistration so the desktop / iOS can render
  // an audit-log panel of "what's declared" and "what just fired".
  // The desktop does NOT act on these (they're observation-only);
  // they're typed here so future UI work has the shape ready.
  //
  // Shared fields across the variants:
  //   asyncKind:        "webhook" | "schedule"
  //   asyncId:          route path (webhook) or job id (schedule)
  //   asyncOrigin:      "init" | "runtime" — set on lifecycle events
  //   asyncReason:      negative-path discriminator
  //   asyncDecl:        the original declaration JSON, redacted of secrets
  //   asyncRequestId:   webhook correlation id (received → responded)
  //   asyncMethod:      HTTP method (webhook)
  //   asyncPath:        HTTP path (mirrors asyncId for webhooks)
  //   asyncStatus:      HTTP response status (webhook)
  //   asyncDurationMs:  elapsed time of the fire
  | { type: 'engine_webhook_received'; asyncKind: 'webhook'; asyncId: string; asyncRequestId: string; asyncMethod: string; asyncPath: string }
  | { type: 'engine_webhook_authenticated'; asyncKind: 'webhook'; asyncId: string; asyncRequestId: string; asyncMethod: string; asyncPath: string }
  | { type: 'engine_webhook_handler_error'; asyncKind: 'webhook'; asyncId: string; asyncRequestId: string; asyncMethod: string; asyncPath: string; asyncStatus: number; asyncReason: string; asyncDurationMs: number }
  | { type: 'engine_webhook_responded'; asyncKind: 'webhook'; asyncId: string; asyncRequestId: string; asyncMethod: string; asyncPath: string; asyncStatus: number; asyncDurationMs: number }
  | { type: 'engine_webhook_registered'; asyncKind: 'webhook'; asyncId: string; asyncOrigin: 'init' | 'runtime'; asyncDecl?: unknown }
  | { type: 'engine_webhook_deregistered'; asyncKind: 'webhook'; asyncId: string; asyncOrigin: 'init' | 'runtime'; asyncDecl?: unknown }
  | { type: 'engine_schedule_fired'; asyncKind: 'schedule'; asyncId: string; asyncDurationMs: number }
  | { type: 'engine_schedule_skipped'; asyncKind: 'schedule'; asyncId: string; asyncReason: string }
  | { type: 'engine_schedule_failed'; asyncKind: 'schedule'; asyncId: string; asyncReason: string; asyncDurationMs: number }
  | { type: 'engine_schedule_registered'; asyncKind: 'schedule'; asyncId: string; asyncOrigin: 'init' | 'runtime'; asyncDecl?: unknown }
  | { type: 'engine_schedule_deregistered'; asyncKind: 'schedule'; asyncId: string; asyncOrigin: 'init' | 'runtime'; asyncDecl?: unknown }
  | { type: 'engine_async_fire_dropped'; asyncKind: 'webhook' | 'schedule'; asyncId: string; asyncReason: string }
  // engine_command_result is emitted at the end of every Manager.SendCommand
  // dispatch — success (CommandError empty), extension-command failure
  // (CommandError = the error message), and unknown command (CommandError =
  // "unknown_command"). The `command` field carries the bare name so a
  // consumer can switch on it without reparsing prose. The desktop's prompt
  // pipeline awaits this event to decide between "dispatch landed, draw
  // the divider" and "engine disclaims, fall through to `.md` expansion".
  | { type: 'engine_command_result'; message?: string; command?: string; commandError?: string }
  // engine_export carries the rendered export output for a /export command.
  // The engine's dispatchExport emits this event with the rendered string
  // on `message` BEFORE the matching engine_command_result, so consumers
  // can capture the payload and persist it / surface a save dialog.
  // `exportFormat` is the format the engine resolved from the /export args
  // (markdown | json | html | jsonl; markdown when args is empty) — consumers
  // use it to pick a file extension / MIME type directly rather than sniffing
  // the payload bytes. See engine/internal/session/command_dispatch.go's
  // EngineEventExport constant for the wire type string declaration.
  | { type: 'engine_export'; message: string; exportFormat?: string }
  // engine_command_registry is a complete SNAPSHOT of the session's
  // extension-registered slash commands. Emitted at session_start (after
  // extensions wire up) and on every subsequent change (mid-session
  // RegisterCommand, hot reload, etc.). Consumers REPLACE their cached
  // routing-hint set with this payload. Empty `commands` is the authoritative
  // "no extension commands live for this session" signal.
  | { type: 'engine_command_registry'; commands: EngineCommandListing[] }
  // engine_early_stop_decision_request is the wire-protocol surface for the
  // before_early_stop_decision hook. Promotes the hook to the socket so
  // socket-only harnesses (desktop, custom UIs, headless tooling) can
  // participate without running a subprocess extension. The engine emits this
  // event after the model emits end_turn / stop AND after the extension-side
  // hook returned no opinion. Consumers must respond via the
  // `early_stop_decision_response` client command, supplying the same
  // fields the subprocess hook would return (all optional). The engine
  // waits at most 100ms for a response; a missed deadline is treated as
  // "no opinion" and the run proceeds with the existing merge logic.
  //
  // Field semantics mirror engine/internal/extension/EarlyStopDecisionInfo
  // verbatim; see docs/hooks/reference.md for the canonical descriptions.
  | {
      type: 'engine_early_stop_decision_request'
      earlyStopRequestId: string
      earlyStopRunId: string
      earlyStopModel: string
      earlyStopTurnNumber: number
      earlyStopStopReason: string
      earlyStopCumulativeOutput: number
      earlyStopBudget: number
      earlyStopThresholdPct: number
      earlyStopContinuationCount: number
      earlyStopMaxContinuations: number
      earlyStopLastContinuationDelta: number
      earlyStopWouldContinue: boolean
      earlyStopIsSubagent?: boolean
    }
  // engine_llm_call is the lightweight-inference observability event,
  // emitted exactly once per successful ctx.LLMCall invocation. Carries
  // model / provider / latency / token / cost / jsonMode metadata —
  // never the prompt text or response content (privacy-by-default for
  // harness-internal classification prompts). The desktop is observation-
  // only; it does NOT need to act on this, but the variant is typed so
  // any future cost-summary or telemetry-rendering work has the shape
  // ready. See engine/internal/types/types.go for the canonical Go
  // definition.
  | {
      type: 'engine_llm_call'
      llmCallModel: string
      llmCallProvider: string
      llmCallLatencyMs: number
      llmCallInputTokens: number
      llmCallOutputTokens: number
      llmCallCost: number
      llmCallJsonMode?: boolean
    }
  // engine_dispatch_start is emitted on the parent session's event stream when
  // an extension-initiated dispatch begins. Carries the agent name, task, model,
  // and child session ID. Observation-only — harnesses can use this and
  // engine_dispatch_end to persist dispatch records or surface dispatch status.
  | {
      type: 'engine_dispatch_start'
      dispatchAgent: string
      dispatchTask: string
      dispatchModel: string
      dispatchSessionId: string
    }
  // engine_dispatch_end is emitted when an extension-initiated dispatch completes
  // (success, error, or recall). Carries telemetry: exit code, elapsed time,
  // cost, tokens, and tool count.
  | {
      type: 'engine_dispatch_end'
      dispatchAgent: string
      dispatchExitCode: number
      dispatchElapsed: number
      dispatchCost: number
      dispatchInputTokens: number
      dispatchOutputTokens: number
      dispatchToolCount: number
    }
  // ─── Resource subsystem events (D-007) ───
  //
  // engine_resource_snapshot: emitted when a client subscribes to a resource
  // kind. Consumers REPLACE their local collection with resourceItems.
  //
  // engine_resource_delta: emitted when a producer publishes a change.
  // Consumers apply the delta incrementally.
  //
  // Both carry resourceKind and resourceSubId for subscription correlation.
  | {
      type: 'engine_resource_snapshot'
      resourceKind: string
      resourceSubId: string
      resourceItems: ResourceItem[]
    }
  | {
      type: 'engine_resource_delta'
      resourceKind: string
      resourceSubId: string
      resourceDelta: ResourceDelta
    }
  // ─── Notification events (D-009) ───
  //
  // engine_notification: emitted when an extension calls ctx.notify().
  // The push/pushTitle/pushBody fields trigger APNs delivery through the
  // relay when the mobile peer is not connected. The notifyKind/Title/Body
  // fields carry structured metadata for richer client handling.
  | {
      type: 'engine_notification'
      push: boolean
      pushTitle: string
      pushBody: string
      notifyKind: string
      notifyResourceId?: string
      notifyTitle: string
      notifyBody: string
      notifySound?: string
      notifyScope?: string
    }
  // ─── engine_intercept ───
  //
  // Fire-and-forget signal emitted when an extension calls ctx.intercept().
  // The engine routes the event to the target session's stream and attaches no
  // further semantics. Clients decide how to render and whether to act on the
  // level hint:
  //   "banner"   — informational, non-disruptive inline display
  //   "redirect" — urgent; client may abort the active run and re-prompt with message
  //
  // There is no "current intercept state" to query — this event fires exactly
  // once per ctx.intercept() call. Consumers must not accumulate or replace
  // state from it. See docs/protocol/server-events.md for the full field table.
  | {
      type: 'engine_intercept'
      interceptLevel: string
      interceptTitle: string
      interceptMessage: string
      interceptSource?: string
      interceptMetadata?: Record<string, unknown>
    }
