/**
 * Remote control message protocol.
 *
 * These types define the wire format for communication between Ion and
 * the iOS companion app. The same protocol is used over both LAN (direct
 * WebSocket) and relay (encrypted WebSocket via relay server).
 */

import type { NormalizedEvent, TabStatus, PermissionRequest, AgentStateUpdate, StatusFields } from '../../shared/types'

/**
 * Wire shape for one entry in `desktop_settings_snapshot.schema`.
 *
 * Mirrors `ProjectableSettingSchema` from
 * `desktop/src/main/projectable-settings-types.ts`. Declared here as a
 * named interface (rather than inlined) so the recursive `itemSchema`
 * reference can name itself — TS forbids self-references inside
 * anonymous object types.
 *
 * The recursion supports list-typed settings whose records contain
 * sub-fields. Today the per-record schemas describe only scalar leaves
 * (boolean/string/number/enum), but the wire type allows arbitrary
 * nesting so a future list-of-list shape would not require a protocol
 * bump.
 */
export interface DesktopSettingsSchemaEntry {
  key: string
  type: 'boolean' | 'string' | 'number' | 'enum' | 'list'
  group: string
  label: string
  description: string
  defaultValue: unknown
  choices?: Array<{ value: string | null; label: string }>
  range?: { min: number; max: number; step: number }
  itemSchema?: DesktopSettingsSchemaEntry[]
}

// ─── Remote Tab State (lightweight projection for mobile clients) ───

export interface RemoteTabState {
  id: string
  title: string
  customTitle: string | null
  status: TabStatus
  workingDirectory: string
  permissionMode: 'auto' | 'plan'
  permissionQueue: PermissionRequest[]
  lastMessage: string | null
  contextTokens: number | null
  modelOverride?: string | null
  messageCount: number
  queuedPrompts: string[]
  isTerminalOnly?: boolean
  isEngine?: boolean
  engineProfileId?: string | null
  engineInstances?: Array<{ id: string; label: string; waitingState?: 'plan-ready' | 'question' | null; isRunning?: boolean }>
  activeEngineInstanceId?: string | null
  terminalInstances?: TerminalInstanceInfo[]
  activeTerminalInstanceId?: string | null
  groupId?: string | null
  /** When true, auto-group movement is suppressed for this tab. */
  groupPinned?: boolean
  /** The current conversation/session ID for this tab. Engine tabs use StatusFields.sessionId instead. */
  conversationId?: string | null
  /** Unix ms timestamp of the last status-changing activity (message, status change). */
  lastActivityAt?: number
  /** Custom pill background color hex string (e.g. "#f08c4a"). Null means use theme default. */
  pillColor?: string | null
  /** Custom pill icon key (e.g. "diamond", "star"). Null means use the default status dot. */
  pillIcon?: string | null
}

// ─── Terminal instance metadata ───

export interface TerminalInstanceInfo {
  id: string
  label: string
  kind: string    // 'user' | 'commit' | 'cli' | 'tool:*'
  readOnly: boolean
  cwd: string
}

// ─── Wire-friendly message types for conversation sync ───

export interface RemoteMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  toolName?: string
  toolInput?: string
  toolId?: string
  toolStatus?: 'running' | 'completed' | 'error'
  attachments?: RemoteAttachment[]
  timestamp: number
  source?: 'desktop' | 'remote'
}

export interface RemoteAttachment {
  id: string
  type: 'image' | 'file' | 'plan'
  name: string
  path: string
}

// ─── iOS → Ion commands ───

export type RemoteCommand =
  | { type: 'sync' }
  // `pinToGroupId` is an additive optional extension (non-breaking per
  // CLAUDE.md contract rules). When set, the desktop creates the new tab
  // inside that manual group with groupPinned=true so the first prompt's
  // auto-movement doesn't yank it back into the default group. Older
  // iOS builds that omit the field continue to get the legacy behavior.
  | { type: 'create_tab'; workingDirectory?: string; pinToGroupId?: string }
  | { type: 'create_terminal_tab'; workingDirectory?: string }
  | { type: 'close_tab'; tabId: string }
  | { type: 'prompt'; tabId: string; text: string; origin?: 'desktop' | 'remote'; clientMsgId?: string; attachments?: Array<{ type: 'image' | 'file'; name: string; path: string }>; implementationPhase?: boolean }
  | { type: 'cancel'; tabId: string }
  | { type: 'respond_permission'; tabId: string; questionId: string; optionId: string }
  | { type: 'set_permission_mode'; tabId: string; mode: 'auto' | 'plan' }
  | { type: 'reset_tab_session'; tabId: string }
  // Engine-instance counterpart to reset_tab_session: stops the engine
  // session keyed by `${tabId}:${instanceId}` and wipes the renderer-side
  // per-instance state (messages, status, dialogs, etc.) without removing
  // the instance pane itself. iOS sends this for engine tabs when the
  // user picks "Implement, clear context" on the plan-approval card —
  // `reset_tab_session` only addresses the CLI session plane and silently
  // misses engine instances.
  | { type: 'reset_engine_session'; tabId: string; instanceId: string }
  | { type: 'load_conversation'; tabId: string; before?: string }
  | { type: 'terminal_input'; tabId: string; instanceId: string; data: string }
  | { type: 'terminal_resize'; tabId: string; instanceId: string; cols: number; rows: number }
  | { type: 'terminal_add_instance'; tabId: string }
  | { type: 'terminal_remove_instance'; tabId: string; instanceId: string }
  | { type: 'terminal_select_instance'; tabId: string; instanceId: string }
  | { type: 'request_terminal_snapshot'; tabId: string }
  | { type: 'rename_tab'; tabId: string; customTitle: string | null }
  | { type: 'rename_terminal_instance'; tabId: string; instanceId: string; label: string }
  | { type: 'rewind'; tabId: string; messageId: string }
  | { type: 'fork_from_message'; tabId: string; messageId: string }
  | { type: 'create_engine_tab'; workingDirectory?: string; profileId?: string }
  | { type: 'engine_prompt'; tabId: string; instanceId?: string; text: string; attachments?: Array<{ type: 'image' | 'file'; name: string; path: string }>; implementationPhase?: boolean }
  | { type: 'engine_abort'; tabId: string; instanceId?: string }
  | { type: 'engine_dialog_response'; tabId: string; instanceId?: string; dialogId: string; value: any }
  | { type: 'engine_add_instance'; tabId: string }
  | { type: 'engine_remove_instance'; tabId: string; instanceId: string }
  | { type: 'engine_select_instance'; tabId: string; instanceId: string }
  | { type: 'engine_move_instance'; sourceTabId: string; instanceId: string; targetTabId: string }
  | { type: 'engine_set_model'; tabId: string; instanceId?: string; model: string }
  | { type: 'load_engine_conversation'; tabId: string; instanceId?: string }
  | { type: 'load_agent_conversation'; conversationIds: string[] }
  | { type: 'set_tab_group_mode'; mode: 'auto' | 'manual' }
  | { type: 'move_tab_to_group'; tabId: string; groupId: string }
  | { type: 'toggle_tab_group_pin'; tabId: string }
  | { type: 'reorder_tab_groups'; orderedIds: string[] }
  | { type: 'set_tab_model'; tabId: string; model: string }
  | { type: 'load_attachments'; tabId: string }
  | { type: 'set_preferred_model'; model: string }
  | { type: 'set_engine_default_model'; model: string }
  | { type: 'unpair' }
  | { type: 'git_changes'; directory: string }
  | { type: 'git_graph'; directory: string; skip?: number; limit?: number }
  | { type: 'git_diff'; directory: string; path: string; staged: boolean }
  | { type: 'git_stage'; directory: string; paths: string[] }
  | { type: 'git_unstage'; directory: string; paths: string[] }
  | { type: 'git_commit'; directory: string; message: string }
  | { type: 'git_discard'; directory: string; paths: string[] }
  | { type: 'git_fetch'; directory: string }
  | { type: 'git_pull'; directory: string }
  | { type: 'git_push'; directory: string }
  | { type: 'git_commit_files'; directory: string; hash: string }
  | { type: 'git_commit_file_diff'; directory: string; hash: string; path: string }
  | { type: 'fs_list_dir'; directory: string; includeHidden?: boolean }
  | { type: 'fs_read_file'; filePath: string }
  | { type: 'fs_read_image'; filePath: string }
  | { type: 'fs_write_file'; filePath: string; content: string }
  // Rename a file or directory inside a project root. Both `oldPath` and
  // `newPath` are validated by `isValidProjectPath` on the desktop;
  // failures surface via `fs_rename_result` with `ok: false` rather than
  // throwing. This is purely a client↔harness wire — the engine has no
  // notion of a "file explorer" and never sees these commands.
  | { type: 'fs_rename'; oldPath: string; newPath: string }
  | { type: 'discover_commands'; directory: string }
  | { type: 'upload_attachment'; dataUrl: string; name: string; correlationId?: string }
  | { type: 'voice_config'; enabled: boolean; mode: 'client' | 'desktop'; systemPrompt?: string }
  | { type: 'diagnostic_logs_response'; logs: string; deviceId: string; deviceName: string }
  | { type: 'set_remote_display'; customName: string | null; customIcon: string | null; updatedAt: number }
  // ─── Desktop settings projection (Part 7) ───────────────────────────
  // Write-back path for the per-desktop settings the iOS Settings tab
  // surfaces. The desktop validates `key` against the allowlist in
  // `desktop/src/main/projectable-settings.ts` and validates `value`
  // matches the declared type before persisting via `writeSettings`.
  // Unknown keys and wrong-type values are silently rejected (logged
  // but not applied). After a successful write, the desktop broadcasts
  // a fresh `desktop_settings_snapshot` to every connected pairing so
  // every iOS instance sees the new value.
  //
  // The `value` carries arbitrary JSON shapes today (booleans only in
  // the initial allowlist, but the wire is shape-agnostic so future
  // string/number projections need no protocol change). Consumers must
  // tolerate types they don't recognize by ignoring the entry rather
  // than erroring — same forward-compat posture as the rest of the
  // RemoteCommand union.
  | { type: 'set_desktop_setting'; key: string; value: unknown }
  | { type: 'set_pill_color'; tabId: string; pillColor: string | null }
  | { type: 'set_pill_icon'; tabId: string; pillIcon: string | null }

// ─── Ion → iOS events ───

export type RemoteEvent =
  | { type: 'snapshot'; tabs: RemoteTabState[]; recentDirectories?: string[]; tabGroupMode?: 'off' | 'auto' | 'manual'; tabGroups?: Array<{ id: string; label: string; isDefault: boolean; order: number }>; preferredModel?: string; engineDefaultModel?: string; availableModels?: Array<{ id: string; providerId: string; label: string; contextWindow: number; hasAuth: boolean }>; customName?: string | null; customIcon?: string | null; remoteDisplayUpdatedAt?: number }
  | { type: 'tab_created'; tab: RemoteTabState }
  | { type: 'tab_closed'; tabId: string }
  | { type: 'tab_status'; tabId: string; status: TabStatus }
  | { type: 'text_chunk'; tabId: string; text: string }
  | { type: 'tool_call'; tabId: string; toolName: string; toolId: string }
  | { type: 'tool_result'; tabId: string; toolId: string; content: string; isError: boolean }
  | { type: 'task_complete'; tabId: string; result: string; costUsd: number }
  | { type: 'permission_request'; tabId: string; questionId: string; toolName: string; toolInput?: Record<string, unknown>; options: Array<{ id: string; label: string; kind?: string }> }
  | { type: 'permission_resolved'; tabId: string; questionId: string }
  | { type: 'error'; tabId: string; message: string }
  | { type: 'conversation_history'; tabId: string; messages: RemoteMessage[]; hasMore: boolean; cursor?: string }
  | { type: 'message_added'; tabId: string; message: RemoteMessage }
  | { type: 'message_updated'; tabId: string; messageId: string; content?: string; toolStatus?: 'running' | 'completed' | 'error'; toolInput?: string }
  | { type: 'queue_update'; tabId: string; prompts: string[] }
  | { type: 'terminal_output'; tabId: string; instanceId: string; data: string }
  | { type: 'terminal_exit'; tabId: string; instanceId: string; exitCode: number }
  | { type: 'terminal_instance_added'; tabId: string; instance: TerminalInstanceInfo }
  | { type: 'terminal_instance_removed'; tabId: string; instanceId: string }
  | { type: 'terminal_snapshot'; tabId: string; instances: TerminalInstanceInfo[]; activeInstanceId: string | null; buffers?: Record<string, string> }
  | { type: 'engine_agent_state'; tabId: string; instanceId?: string | null; agents: AgentStateUpdate[] }
  | { type: 'engine_status'; tabId: string; instanceId?: string | null; fields: StatusFields; metadata?: Record<string, unknown> }
  | { type: 'engine_working_message'; tabId: string; instanceId?: string | null; message: string; metadata?: Record<string, unknown> }
  | { type: 'engine_notify'; tabId: string; instanceId?: string | null; message: string; level: string; metadata?: Record<string, unknown> }
  | { type: 'engine_dialog'; tabId: string; instanceId?: string | null; dialogId: string; method: string; title: string; message?: string; options?: string[]; defaultValue?: string }
  | { type: 'engine_dialog_resolved'; tabId: string; instanceId?: string | null; dialogId: string }
  | { type: 'engine_text_delta'; tabId: string; instanceId?: string | null; text: string }
  | { type: 'engine_message_end'; tabId: string; instanceId?: string | null; usage: { inputTokens: number; outputTokens: number; contextPercent: number; cost: number } }
  // `metadata` is an opaque pass-through hint map forwarded from the engine.
  // Carried verbatim across the relay to iOS so future iOS-side handlers
  // (e.g. dedup, render-style hints) can adopt the same conventions the
  // desktop renderer honors without a protocol break. See
  // docs/protocol/server-events.md for well-known keys.
  | { type: 'engine_harness_message'; tabId: string; instanceId?: string | null; message: string; source?: string; metadata?: Record<string, unknown> }
  | { type: 'engine_tool_start'; tabId: string; instanceId?: string | null; toolName: string; toolId: string }
  | { type: 'engine_tool_end'; tabId: string; instanceId?: string | null; toolId: string; result?: string; isError?: boolean }
  | { type: 'engine_tool_stalled'; tabId: string; instanceId?: string | null; toolId: string; toolName: string; elapsed: number }
  | { type: 'engine_model_override'; tabId: string; instanceId?: string | null; model: string }
  | { type: 'engine_dead'; tabId: string; instanceId?: string | null; exitCode: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'engine_error'; tabId: string; instanceId?: string | null; message: string }
  | { type: 'engine_instance_added'; tabId: string; instance: { id: string; label: string } }
  | { type: 'engine_instance_removed'; tabId: string; instanceId: string }
  | { type: 'engine_instance_moved'; sourceTabId: string; instanceId: string; targetTabId: string }
  | { type: 'engine_conversation_history'; tabId: string; instanceId?: string | null; messages: Array<{ id: string; role: string; content: string; toolName?: string; toolId?: string; toolStatus?: string; timestamp: number; dedupKey?: string }> }
  | { type: 'agent_conversation_history'; agentName: string; conversationId?: string; messages: Array<{ id: string; role: string; content: string; toolName?: string; toolId?: string; toolStatus?: string; timestamp: number }> }
  | { type: 'input_prefill'; tabId: string; text: string; switchTo?: boolean }
  | { type: 'engine_profiles'; profiles: Array<{ id: string; name: string; extensions: string[] }> }
  // ─── Desktop settings projection (Part 7) ───────────────────────────
  // Snapshot of the desktop's projectable user preferences. Emitted once
  // on initial pairing (alongside `snapshot`) and on every subsequent
  // local change to a projectable key. The payload carries three things:
  //
  //   - `settings`: the current value of every entry in the allowlist
  //     (`Record<key, unknown>`). Consumers REPLACE their cached view
  //     with this payload (snapshot semantics — never merge). Missing
  //     keys would indicate the projection is broken; clients should
  //     treat them defensively.
  //
  //   - `schema`: the per-key metadata (type, group, label, description,
  //     defaultValue) iOS uses to render the Settings detail view. Sent
  //     on every snapshot so iOS auto-renders new settings without a
  //     Swift code change — adding a setting on the desktop requires
  //     only an entry in `projectable-settings.ts`. The iOS UI tolerates
  //     unknown `group` values by falling back to a generic "Other"
  //     section.
  //
  //   - `groups`: ordered group descriptors. iOS renders one List
  //     section per group in this order. Same forward-compat: re-
  //     ordering or adding a group requires no iOS code change.
  //
  // Per-desktop scoping: iOS shows settings for the currently-connected
  // desktop only. Each desktop emits its own snapshot; an iOS device
  // paired with multiple desktops sees a different payload from each.
  // The desktop's display name (carried by `snapshot.customName` or the
  // pairing record) labels which desktop the values belong to.
  | {
      type: 'desktop_settings_snapshot'
      settings: Record<string, unknown>
      schema: Array<DesktopSettingsSchemaEntry>
      groups: Array<{ id: string; label: string }>
    }
  | { type: 'heartbeat'; seq: number; ts: number; buffered: number }
  | { type: 'unpair' }
  | { type: 'relay_config'; relayUrl: string; relayApiKey: string }
  | { type: 'remote_display'; customName: string | null; customIcon: string | null; updatedAt: number }
  | { type: 'git_changes_response'; directory: string; files: Array<{ path: string; status: string; staged: boolean; oldPath?: string }>; branch: string; isGitRepo: boolean; ahead: number; behind: number; stagedCount?: number; unstagedCount?: number }
  | { type: 'git_graph_response'; directory: string; commits: Array<{ hash: string; fullHash: string; parents: string[]; authorName: string; authorDate: string; subject: string; refs: Array<{ name: string; type: string; isCurrent: boolean }> }>; isGitRepo: boolean; totalCount: number; graphLayout?: Array<{ lane: number; color: string; hasIncoming: boolean; connections: Array<{ fromLane: number; toLane: number; type: 'straight' | 'merge' | 'fork'; color: string }>; passThroughLanes: Array<{ lane: number; color: string }> }> }
  | { type: 'git_diff_response'; diff: string; fileName: string }
  | { type: 'git_commit_result'; directory: string; ok: boolean; error?: string }
  | { type: 'git_stage_result'; directory: string; ok: boolean; error?: string }
  | { type: 'git_unstage_result'; directory: string; ok: boolean; error?: string }
  | { type: 'git_commit_files_response'; directory: string; hash: string; files: Array<{ path: string; status: string; oldPath?: string }>; stats: { filesChanged: number; insertions: number; deletions: number } }
  | { type: 'git_commit_file_diff_response'; hash: string; path: string; diff: string; fileName: string }
  | { type: 'fs_dir_listing'; directory: string; entries: Array<{ name: string; path: string; isDirectory: boolean; size: number; modifiedMs: number }>; error?: string }
  | { type: 'fs_file_content'; filePath: string; content: string | null; error?: string }
  | { type: 'fs_image_content'; filePath: string; dataUrl: string | null; error?: string }
  | { type: 'fs_write_result'; filePath: string; ok: boolean; error?: string }
  // Result of an fs_rename command. iOS uses this to refresh the parent
  // directory listing on success and to surface errors. The shape mirrors
  // `fs_write_result` deliberately: ok-flag plus optional error string.
  | { type: 'fs_rename_result'; oldPath: string; newPath: string; ok: boolean; error?: string }
  | { type: 'upload_attachment_result'; id: string; name: string; path: string; correlationId?: string; error?: string }
  | { type: 'discover_commands_response'; directory: string; commands: Array<{ name: string; description: string; scope: 'user' | 'project'; source: 'command' | 'skill' }> }
  | { type: 'tab_attachments'; tabId: string; attachments: Array<{ type: string; name: string; path: string }> }
  | { type: 'request_diagnostic_logs' }

// ─── Relay control frames (injected by relay, not by Ion) ───

export interface RelayControlMessage {
  type: 'relay:peer-disconnected' | 'relay:peer-reconnected' | 'relay:paired' | 'relay:ping' | 'relay:pong'
}

// ─── Wire envelope (wraps RemoteEvent for relay transport) ───

export interface WireMessage {
  seq: number
  ts: number               // Unix ms timestamp
  payload?: string         // JSON-encoded RemoteEvent or RemoteCommand (absent when encrypted)
  push?: boolean           // hint to relay: send APNs push if peer is disconnected
  pushTitle?: string       // notification title (used by relay when push=true)
  pushBody?: string        // notification body (used by relay when push=true)
  nonce?: string           // base64 12-byte nonce (present when encrypted)
  ciphertext?: string      // base64 encrypted payload (replaces `payload` when encrypted)
  deviceId?: string        // identifies the sending device (set by transport)
}

// ─── Auth handshake (exchanged before any data flows) ───

export interface AuthChallenge {
  type: 'auth_challenge'
  nonce: string            // base64-encoded 32 random bytes
}

export interface AuthResponse {
  type: 'auth_response'
  deviceId: string         // paired device ID
  proof: string            // HMAC-SHA256(nonce, sharedSecret), base64
}

export interface AuthResult {
  type: 'auth_result'
  success: boolean
  reason?: string
}

export type AuthMessage = AuthChallenge | AuthResponse | AuthResult

// ─── Paired device record ───

export interface PairedDevice {
  id: string
  name: string
  pairedAt: string
  lastSeen: string | null
  channelId: string
  /** Base64-encoded shared secret (NaCl secretbox key) */
  sharedSecret: string
  /** APNs device token for push notifications */
  apnsToken?: string
  /**
   * Per-desktop display override cached on the iOS side. Not authoritative —
   * the desktop owns the value via the top-level `remoteDisplay` settings
   * record. Present here only to mirror the iOS PairedDevice struct.
   * Identifier from the curated icon set: "desktop", "laptop", "macmini",
   * "macpro", "display", "server", "terminal", "briefcase", "house",
   * "gamepad". Unknown values render as the default desktop glyph.
   */
  customName?: string | null
  customIcon?: string | null
}

// ─── Transport state ───

export type TransportState = 'disconnected' | 'relay_only' | 'lan_preferred'

// ─── Helper: convert NormalizedEvent to RemoteEvent ───

export function normalizedToRemote(tabId: string, event: NormalizedEvent): RemoteEvent | null {
  switch (event.type) {
    case 'text_chunk':
      return { type: 'text_chunk', tabId, text: event.text }
    case 'tool_call':
      return { type: 'tool_call', tabId, toolName: event.toolName, toolId: event.toolId }
    case 'tool_result':
      return { type: 'tool_result', tabId, toolId: event.toolId, content: event.content, isError: event.isError }
    case 'task_complete':
      return { type: 'task_complete', tabId, result: event.result, costUsd: event.costUsd }
    case 'permission_request':
      return {
        type: 'permission_request',
        tabId,
        questionId: event.questionId,
        toolName: event.toolName,
        toolInput: event.toolInput,
        options: event.options,
      }
    case 'error':
      return { type: 'error', tabId, message: event.message }
    default:
      return null
  }
}

// ─── Helper: convert NormalizedEvent to structured message events ───

export function normalizedToMessages(tabId: string, event: NormalizedEvent): RemoteEvent | null {
  switch (event.type) {
    case 'text_chunk':
      // Text chunks update the last assistant message (handled by caller that tracks message state)
      return null
    case 'tool_call':
      return {
        type: 'message_added',
        tabId,
        message: {
          id: event.toolId,
          role: 'tool',
          content: '',
          toolName: event.toolName,
          toolId: event.toolId,
          toolStatus: 'running',
          timestamp: Date.now(),
        },
      }
    case 'tool_result': {
      const content = event.content.length > 2048
        ? event.content.substring(0, 2048) + '\n... [truncated]'
        : event.content
      return {
        type: 'message_updated',
        tabId,
        messageId: event.toolId,
        content,
        toolStatus: event.isError ? 'error' : 'completed',
      }
    }
    default:
      return null
  }
}
