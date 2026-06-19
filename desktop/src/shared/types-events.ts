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
  | { type: 'task_complete'; result: string; costUsd: number; durationMs: number; numTurns: number; usage: UsageData; sessionId: string; permissionDenials?: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> }
  | { type: 'error'; message: string; isError: boolean; sessionId?: string; errorCode?: string; retryable?: boolean; retryAfterMs?: number; httpStatus?: number }
  | { type: 'session_dead'; exitCode: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'rate_limit'; status: string; resetsAt: number; rateLimitType: string }
  | { type: 'usage'; usage: UsageData }
  | { type: 'permission_request'; questionId: string; toolName: string; toolDescription?: string; toolInput?: Record<string, unknown>; options: Array<{ id: string; label: string; kind?: string }> }
  | { type: 'plan_mode_changed'; enabled: boolean; planFilePath?: string; planSlug?: string }
  | { type: 'plan_mode_auto_exit'; stopReason: string; planFilePath?: string; planSlug?: string; reason?: string; sessionId?: string; runId?: string }
  | { type: 'stream_reset' }
  | { type: 'compacting'; active: boolean; summary?: string; messagesBefore?: number; messagesAfter?: number; clearedBlocks?: number; strategy?: string }
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
