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

export type EngineEvent =
  | { type: 'engine_agent_state'; agents: AgentStateUpdate[] }
  | { type: 'engine_status'; fields: StatusFields }
  | { type: 'engine_working_message'; message: string }
  | { type: 'engine_notify'; message: string; level: 'info' | 'warning' | 'error' }
  | { type: 'engine_dialog'; dialogId: string; method: 'select' | 'confirm' | 'input'; title: string; message?: string; options?: string[]; defaultValue?: string }
  | { type: 'engine_harness_message'; message: string; source?: string }
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
  | { type: 'engine_extension_died'; extensionName: string; exitCode: number | null; signal: string | null }
  | { type: 'engine_extension_respawned'; extensionName: string; attemptNumber: number }
  | { type: 'engine_events_dropped'; count: number }
  | { type: 'engine_extension_dead_permanent'; extensionName: string; attemptNumber: number }
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
