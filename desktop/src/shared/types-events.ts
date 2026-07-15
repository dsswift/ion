// ─── Command Discovery ───

export interface DiscoveredCommand {
  name: string
  description: string
  scope: 'user' | 'project'
  source: 'command' | 'skill'
  /**
   * Which directory family this command was discovered from:
   *   - `'ion'`    → `~/.ion/commands/` or `{project}/.ion/commands/`
   *   - `'claude'` → `~/.claude/commands/`, `{project}/.claude/commands/`,
   *                  or `~/.claude/skills/`
   *
   * Consumers use this to filter out `'claude'` entries when the
   * `enableClaudeCompat` setting is disabled. Ion-native commands are
   * always available; only Claude-compat entries are gated by the
   * setting. See `desktop/src/main/ipc/sessions-list.ts` and
   * `desktop/src/main/remote/handlers/tabs.ts` for the filter logic.
   */
  origin: 'ion' | 'claude'
}

/**
 * Raw shape of one entry in the engine's `discover_slash_commands` reply.
 *
 * The engine OWNS slash-command resolution and is therefore the authority on
 * which filesystem `.md`/skill templates exist. Its taxonomy is richer than
 * the desktop's `DiscoveredCommand` (origin/scope) split, so the engine
 * bridge maps this onto `DiscoveredCommand` for the autocomplete menu.
 *
 * `source` is one of:
 *   - "extension" → an engine extension command (rare in this listing; the
 *                   desktop unions the extension registry separately)
 *   - "ion"       → `.ion/commands/`
 *   - "claude"    → `.claude/commands/`
 *   - "skill"     → a skill template (SKILL.md)
 *   - "project"   → a project-root-scoped template
 */
export interface EngineDiscoveredCommand {
  name: string
  description?: string
  argumentHint?: string
  source?: 'extension' | 'ion' | 'claude' | 'skill' | 'project'
}

// ─── CLI Backend Stream Event Types ───

export interface InitEvent {
  type: 'system'
  subtype: 'init'
  cwd: string
  session_id: string
  tools: string[]
  mcp_servers: Array<{ name: string; status: string }>
  model: string
  permissionMode: string
  agents: string[]
  skills: string[]
  plugins: string[]
  claude_code_version: string
  fast_mode_state: string
  uuid: string
}

export interface StreamEvent {
  type: 'stream_event'
  event: StreamSubEvent
  session_id: string
  parent_tool_use_id: string | null
  uuid: string
}

export type StreamSubEvent =
  | { type: 'message_start'; message: AssistantMessagePayload }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | { type: 'content_block_delta'; index: number; delta: ContentDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string | null }; usage: UsageData; context_management?: unknown }
  | { type: 'message_stop' }

export interface ContentBlock {
  type: 'text' | 'tool_use'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

export type ContentDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }

export interface AssistantEvent {
  type: 'assistant'
  message: AssistantMessagePayload
  parent_tool_use_id: string | null
  session_id: string
  uuid: string
}

export interface AssistantMessagePayload {
  model: string
  id: string
  role: 'assistant'
  content: ContentBlock[]
  stop_reason: string | null
  usage: UsageData
}

export interface RateLimitEvent {
  type: 'rate_limit_event'
  rate_limit_info: {
    status: string
    resetsAt: number
    rateLimitType: string
  }
  session_id: string
  uuid: string
}

export interface ResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  is_error: boolean
  duration_ms: number
  num_turns: number
  result: string
  total_cost_usd: number
  session_id: string
  usage: UsageData & {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  permission_denials: string[]
  uuid: string
}

export interface UsageData {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  service_tier?: string
}

export interface PermissionEvent {
  type: 'permission_request'
  tool: { name: string; description?: string; input?: Record<string, unknown> }
  question_id: string
  options: Array<{ id: string; label: string; kind?: string }>
  session_id: string
  uuid: string
}

// Union of all possible top-level events
export type ClaudeEvent = InitEvent | StreamEvent | AssistantEvent | RateLimitEvent | ResultEvent | PermissionEvent | UnknownEvent

export interface UnknownEvent {
  type: string
  [key: string]: unknown
}

// ─── Canonical Events (normalized from raw stream) ───
export type NormalizedEvent =
  | { type: 'session_init'; sessionId: string; tools: string[]; model: string; mcpServers: Array<{ name: string; status: string }>; skills: string[]; version: string; isWarmup?: boolean }
  | { type: 'text_chunk'; text: string }
  | { type: 'tool_call'; toolName: string; toolId: string; index: number }
  | { type: 'tool_call_update'; toolId: string; partialInput: string }
  | { type: 'tool_call_complete'; index: number }
  | { type: 'tool_result'; toolId: string; content: string; isError: boolean }
  | { type: 'task_update'; message: AssistantMessagePayload }
  | { type: 'task_complete'; result: string; lastText?: string; costUsd: number; durationMs: number; numTurns: number; conversationTurns?: number; usage: UsageData; sessionId: string; permissionDenials?: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> }
  | { type: 'error'; message: string; isError: boolean; sessionId?: string; errorCode?: string; retryable?: boolean; retryAfterMs?: number; httpStatus?: number }
  | { type: 'session_dead'; exitCode: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'rate_limit'; status: string; resetsAt: number; rateLimitType: string }
  | { type: 'usage'; usage: UsageData }
  | { type: 'permission_request'; questionId: string; toolName: string; toolDescription?: string; toolInput?: Record<string, unknown>; options: Array<{ id: string; label: string; kind?: string }> }
  | { type: 'plan_mode_changed'; enabled: boolean; planFilePath?: string; planSlug?: string }
  | { type: 'plan_mode_auto_exit'; stopReason: string; planFilePath?: string; planSlug?: string; reason?: string; sessionId?: string; runId?: string }
  | { type: 'stream_reset' }
  | { type: 'compacting'; active: boolean; summary?: string; messagesBefore?: number; messagesAfter?: number; clearedBlocks?: number; strategy?: string; microOnly?: boolean }
  | { type: 'tool_stalled'; toolId: string; toolName: string; elapsed: number }
  | { type: 'steer_injected'; messageLength: number }
  | { type: 'model_fallback'; requestedModel: string; fallbackModel: string; reason: string }
  | { type: 'run_stalled'; stalledDuration: number; lastActivity?: string }
  // Extended-thinking events (issue #158), normalized-stream layer. These are
  // the bare-name desktop-internal events the renderer consumes for PLAIN
  // conversations. The control plane (engine-control-plane-events.ts)
  // translates the engine-wire `engine_thinking_*` events into these so
  // `event-slice.ts` can materialize `role: 'thinking'` rows — mirroring the
  // extension-hosted path, where engine-event-slice.ts consumes the
  // `engine_thinking_*` events directly. A thinking block is OPTIONAL per turn;
  // boundaries (start/end) always arrive when reasoning happened, the delta may
  // be suppressed engine-side (summary-only path). See ThinkingBlock.tsx.
  | { type: 'thinking_block_start' }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_block_end'; totalTokens?: number; elapsedSeconds?: number; redacted?: boolean }
  // Extension-surface events (WI-001: single-path collapse).
  // Previously handled only by the raw engine_* stream; now first-class
  // NormalizedEvent variants so every conversation flows through the
  // single normalized reducer (handleNormalizedEvent in event-slice.ts).
  | { type: 'message_end'; inputTokens?: number; outputTokens?: number; contextPercent?: number; cost?: number }
  | { type: 'agent_state'; agents: import('./types-engine').AgentStateUpdate[] }
  // status — desktop-internal per-session status snapshot. Emitted by the
  // control plane (engine-control-plane-events.ts handleStatusEvent) from every
  // inbound engine_status, carrying the engine's full StatusFields. The renderer
  // REPLACES inst.statusFields wholesale (snapshot semantics, like agent_state).
  // This is the forwarding hop that populates inst.statusFields — without it the
  // field is null forever and every StatusBar slot that reads it (engine
  // identity, cost, backend badge, model-picker actual-model parenthetical)
  // renders nothing. Desktop-internal: no Go struct backing (StatusFields itself
  // is the synced shared type), so no contract-sync manifest entry.
  | { type: 'status'; fields: import('./types-engine').StatusFields }
  | { type: 'harness_message'; message: string; dedupKey?: string; source?: string }
  | { type: 'working_message'; message: string }
  | { type: 'notify'; message: string; level: string }
  | { type: 'dialog'; dialogId: string; method: string; title: string; options?: string[]; defaultValue?: string }
  // Extension elicitation (ctx.elicit). Translated from the engine-wire
  // `engine_elicitation_request` event by engine-control-plane-events.ts so
  // the single normalized reducer (event-slice.ts) can push it onto the
  // active instance's elicitationQueue.
  | { type: 'elicitation_request'; requestId: string; mode: string; schema?: Record<string, unknown>; url?: string }
  | { type: 'extension_died'; extensionName: string }
  | { type: 'extension_respawned'; extensionName: string; attemptNumber: number }
  | { type: 'extension_dead_permanent'; extensionName: string; attemptNumber: number }
  | { type: 'events_dropped'; count: number }
  // Dispatch telemetry (n-tier nested dispatch). Emitted by the control plane
  // from engine_dispatch_start/end so the renderer can record dispatch depth
  // and parent linkage for tree rendering in the AgentPanel.
  | { type: 'dispatch_start'; dispatchAgent: string; dispatchTask: string; dispatchModel: string; dispatchSessionId: string; dispatchDepth: number; dispatchParentId: string; dispatchId: string }
  | { type: 'dispatch_end'; dispatchAgent: string; dispatchExitCode: number; dispatchElapsed: number; dispatchCost: number; dispatchInputTokens?: number; dispatchOutputTokens?: number; dispatchToolCount?: number; dispatchDepth: number; dispatchParentId: string; dispatchId: string; dispatchConversationId?: string }
  // Cross-cutting events (WI-001): previously handled via raw IPC.ENGINE_EVENT,
  // now routed through the normalized stream so the renderer has a single
  // subscription. These are desktop-internal variants with no Go struct backing;
  // they are emitted by wireEngineBridgeEvents (main process) and consumed by
  // handleCrossNormalizedEvent (renderer) without touching conversation state.
  // The `tabId` carried on the normalized-event envelope is the session key
  // (bare tabId for session events, empty string for workspace-scoped events).
  | { type: 'command_registry'; commands: Array<{ name: string; description?: string }> }
  | { type: 'command_result'; command: string; commandError?: string }
  | { type: 'resource_snapshot'; resourceKind: string; resourceSubId?: string; resourceItems: import('./types-engine').ResourceItem[] }
  | { type: 'resource_delta'; resourceKind: string; resourceDelta: import('./types-engine').ResourceDelta }
  | { type: 'engine_notification'; notificationTitle: string; notificationBody: string; notificationLevel: string }
  // dispatch_activity — a running dispatched (sub-)agent's intra-turn transcript
  // delta (tool start/end, streamed text), bridged from the engine's
  // engine_dispatch_activity (event-wiring.ts). Cross-cutting: the agent popup
  // folds it into the per-dispatch transcript cache keyed by
  // dispatchAgentId/conversationId; it must never append to the main conversation
  // message stream. INCREMENTAL/append-by-key — see agent-dispatch-activity.ts.
  | { type: 'dispatch_activity'; dispatchAgentId: string; dispatchConversationId: string; dispatchActivityKind: 'text' | 'tool_start' | 'tool_end'; dispatchSeq: number; toolName?: string; toolId?: string; dispatchTextDelta?: string; dispatchToolIsError?: boolean; dispatchActivityTs?: number }
  // context_breakdown — per-category token breakdown from engine_context_breakdown.
  // Emitted after prompt assembly; reconciled (apiReportedTotal/unaccounted) after
  // the first usage event. Desktop-internal: translated from the engine wire in
  // event-wiring.ts and stored on the active instance (event-slice.ts case
  // 'context_breakdown') so the Status Drawer can render it synchronously.
  | { type: 'context_breakdown'; categories: import('./types-engine').ContextBreakdownCategory[]; contextWindow: number; totalTokens: number; apiReportedTotal?: number; unaccounted?: number; cacheReadTokens?: number; cacheCreationTokens?: number; model: string; aggregateCostUsd?: number; modelBreakdown?: import('./types-engine').ModelBreakdown[] }
