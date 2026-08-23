// ─── Command Discovery ───

export interface DiscoveredCommand {
  name: string;
  description: string;
  scope: "user" | "project";
  source: "command" | "skill";
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
  origin: "ion" | "claude";
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
  name: string;
  description?: string;
  argumentHint?: string;
  source?: "extension" | "ion" | "claude" | "skill" | "project";
}

// ─── CLI Backend Stream Event Types ───

export interface InitEvent {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  mcp_servers: Array<{ name: string; status: string }>;
  model: string;
  permissionMode: string;
  agents: string[];
  skills: string[];
  plugins: string[];
  claude_code_version: string;
  fast_mode_state: string;
  uuid: string;
}

export interface StreamEvent {
  type: "stream_event";
  event: StreamSubEvent;
  session_id: string;
  parent_tool_use_id: string | null;
  uuid: string;
}

export type StreamSubEvent =
  | { type: "message_start"; message: AssistantMessagePayload }
  | { type: "content_block_start"; index: number; content_block: ContentBlock }
  | { type: "content_block_delta"; index: number; delta: ContentDelta }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: string | null };
      usage: UsageData;
      context_management?: unknown;
    }
  | { type: "message_stop" };

export interface ContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export type ContentDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string };

export interface AssistantEvent {
  type: "assistant";
  message: AssistantMessagePayload;
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
}

export interface AssistantMessagePayload {
  model: string;
  id: string;
  role: "assistant";
  content: ContentBlock[];
  stop_reason: string | null;
  usage: UsageData;
}

export interface RateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: {
    status: string;
    resetsAt: number;
    rateLimitType: string;
  };
  session_id: string;
  uuid: string;
}

export interface ResultEvent {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  num_turns: number;
  result: string;
  total_cost_usd: number;
  session_id: string;
  usage: UsageData & {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  permission_denials: string[];
  uuid: string;
}

export interface UsageData {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  service_tier?: string;
}

export interface PermissionEvent {
  type: "permission_request";
  tool: { name: string; description?: string; input?: Record<string, unknown> };
  question_id: string;
  options: Array<{ id: string; label: string; kind?: string }>;
  session_id: string;
  uuid: string;
}

// Union of all possible top-level events
export type ClaudeEvent =
  | InitEvent
  | StreamEvent
  | AssistantEvent
  | RateLimitEvent
  | ResultEvent
  | PermissionEvent
  | UnknownEvent;

export interface UnknownEvent {
  type: string;
  [key: string]: unknown;
}
