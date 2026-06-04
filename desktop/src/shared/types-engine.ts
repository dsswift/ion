// ─── Engine Types (native Ion extension runtime) ───

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
}

export interface EngineInstance {
  id: string        // crypto.randomUUID().slice(0,8)
  label: string     // "cos 1", "cos 2"
}

export interface EnginePaneState {
  instances: EngineInstance[]
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
  | { type: 'engine_extension_died'; extensionName: string; exitCode: number | null; signal: string | null }
  | { type: 'engine_extension_respawned'; extensionName: string; attemptNumber: number }
  | { type: 'engine_events_dropped'; count: number }
  | { type: 'engine_extension_dead_permanent'; extensionName: string; attemptNumber: number }
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
