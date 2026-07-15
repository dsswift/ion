/**
 * Remote control message protocol.
 *
 * These types define the wire format for communication between Ion and
 * the iOS companion app. The same protocol is used over both LAN (direct
 * WebSocket) and relay (encrypted WebSocket via relay server).
 *
 * Naming convention: every RemoteEvent and RemoteCommand type string carries
 * the `desktop_` prefix, marking the desktop as the owner of this wire
 * contract. Engine wire events (EngineEvent) are owned by the engine and
 * carry the `engine_` prefix — the two namespaces are disjoint.
 */

import type { NormalizedEvent, TabStatus, AgentStateUpdate, StatusFields } from '../../shared/types'
import type { RemoteTabState, RemoteMessage, TerminalInstanceInfo } from './protocol-remote-tab'

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

// ─── Remote Tab State + message types — extracted for line-cap ───
// All types re-exported so existing import paths remain valid.
export type { RemoteTabState, TerminalInstanceInfo, RemoteMessage, RemoteAttachment } from './protocol-remote-tab'

// ─── iOS → Ion commands ───

export type RemoteCommand =
  | { type: 'desktop_sync' }
  // `pinToGroupId` is an additive optional extension (non-breaking per
  // CLAUDE.md contract rules). When set, the desktop creates the new tab
  // inside that manual group with groupPinned=true so the first prompt's
  // auto-movement doesn't yank it back into the default group. Older
  // iOS builds that omit the field continue to get the legacy behavior.
  //
  // `profileId` and `extensions` are present when the iOS client wants an
  // engine-hosted conversation. When absent, the desktop creates a plain
  // CLI tab (legacy behavior). This merges the former desktop_create_engine_tab
  // command into the unified create-tab shape.
  | { type: 'desktop_create_tab'; workingDirectory?: string; pinToGroupId?: string; profileId?: string; extensions?: string[] }
  | { type: 'desktop_create_terminal_tab'; workingDirectory?: string }
  | { type: 'desktop_close_tab'; tabId: string }
  // `instanceId` scopes a prompt to a specific engine instance (absent means
  // active instance or CLI tab). This merges the former desktop_engine_prompt
  // instanceId field into the unified prompt shape so iOS sends one command
  // type regardless of tab kind.
  | { type: 'desktop_prompt'; tabId: string; text: string; origin?: 'desktop' | 'remote'; clientMsgId?: string; attachments?: Array<{ type: 'image' | 'file'; name: string; path: string }>; implementationPhase?: boolean; instanceId?: string }
  | { type: 'desktop_cancel'; tabId: string }
  | { type: 'desktop_respond_permission'; tabId: string; questionId: string; optionId: string }
  | { type: 'desktop_respond_elicitation'; tabId: string; requestId: string; response?: Record<string, unknown>; cancelled: boolean }
  | { type: 'desktop_set_permission_mode'; tabId: string; mode: 'auto' | 'plan' }
  // Per-conversation extended-thinking effort change from iOS. The desktop
  // applies it to the same per-conversation state used for its own prompts
  // (tab.thinkingEffort or active instance.thinkingEffort), so the next prompt
  // from either client carries the level. 'off' clears thinking. Lockstep
  // desktop↔iOS wire — added to RemoteCommand.swift in the same change.
  | { type: 'desktop_set_thinking_effort'; tabId: string; effort: 'off' | 'low' | 'medium' | 'high' }
  | { type: 'desktop_reset_tab_session'; tabId: string }
  // Engine-instance counterpart to desktop_reset_tab_session: stops the engine
  // session keyed by `${tabId}:${instanceId}` and wipes the renderer-side
  // per-instance state (messages, status, dialogs, etc.) without removing
  // the instance pane itself. iOS sends this for engine tabs when the
  // user picks "Implement, clear context" on the plan-approval card —
  // `desktop_reset_tab_session` only addresses the CLI session plane and silently
  // misses engine instances.
  | { type: 'desktop_reset_engine_session'; tabId: string; instanceId: string }
  | { type: 'desktop_load_conversation'; tabId: string; before?: string }
  // desktop_request_resend: iOS detected a forward seq gap; asks the desktop to
  // replay missing wire frames [fromSeq,toSeq] from its retransmit buffer (see
  // retransmit-buffer.ts). Makes the fire-and-forget wire self-healing for the
  // live stream without waiting for the snapshot reconcile.
  | { type: 'desktop_request_resend'; fromSeq: number; toSeq: number }
  | { type: 'desktop_terminal_input'; tabId: string; instanceId: string; data: string }
  | { type: 'desktop_terminal_resize'; tabId: string; instanceId: string; cols: number; rows: number }
  | { type: 'desktop_terminal_add_instance'; tabId: string }
  | { type: 'desktop_terminal_remove_instance'; tabId: string; instanceId: string }
  | { type: 'desktop_terminal_select_instance'; tabId: string; instanceId: string }
  | { type: 'desktop_request_terminal_snapshot'; tabId: string }
  | { type: 'desktop_request_context_breakdown'; tabId: string }
  | { type: 'desktop_rename_tab'; tabId: string; customTitle: string | null }
  | { type: 'desktop_rename_terminal_instance'; tabId: string; instanceId: string; label: string }
  | { type: 'desktop_rewind'; tabId: string; messageId: string }
  | { type: 'desktop_fork_from_message'; tabId: string; messageId: string }
  | { type: 'desktop_engine_rewind'; tabId: string; instanceId: string; messageId: string; userTurnIndex?: number }
  | { type: 'desktop_engine_abort'; tabId: string; instanceId?: string }
  | { type: 'desktop_engine_dialog_response'; tabId: string; instanceId?: string; dialogId: string; value: any }
  | { type: 'desktop_engine_add_instance'; tabId: string }
  | { type: 'desktop_engine_remove_instance'; tabId: string; instanceId: string }
  | { type: 'desktop_engine_select_instance'; tabId: string; instanceId: string }
  | { type: 'desktop_engine_move_instance'; sourceTabId: string; instanceId: string; targetTabId: string }
  | { type: 'desktop_engine_set_model'; tabId: string; instanceId?: string; model: string }
  // desktop_load_engine_conversation is retired (WI-004 / #259). iOS now sends
  // desktop_load_conversation for every tab. The type is kept here as a comment
  // only; it is no longer a union member so the TypeScript type discriminator
  // does not accept it. The command-handler retains a tolerance case for stale
  // paired clients that still send the old string.
  | { type: 'desktop_load_agent_conversation'; conversationIds: string[] }
  | { type: 'desktop_set_tab_group_mode'; mode: 'auto' | 'manual' }
  | { type: 'desktop_move_tab_to_group'; tabId: string; groupId: string }
  | { type: 'desktop_toggle_tab_group_pin'; tabId: string }
  | { type: 'desktop_reorder_tab_groups'; orderedIds: string[] }
  | { type: 'desktop_set_tab_model'; tabId: string; model: string }
  | { type: 'desktop_load_attachments'; tabId: string }
  | { type: 'desktop_set_preferred_model'; model: string }
  | { type: 'desktop_set_engine_default_model'; model: string }
  | { type: 'desktop_unpair' }
  | { type: 'desktop_git_changes'; directory: string }
  | { type: 'desktop_git_graph'; directory: string; skip?: number; limit?: number }
  | { type: 'desktop_git_diff'; directory: string; path: string; staged: boolean }
  | { type: 'desktop_git_stage'; directory: string; paths: string[] }
  | { type: 'desktop_git_unstage'; directory: string; paths: string[] }
  | { type: 'desktop_git_commit'; directory: string; message: string }
  | { type: 'desktop_git_discard'; directory: string; paths: string[] }
  | { type: 'desktop_git_fetch'; directory: string }
  | { type: 'desktop_git_pull'; directory: string }
  | { type: 'desktop_git_push'; directory: string }
  | { type: 'desktop_git_commit_files'; directory: string; hash: string }
  | { type: 'desktop_git_commit_file_diff'; directory: string; hash: string; path: string }
  | { type: 'desktop_fs_list_dir'; directory: string; includeHidden?: boolean }
  | { type: 'desktop_fs_read_file'; filePath: string }
  | { type: 'desktop_fs_read_image'; filePath: string }
  | { type: 'desktop_fs_write_file'; filePath: string; content: string }
  // Rename a file or directory inside a project root. Both `oldPath` and
  // `newPath` are validated by `isValidProjectPath` on the desktop;
  // failures surface via `desktop_fs_rename_result` with `ok: false` rather than
  // throwing. This is purely a client↔harness wire — the engine has no
  // notion of a "file explorer" and never sees these commands.
  | { type: 'desktop_fs_rename'; oldPath: string; newPath: string }
  | { type: 'desktop_discover_commands'; directory: string }
  | { type: 'desktop_upload_attachment'; dataUrl: string; name: string; correlationId?: string }
  | { type: 'desktop_voice_config'; enabled: boolean; mode: 'client' | 'desktop'; systemPrompt?: string }
  | { type: 'desktop_diagnostic_logs_response'; logs: string; deviceId: string; deviceName: string }
  | { type: 'desktop_set_remote_display'; customName: string | null; customIcon: string | null; updatedAt: number }
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
  | { type: 'desktop_set_desktop_setting'; key: string; value: unknown }
  | { type: 'desktop_set_pill_color'; tabId: string; pillColor: string | null }
  | { type: 'desktop_set_pill_icon'; tabId: string; pillIcon: string | null }
  // ─── Focus reporting (intercept routing) ────────────────────────────
  // Sent by iOS whenever the focused tab changes, the app foregrounds/
  // backgrounds, or the per-device intercept preference toggles. The desktop
  // stores the mapping in its deviceFocusMap to route engine_intercept events
  // to the right device(s). tabId null means the device is backgrounded.
  | { type: 'desktop_report_focus'; tabId: string | null; interceptEnabled: boolean }
  | { type: 'desktop_request_resource_content'; kind: string; resourceId: string }
  | { type: 'desktop_mark_resource_read'; kind: string; resourceId: string }
  // Permanently remove a notification from the global resource broker.
  // The desktop publishes a delete delta through the engine so all
  // subscribers (desktop + iOS) remove the item from their collections.
  | { type: 'desktop_delete_resource'; kind: string; resourceId: string }
  // ─── Plan-mode remote implement (plan gentle-perching-lemon) ─────────
  // iOS sends desktop_implement_plan instead of building a prompt string. The
  // desktop runs its own onImplement pipeline (permission mode → auto,
  // implement divider, sendMessage with implementationPhase=true and the
  // plan attachment). The plan body never crosses the wire — desktop reads
  // it from disk. clearContext=true maps to the "Implement, clear context"
  // button behavior (resets engine session before implementing).
  | { type: 'desktop_implement_plan'; tabId: string; questionId: string; instanceId?: string; clearContext?: boolean }
  // iOS sends desktop_request_plan_content to page through a plan file. The desktop
  // returns a bounded byte window via desktop_plan_content events, modeled on
  // desktop_request_resource_content → desktop_resource_content. The snapshot no longer
  // embeds the full plan body — iOS fetches pages on expand/copy.
  | { type: 'desktop_request_plan_content'; tabId: string; questionId: string; planFilePath: string; offset: number; length: number }

// ─── Ion → iOS events ───

export type RemoteEvent =
  | { type: 'desktop_snapshot'; tabs: RemoteTabState[]; recentDirectories?: string[]; tabGroupMode?: 'off' | 'auto' | 'manual'; tabGroups?: Array<{ id: string; label: string; isDefault: boolean; order: number }>; preferredModel?: string; engineDefaultModel?: string; availableModels?: Array<{ id: string; providerId: string; label: string; contextWindow: number; hasAuth: boolean; thinkingMode?: string; thinkingEfforts?: string[] }>; customName?: string | null; customIcon?: string | null; remoteDisplayUpdatedAt?: number; resources?: Record<string, Array<{ id: string; kind: string; title?: string; createdAt: string; read?: boolean; conversationId?: string }>> }
  | { type: 'desktop_resource_content'; resourceId: string; kind: string; content: string }
  | { type: 'desktop_tab_created'; tab: RemoteTabState }
  | { type: 'desktop_tab_closed'; tabId: string }
  | { type: 'desktop_tab_status'; tabId: string; status: TabStatus }
  /**
   * Lightweight tab-row metadata delta. Emitted event-driven (on title, cost,
   * instances, or group change) so iOS tab-row data updates without waiting for
   * the 5 s snapshot poll. All fields are optional — the sender includes only
   * the field(s) that changed. Additive: old iOS builds ignore it gracefully.
   * Fields mirror the corresponding RemoteTabState fields.
   */
  | {
      type: 'desktop_tab_meta'
      tabId: string
      title?: string
      totalCostUsd?: number
      conversationInstances?: RemoteTabState['conversationInstances']
      groupId?: string | null
    }
  | { type: 'desktop_text_chunk'; tabId: string; text: string }
  | { type: 'desktop_tool_call'; tabId: string; toolName: string; toolId: string }
  | { type: 'desktop_tool_result'; tabId: string; toolId: string; content: string; isError: boolean }
  | { type: 'desktop_task_complete'; tabId: string; result: string; costUsd: number }
  // `instanceId` scopes engine-view permission requests to the engine
  // sub-tab (instance) that produced them, so clients can hide a plan/
  // question card when the user views a sibling sub-conversation.
  // Optional + absent for CLI tabs — additive, non-breaking.
  | { type: 'desktop_permission_request'; tabId: string; instanceId?: string; questionId: string; toolName: string; toolInput?: Record<string, unknown>; options: Array<{ id: string; label: string; kind?: string }> }
  | { type: 'desktop_permission_resolved'; tabId: string; questionId: string }
  | { type: 'desktop_error'; tabId: string; message: string }
  | { type: 'desktop_conversation_history'; tabId: string; messages: RemoteMessage[]; hasMore: boolean; cursor?: string }
  | { type: 'desktop_message_added'; tabId: string; message: RemoteMessage }
  | { type: 'desktop_message_updated'; tabId: string; messageId: string; content?: string; toolStatus?: 'running' | 'completed' | 'error'; toolInput?: string }
  | { type: 'desktop_queue_update'; tabId: string; prompts: string[] }
  | { type: 'desktop_terminal_output'; tabId: string; instanceId: string; data: string }
  | { type: 'desktop_terminal_exit'; tabId: string; instanceId: string; exitCode: number }
  | { type: 'desktop_terminal_instance_added'; tabId: string; instance: TerminalInstanceInfo }
  | { type: 'desktop_terminal_instance_removed'; tabId: string; instanceId: string }
  | { type: 'desktop_terminal_snapshot'; tabId: string; instances: TerminalInstanceInfo[]; activeInstanceId: string | null; buffers?: Record<string, string> }
  | { type: 'desktop_agent_state'; tabId: string; instanceId?: string | null; agents: AgentStateUpdate[] }
  | { type: 'desktop_status'; tabId: string; instanceId?: string | null; fields: StatusFields; metadata?: Record<string, unknown> }
  | { type: 'desktop_working_message'; tabId: string; instanceId?: string | null; message: string; metadata?: Record<string, unknown> }
  | { type: 'desktop_notify'; tabId: string; instanceId?: string | null; message: string; level: string; metadata?: Record<string, unknown> }
  | { type: 'desktop_dialog'; tabId: string; instanceId?: string | null; dialogId: string; method: string; title: string; message?: string; options?: string[]; defaultValue?: string }
  | { type: 'desktop_dialog_resolved'; tabId: string; instanceId?: string | null; dialogId: string }
  | { type: 'desktop_text_delta'; tabId: string; instanceId?: string | null; text: string }
  | { type: 'desktop_message_end'; tabId: string; instanceId?: string | null; usage: { inputTokens: number; outputTokens: number; contextPercent: number; cost: number } }
  // `metadata` is an opaque pass-through hint map forwarded from the engine.
  // Carried verbatim across the relay to iOS so future iOS-side handlers
  // (e.g. dedup, render-style hints) can adopt the same conventions the
  // desktop renderer honors without a protocol break. See
  // docs/protocol/server-events.md for well-known keys.
  | { type: 'desktop_harness_message'; tabId: string; instanceId?: string | null; message: string; source?: string; metadata?: Record<string, unknown> }
  | { type: 'desktop_tool_start'; tabId: string; instanceId?: string | null; toolName: string; toolId: string }
  | { type: 'desktop_tool_end'; tabId: string; instanceId?: string | null; toolId: string; result?: string; isError?: boolean }
  | { type: 'desktop_tool_stalled'; tabId: string; instanceId?: string | null; toolId: string; toolName: string; elapsed: number }
  | { type: 'desktop_model_override'; tabId: string; instanceId?: string | null; model: string }
  | { type: 'desktop_dead'; tabId: string; instanceId?: string | null; exitCode: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'desktop_engine_error'; tabId: string; instanceId?: string | null; message: string }
  | { type: 'desktop_instance_added'; tabId: string; instance: { id: string; label: string } }
  | { type: 'desktop_instance_removed'; tabId: string; instanceId: string }
  | { type: 'desktop_instance_moved'; sourceTabId: string; instanceId: string; targetTabId: string }
  // desktop_engine_conversation_history is retired (WI-004 / #259).
  // The unified response is desktop_conversation_history for every tab.
  | { type: 'desktop_agent_conversation_history'; agentName: string; conversationId?: string; messages: Array<{ id: string; role: string; content: string; toolName?: string; toolId?: string; toolStatus?: string; timestamp: number }> }
  // desktop_dispatch_activity streams a running dispatched agent's intra-turn
  // activity (tool start/end, streamed text) to iOS. Forwarded generically from
  // the engine's engine_dispatch_activity via engineToWireType (event-wiring.ts);
  // the engine field names are carried through verbatim by the `{...event}`
  // spread. INCREMENTAL/append-by-key — the client folds it into the per-dispatch
  // transcript cache keyed by dispatchAgentId/conversationId, deduping tools by
  // toolId and streaming text by dispatchSeq. It must NOT be appended to the main
  // conversation message stream (that surface is desktop_text_delta /
  // desktop_tool_start). The file-backed reconcile is the snapshot authority.
  | { type: 'desktop_dispatch_activity'; tabId: string; instanceId?: string | null; dispatchAgentId: string; dispatchConversationId: string; dispatchActivityKind: 'text' | 'tool_start' | 'tool_end'; dispatchSeq: number; toolName?: string; toolId?: string; dispatchTextDelta?: string; dispatchToolIsError?: boolean; dispatchActivityTs?: number }
  // input_prefill seeds a remote client's input box with text (e.g. the
  // rewound user message after a rewind). `instanceId` is set when the
  // prefill targets a specific engine instance's draft (desktop_engine_rewind);
  // absent/null for CLI-tab rewinds, where the tab has a single input.
  | { type: 'desktop_input_prefill'; tabId: string; text: string; switchTo?: boolean; instanceId?: string | null }
  | { type: 'desktop_engine_profiles'; profiles: Array<{ id: string; name: string; extensions: string[]; defaultMode?: 'auto' | 'plan' }> }
  // desktop_context_breakdown: forwarded from engine_context_breakdown. Carries
  // the per-category token breakdown built during prompt assembly (and reconciled
  // after the first usage event). iOS renders this in the Status Drawer's
  // context-breakdown section. Lockstep desktop↔iOS wire — added to both
  // protocol.ts and NormalizedEvent.swift in the same change.
  | {
      type: 'desktop_context_breakdown'
      tabId: string
      instanceId?: string | null
      contextBreakdown: import('../../shared/types-engine').ContextBreakdownPayload
    }
  // ─── Desktop settings projection (Part 7) ───────────────────────────
  // Snapshot of the desktop's projectable user preferences. Emitted once
  // on initial pairing (alongside `desktop_snapshot`) and on every subsequent
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
  // The desktop's display name (carried by `desktop_snapshot.customName` or the
  // pairing record) labels which desktop the values belong to.
  | {
      type: 'desktop_settings_snapshot'
      settings: Record<string, unknown>
      schema: Array<DesktopSettingsSchemaEntry>
      groups: Array<{ id: string; label: string }>
      /**
       * Resolved enterprise new-conversation policy, or null/absent when no
       * enterprise config is present. Populated from
       * `getEnterprisePolicyNewConversationDefaults()` at snapshot-build time so
       * remote clients (iOS) can enforce the same new-conversation lock as the
       * desktop without an additional RPC.
       *
       * Wire-backward-compatible: old iOS clients that don't decode this field
       * simply ignore it (the field is absent from their NormalizedEvent case).
       */
      newConversationPolicy?: {
        baseDirectory: string
        engineProfileId: string
        locked: boolean
      } | null
    }
  | { type: 'desktop_heartbeat'; seq: number; ts: number; buffered: number }
  // desktop_resend_unavailable: the requested resend range was evicted from the
  // retransmit buffer (too old); iOS falls back to the snapshot reconcile.
  | { type: 'desktop_resend_unavailable'; fromSeq: number }
  | { type: 'desktop_unpair' }
  | { type: 'desktop_relay_config'; relayUrl: string; relayApiKey: string }
  | { type: 'desktop_remote_display'; customName: string | null; customIcon: string | null; updatedAt: number }
  | { type: 'desktop_git_changes_response'; directory: string; files: Array<{ path: string; status: string; staged: boolean; oldPath?: string }>; branch: string; isGitRepo: boolean; ahead: number; behind: number; stagedCount?: number; unstagedCount?: number }
  | { type: 'desktop_git_graph_response'; directory: string; commits: Array<{ hash: string; fullHash: string; parents: string[]; authorName: string; authorDate: string; subject: string; refs: Array<{ name: string; type: string; isCurrent: boolean }> }>; isGitRepo: boolean; totalCount: number; graphLayout?: Array<{ lane: number; color: string; hasIncoming: boolean; connections: Array<{ fromLane: number; toLane: number; type: 'straight' | 'merge' | 'fork'; color: string }>; passThroughLanes: Array<{ lane: number; color: string }> }> }
  | { type: 'desktop_git_diff_response'; diff: string; fileName: string }
  | { type: 'desktop_git_commit_result'; directory: string; ok: boolean; error?: string }
  | { type: 'desktop_git_stage_result'; directory: string; ok: boolean; error?: string }
  | { type: 'desktop_git_unstage_result'; directory: string; ok: boolean; error?: string }
  | { type: 'desktop_git_commit_files_response'; directory: string; hash: string; files: Array<{ path: string; status: string; oldPath?: string }>; stats: { filesChanged: number; insertions: number; deletions: number } }
  | { type: 'desktop_git_commit_file_diff_response'; hash: string; path: string; diff: string; fileName: string }
  | { type: 'desktop_fs_dir_listing'; directory: string; entries: Array<{ name: string; path: string; isDirectory: boolean; size: number; modifiedMs: number }>; error?: string }
  | { type: 'desktop_fs_file_content'; filePath: string; content: string | null; error?: string }
  | { type: 'desktop_fs_image_content'; filePath: string; dataUrl: string | null; error?: string }
  | { type: 'desktop_fs_write_result'; filePath: string; ok: boolean; error?: string }
  // Result of a desktop_fs_rename command. iOS uses this to refresh the parent
  // directory listing on success and to surface errors. The shape mirrors
  // `desktop_fs_write_result` deliberately: ok-flag plus optional error string.
  | { type: 'desktop_fs_rename_result'; oldPath: string; newPath: string; ok: boolean; error?: string }
  | { type: 'desktop_upload_attachment_result'; id: string; name: string; path: string; correlationId?: string; error?: string }
  | { type: 'desktop_discover_commands_response'; directory: string; commands: Array<{ name: string; description: string; scope: 'user' | 'project'; source: 'command' | 'skill' }> }
  | { type: 'desktop_tab_attachments'; tabId: string; attachments: Array<{ type: string; name: string; path: string }> }
  /**
   * Request iOS diagnostic logs since `lineOffset`. lineOffset=0 requests
   * the full history; higher values request only new lines since the last
   * pull (incremental). iOS uses `DiagnosticLog.exportIncrementalSince`.
   * Additive field — older iOS builds that don't decode `lineOffset` treat
   * every request as a full export (graceful fallback).
   */
  | { type: 'desktop_request_diagnostic_logs'; lineOffset?: number }
  // ─── desktop_intercept (forwarded from engine to iOS) ────────────────
  // The desktop forwards this to iOS devices that have the target session's
  // tab focused and have interceptEnabled. Carries the full intercept payload
  // so iOS can render the appropriate inline UI (banner or redirect marker).
  | { type: 'desktop_intercept'; tabId: string; level: string; title: string; message: string; source?: string; metadata?: Record<string, unknown> }
  // ─── Plan content paged fetch (plan gentle-perching-lemon) ──────────
  // Server response to desktop_request_plan_content. Returns a bounded byte-range
  // window of the plan file. iOS assembles successive windows to display
  // the full plan body or to build the copy payload. hasMore=true signals
  // more data available at offset+content.length. content is UTF-8 text.
  | { type: 'desktop_plan_content'; questionId: string; planFilePath: string; offset: number; content: string; totalBytes: number; hasMore: boolean }

// ─── Relay control frames (injected by relay, not by Ion) ───

export interface RelayControlMessage {
  type: 'relay:peer-disconnected' | 'relay:peer-reconnected' | 'relay:paired' | 'relay:ping' | 'relay:pong' | 'relay:push-failed'
  /** Failure reason (queue_full | invalid_token | transient | token | marshal | request | transport). Present when type === 'relay:push-failed'. */
  reason?: string
  /** Resource ID from the originating push message. Present when type === 'relay:push-failed'. */
  resourceId?: string
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

// Re-export NormalizedEvent transform helpers (extracted to protocol-helpers.ts for line-cap).
export { normalizedToRemote, normalizedToMessages } from './protocol-helpers'
