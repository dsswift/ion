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

import type { TabStatus, AgentStateUpdate, StatusFields } from '@ion/shared/types'
import type { TranscriptPatchEvent } from '@ion/shared/transcript/transcript-patch'
import type { RemoteTabState, TerminalInstanceInfo } from './protocol-remote-tab'

import type { DesktopSettingsSchemaEntry } from './protocol-settings'
import type { PresenceEntry } from '@ion/shared/types-presence'
export type { DesktopSettingsSchemaEntry } from './protocol-settings'

// ─── Remote Tab State + message types — extracted for line-cap ───
// All types re-exported so existing import paths remain valid.
export type { RemoteTabState, TerminalInstanceInfo } from './protocol-remote-tab'

// ─── Worktree + integration bench wire members (extracted for line cap) ───
export type {
  RemoteWorktree, RemoteMembership, RemoteBench, RemoteWorktreeState,
  RemoteWorktreeCommand, RemoteWorktreeEvent,
} from './protocol-worktree'
import type { RemoteWorktreeEvent, RemoteWorktreeState } from './protocol-worktree'

// ─── Guided Questions wire members (extracted for line cap) ───
export type { RemoteQuestionsEvent, RemoteQuestionsCommand } from './protocol-questions'
import type { RemoteQuestionsEvent } from './protocol-questions'

// ─── iOS → Ion commands (extracted for line cap) ───
// Re-exported so existing import paths remain valid.
export type { RemoteCommand } from './protocol-commands'

// ─── Ion → iOS events ───

export interface RemoteProject {
  directory: string
  displayName: string
  isDefault: boolean
  managed: boolean
  profileAction: 'ask' | 'plain' | 'profile'
  profileId?: string
  profileSource?: string
  hasOverride: boolean
}

export type RemoteEvent =
  | RemoteWorktreeEvent
  | RemoteQuestionsEvent
  | { type: 'desktop_snapshot'; tabs: RemoteTabState[]; projects?: RemoteProject[]; worktreeStates?: RemoteWorktreeState[]; settledTabs?: RemoteTabState[]; recentDirectories?: string[]; availableModels?: Array<{ id: string; providerId: string; providerLabel: string; label: string; contextWindow: number; maxOutputTokens?: number; effectiveContextLimit?: number; hasAuth: boolean; thinkingMode?: string; thinkingEfforts?: string[]; modelKind?: string; isCustom?: boolean; costPer1kInput?: number; costPer1kCacheCreation?: number; costPer1kCacheRead?: number; supportsCaching?: boolean; cacheTtlSeconds?: number }>; customName?: string | null; customIcon?: string | null; remoteDisplayUpdatedAt?: number; resources?: Record<string, Array<{ id: string; kind: string; producer?: string; title?: string; createdAt: string; read?: boolean; conversationId?: string }>> }
  | { type: 'desktop_resource_content'; resourceId: string; kind: string; producer?: string; content: string }
  // `clientCmdId` echoes the id the iOS client attached to `desktop_create_tab`
  // / `desktop_create_terminal_tab` so the client's confirm-or-resend tracker
  // can correlate this event to its pending create and stop resending. Absent
  // for desktop-originated tab creation (no client to correlate).
  | { type: 'desktop_tab_created'; tab: RemoteTabState; clientCmdId?: string }
  | { type: 'desktop_tab_closed'; tabId: string }
  // `resync` reasserts authoritative status without a run lifecycle transition.
  // Clients converge optimistic state but must not clear permission UI or resolve
  // pending requests solely because this message arrived.
  | { type: 'desktop_tab_status'; tabId: string; status: TabStatus; resync?: boolean }
  /**
   * Lightweight tab-row metadata delta. Emitted event-driven (on title, cost,
   * or instances change) AND by the 5 s snapshot poll tick for the
   * hash-excluded volatile conversation fields (lastActivityAt / lastMessage /
   * messageCount) so an inbox row sees fresh values without a full snapshot
   * reship. All fields are optional — the
   * sender includes only the field(s) that changed. Additive: old iOS builds
   * ignore unknown fields gracefully.
   * Fields mirror the corresponding RemoteTabState fields.
   */
  | {
      type: 'desktop_tab_meta'
      tabId: string
      title?: string
      totalCostUsd?: number
      conversationInstances?: RemoteTabState['conversationInstances']
      /** Unix ms timestamp of the newest message activity (tab sort key). */
      lastActivityAt?: number
      /** Tab-list preview text (last user/assistant message, truncated). */
      lastMessage?: string | null
      /** Message count of the active conversation instance. */
      messageCount?: number
      /** Custom tab pill background, or null to clear it. */
      pillColor?: string | null
      /** Custom tab pill icon, or null to clear it. */
    }
  | { type: 'desktop_slash_model_tier_ignored'; tabId: string; instanceId?: string | null; command: string; slashModelTierRequested: string; slashModelTierServing: string }
  | { type: 'desktop_task_complete'; tabId: string; result: string; costUsd: number; durationMs?: number; reason?: import('@ion/shared/types-events').TaskCompletionReason | (string & {}) }
  // `instanceId` scopes engine-view permission requests to the engine
  // sub-tab (instance) that produced them, so clients can hide a plan/
  // question card when the user views a sibling sub-conversation.
  // Optional + absent for CLI tabs — additive, non-breaking.
  | { type: 'desktop_permission_request'; tabId: string; instanceId?: string; questionId: string; toolName: string; toolInput?: Record<string, unknown>; options: Array<{ id: string; label: string; kind?: string }> }
  | { type: 'desktop_permission_resolved'; tabId: string; questionId: string }
  | { type: 'desktop_transcript'; tabId: string; requestId: string; transcript: string; error?: string }
  // One change to a transcript stream (a tab's own, or a dispatched agent's).
  // See @ion/shared/transcript/transcript-patch.
  | TranscriptPatchEvent
  | { type: 'desktop_background_task_started'; tabId: string; instanceId?: string | null; task: import('@ion/shared/types-engine').BackgroundTaskState }
  | { type: 'desktop_background_task_terminal'; tabId: string; instanceId?: string | null; taskId: string; status: string; exitCode?: number; elapsedMs?: number; command?: string; outputPath?: string; tail?: string }
  | { type: 'desktop_session_work_stopped'; tabId: string; instanceId?: string | null; scope: string; cancelledRunId?: string; recalledDispatchIds?: string[]; stoppedBackgroundTaskIds?: string[]; killedAgentProcessCount?: number }
  | { type: 'desktop_background_task_stop_result'; requestId: string; taskId: string; status: string; error?: string }
  | { type: 'desktop_queue_update'; tabId: string; prompts: string[] }
  | { type: 'desktop_terminal_activity'; key: string; tabId: string; instanceId: string; active: boolean; processLabel: string | null; applications: import('@ion/shared/terminal-activity').TerminalWebApplication[] }
  | { type: 'desktop_terminal_output'; tabId: string; instanceId: string; data: string }
  | { type: 'desktop_terminal_exit'; tabId: string; instanceId: string; exitCode: number }
  | { type: 'desktop_terminal_restarted'; tabId: string; instanceId: string }
  | { type: 'desktop_terminal_instance_added'; tabId: string; instance: TerminalInstanceInfo }
  | { type: 'desktop_terminal_instance_removed'; tabId: string; instanceId: string }
  | { type: 'desktop_terminal_snapshot'; tabId: string; instances: TerminalInstanceInfo[]; activeInstanceId: string | null; buffers?: Record<string, string> }
  // metadataOmitted marks a payload the transport DEGRADED to fit a size cap:
  // agent identity and the protected metadata subset survive, the rest is
  // shed. Consumers should treat detail fields as unavailable rather than
  // absent-and-therefore-cleared, and may request a fresh snapshot.
  | { type: 'desktop_agent_state'; tabId: string; instanceId?: string | null; agents: AgentStateUpdate[]; metadataOmitted?: boolean }
  | { type: 'desktop_status'; tabId: string; instanceId?: string | null; fields: StatusFields; metadata?: Record<string, unknown> }
  | { type: 'desktop_working_message'; tabId: string; instanceId?: string | null; message: string; metadata?: Record<string, unknown> }
  | { type: 'desktop_dialog'; tabId: string; instanceId?: string | null; dialogId: string; method: string; title: string; message?: string; options?: string[]; defaultValue?: string }
  | { type: 'desktop_dialog_resolved'; tabId: string; instanceId?: string | null; dialogId: string }
  | { type: 'desktop_message_end'; tabId: string; instanceId?: string | null; usage: { inputTokens: number; outputTokens: number; contextPercent: number; cost: number } }
  | { type: 'desktop_tool_stalled'; tabId: string; instanceId?: string | null; toolId: string; toolName: string; elapsed: number }
  // A steer arrived mid-stream and the engine ended that provider call early so
  // the steer applies on the next turn. Scheduling notice, not delivery:
  // desktop_steer_injected still follows. steerInterruptBlocksKept counts the
  // assistant blocks preserved, so a short message reads as an intentional
  // early stop rather than a truncation.
  | { type: 'desktop_steer_interrupted_stream'; tabId: string; instanceId?: string | null; steerInterruptBlocksKept?: number; steerQueuedCount?: number }
  | { type: 'desktop_model_override'; tabId: string; instanceId?: string | null; model: string }
  | { type: 'desktop_dead'; tabId: string; instanceId?: string | null; exitCode: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'desktop_engine_error'; tabId: string; instanceId?: string | null; message: string }
  | { type: 'desktop_instance_added'; tabId: string; instance: { id: string; label: string } }
  | { type: 'desktop_instance_removed'; tabId: string; instanceId: string }
  | { type: 'desktop_instance_moved'; sourceTabId: string; instanceId: string; targetTabId: string }
  // input_prefill seeds a remote client's input box with text (e.g. the
  // rewound user message after a rewind). `instanceId` is set when the
  // prefill targets a specific engine instance's draft (desktop_engine_rewind);
  // absent/null for CLI-tab rewinds, where the tab has a single input.
  | { type: 'desktop_input_prefill'; tabId: string; text: string; switchTo?: boolean; instanceId?: string | null }
  | { type: 'desktop_engine_profiles'; profiles: Array<{ id: string; name: string; extensions: string[]; defaultMode?: 'auto' | 'plan' }> }
  // FR-02 presence: mirrors the studio-wire `studio:presence` channel
  // (`server/src/protocol/presence.ts`) onto the iOS wire, full snapshot on
  // every change -- every connected principal (studio AND remote devices)
  // and their tab focus, plus which tab each is driving.
  | { type: 'desktop_presence'; entries: PresenceEntry[]; driving: Record<string, string> }
  // desktop_system_metrics: a summary of the Environment's System Metrics,
  // sent every 10 s only to a thin connection that asked with
  // desktop_system_metrics_watch (environment.systemMetrics.watch). Kept out
  // of the hash-gated thin snapshot so a changing number never forces a
  // resync. Fractions are 0..1; null when the figure is not known yet.
  | {
      type: 'desktop_system_metrics'
      cpuUtilization: number | null
      memoryUsedFraction: number | null
      diskFreeFraction: number | null
      sampledAt: number
    }
  // desktop_context_breakdown: forwarded from engine_context_breakdown. Carries
  // the per-category token breakdown built during prompt assembly (and reconciled
  // after the first usage event). iOS renders this in the Status Drawer's
  // context-breakdown section. Lockstep desktop↔iOS wire — added to both
  // protocol.ts and NormalizedEvent.swift in the same change.
  | {
      type: 'desktop_context_breakdown'
      tabId: string
      instanceId?: string | null
      contextBreakdown: import('@ion/shared/types-engine').ContextBreakdownPayload
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
  //   - `pages`: the settings pages Studio shows, in its order, each with
  //     its sections (`@ion/shared/settings-taxonomy`). Each `schema` entry
  //     names its `page` and `section`, so a client can lay the projection
  //     out exactly as Studio does.
  //
  // Per-server scoping: each server emits its own snapshot; an iOS device
  // paired with several servers sees a different payload from each. The
  // server's display name (carried by `desktop_snapshot.customName` or the
  // pairing record) labels which server the values belong to.
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
      /**
       * Enterprise theme policy (customFields['ion-desktop'].themePolicy).
       * Null/absent = unmanaged. `locked: true` means iOS must render the
       * enforced theme (resolved against built-ins + synced theme packs)
       * and disable its theme picker; `locked: false` is a managed default
       * the user may override. Same wire-backward-compat posture as
       * newConversationPolicy — old iOS clients ignore the field.
       */
      themePolicy?: {
        themeId: string
        locked: boolean
      } | null
      /**
       * Whether this client may change the server's Environment settings: its
       * connection holds the `admin` scope. Each `schema` entry carries its
       * `scope`; a client renders an `environment` entry read-only when this
       * is false. The server refuses the write either way.
       */
      canManageEnvironment?: boolean
      /**
       * The settings pages to render the projection under, in Studio's
       * order: every page showing a projected key, and every server page.
       */
      pages: Array<{
        id: string
        label: string
        scope: import('@ion/shared/settings-taxonomy').SettingsPageScope
        sections: Array<{ id: string; label: string }>
      }>
    }
  // desktop_theme_manifest: the iOS components of every installed custom
  // theme pack (built-ins never ride the wire — they are compiled into both
  // clients and pinned identical by the parity fixture). Sent during
  // sendSync (first pairing AND every reconnect, so iOS always converges on
  // the desktop's current pack set) and re-broadcast when the on-disk pack
  // set changes. **Snapshot semantics, scoped per desktop**: iOS REPLACES
  // its cached theme set for THIS desktop with the payload — themes absent
  // from the manifest were uninstalled and must be pruned (per-desktop
  // keying keeps desktop A's sync from deleting desktop B's themes).
  //
  // Token payloads are the iOS AppTheme token set (#RRGGBBAA), small enough
  // to inline. A component supplying the complete required set carries no
  // `base`; one omitting any required token names a built-in `base` and iOS
  // inherits the omitted tokens from that compiled-in theme
  // (required-when-partial). Image assets are NOT inlined: each is described
  // by {slot, sha256, size} and fetched lazily via desktop_request_theme_asset
  // when the sha misses the iOS cache.
  //
  // `hash` fingerprints the canonical payload so iOS can skip re-persisting
  // an unchanged set on every reconnect.
  | {
      type: 'desktop_theme_manifest'
      themes: Array<{
        id: string
        name: string
        version: string
        tokens: Record<string, string>
        base?: 'ion-dark' | 'ion-light' | 'ion-classic' | 'jarvis-hud' | 'ion-contrast-dark' | 'ion-contrast-light'
        preferredColorScheme?: 'light' | 'dark'
        assets?: Array<{ slot: 'background' | 'logo'; sha256: string; size: number }>
      }>
      hash: string
    }
  // desktop_theme_asset_content: response to desktop_request_theme_asset.
  // dataUrl is empty and ok=false when the asset is unknown/unreadable.
  | {
      type: 'desktop_theme_asset_content'
      themeId: string
      slot: 'background' | 'logo'
      ok: boolean
      sha256?: string
      dataUrl?: string
    }
  | { type: 'desktop_heartbeat'; seq: number; ts: number; buffered: number }
  // desktop_resend_unavailable: the requested resend range was evicted from the
  // retransmit buffer (too old); iOS falls back to the snapshot reconcile.
  | { type: 'desktop_resend_unavailable'; fromSeq: number }
  | { type: 'desktop_unpair' }
  
  | { type: 'desktop_remote_display'; customName: string | null; customIcon: string | null; updatedAt: number }
  | { type: 'desktop_git_changes_response'; directory: string; files: Array<{ path: string; status: string; staged: boolean; oldPath?: string }>; branch: string; isGitRepo: boolean; ahead: number; behind: number; stagedCount?: number; unstagedCount?: number }
  | { type: 'desktop_git_branches_response'; directory: string; branches: string[]; current: string; error?: string }
  | { type: 'desktop_git_graph_response'; directory: string; commits: Array<{ hash: string; fullHash: string; parents: string[]; authorName: string; authorDate: string; subject: string; refs: Array<{ name: string; type: string; isCurrent: boolean }> }>; isGitRepo: boolean; totalCount: number; graphLayout?: Array<{ lane: number; color: string; hasIncoming: boolean; connections: Array<{ fromLane: number; toLane: number; type: 'straight' | 'merge' | 'fork'; color: string }>; passThroughLanes: Array<{ lane: number; color: string }> }> }
  | { type: 'desktop_git_diff_response'; diff: string; fileName: string; isBinary: boolean }
  | { type: 'desktop_git_commit_result'; directory: string; ok: boolean; error?: string }
  | { type: 'desktop_git_stage_result'; directory: string; ok: boolean; error?: string }
  | { type: 'desktop_git_unstage_result'; directory: string; ok: boolean; error?: string }
  | { type: 'desktop_git_commit_files_response'; directory: string; hash: string; files: Array<{ path: string; status: string; oldPath?: string }>; stats: { filesChanged: number; insertions: number; deletions: number } }
  | { type: 'desktop_git_commit_file_diff_response'; hash: string; path: string; diff: string; fileName: string; isBinary: boolean }
  | { type: 'desktop_fs_dir_listing'; directory: string; entries: Array<{ name: string; path: string; isDirectory: boolean; size: number; modifiedMs: number; isHidden?: boolean }>; error?: string }
  | { type: 'desktop_fs_file_content'; filePath: string; content: string | null; error?: string }
  | { type: 'desktop_fs_image_content'; filePath: string; dataUrl: string | null; error?: string }
  | { type: 'desktop_fs_write_result'; filePath: string; ok: boolean; error?: string }
  // Result of a desktop_fs_rename command. iOS uses this to refresh the parent
  // directory listing on success and to surface errors. The shape mirrors
  // `desktop_fs_write_result` deliberately: ok-flag plus optional error string.
  | { type: 'desktop_fs_rename_result'; oldPath: string; newPath: string; ok: boolean; error?: string }
  | { type: 'desktop_upload_attachment_result'; id: string; name: string; path: string; contentHash?: string; correlationId?: string; error?: string }
  // `commands` carries the desktop's full DiscoveredCommand shape: the handler
  // forwards the engine-discovered objects verbatim, so `origin` and
  // `clearsConversation` are on the wire whether or not a client reads them.
  // clearsConversation lets iOS confirm before a command wipes conversation
  // history, matching the desktop's pre-send gate.
  | { type: 'desktop_discover_commands_response'; directory: string; commands: Array<{ name: string; description: string; scope: 'user' | 'project'; source: 'command' | 'skill'; origin?: 'ion' | 'claude'; clearsConversation?: boolean }> }
  | { type: 'desktop_tab_attachments'; tabId: string; attachments: Array<{ type: string; name: string; path: string }> }
  /**
   * Request iOS diagnostic logs newer than `sinceSeq`. sinceSeq=0 requests
   * the full history; higher values request only lines whose `fields.seq`
   * exceeds the desktop's persisted per-device cursor (incremental,
   * exactly-once). iOS uses `DiagnosticLog.exportIncrementalSince`. seq is a
   * monotonic per-line identity that survives on-device session rotation,
   * unlike the former line-count `lineOffset`. Additive field — older iOS
   * builds that don't decode `sinceSeq` treat every request as a full export
   * (graceful fallback).
   */
  | { type: 'desktop_request_diagnostic_logs'; sinceSeq?: number }
  // ─── desktop_notification (forwarded from engine_notification to iOS) ──
  // Forwarded by event-wiring.ts when the engine emits engine_notification.
  // push=true variant is sent with remoteTransport push=true so the relay
  // triggers APNs when the mobile peer is offline. push=false variant is sent
  // when the phone is connected so it can update its notification badge live.
  // notifyTitle/Body/Kind are the engine's display-layer fields; pushTitle/Body
  // are the relay-level APNs alert strings (fall back to notifyTitle/Body when
  // absent). iOS decodes this as engineNotification in NormalizedEvent.swift.
  | {
      type: 'desktop_notification'
      tabId: string
      instanceId?: string | null
      notifyTitle: string
      notifyBody: string
      notifyKind: string
      notifyResourceId?: string
      push: boolean
      pushTitle?: string
      pushBody?: string
    }
  // ─── Plan content paged fetch (plan gentle-perching-lemon) ──────────
  // Server response to desktop_request_plan_content. Returns a bounded byte-range
  // window of the plan file. iOS assembles successive windows to display
  // the full plan body or to build the copy payload. hasMore=true signals
  // more data available at offset+content.length. content is UTF-8 text.
  | { type: 'desktop_plan_content'; questionId: string; planFilePath: string; offset: number; content: string; totalBytes: number; hasMore: boolean }
  | { type: 'desktop_prompt_result'; tabId: string; clientMsgId: string; status: 'accepted' | 'rejected'; error?: string }
  // ─── Engine rewind result (per-instance rewind refusal notice) ───────
  // A rewind is transactional: the desktop calls the engine first and only
  // truncates local/Studio/iOS state on success. iOS's rewind command
  // (desktop_engine_rewind) had no failure-path reply at all — a rejection
  // (unknown/foreign-branch/non-user target) left the user staring at an
  // unchanged transcript with zero feedback that anything happened. This
  // event is sent ONLY on rejection; a successful rewind is silently
  // observable through the transcript stream and desktop_input_prefill, matching the desktop renderer's own
  // (silent-on-success) convention.
  | { type: 'desktop_engine_rewind_result'; tabId: string; instanceId: string; status: 'rejected'; error?: string }

// ─── Envelope / auth / pairing types ───
// RelayControlMessage, MAX_WIRE_FRAME_BYTES, WireMessage, AuthChallenge,
// AuthResponse, AuthResult, AuthFailureReasonCode, AuthMessage, PairedDevice,
// and TransportState moved to protocol-envelope.ts at the 600-line cap split;
// re-exported so existing import paths remain valid.
export {
  MAX_WIRE_FRAME_BYTES,
  LAN_AUTH_REASON_SECRET_UNUSABLE,
} from './protocol-envelope'
export {
  LAN_CLOSE_UNPAIR,
  LAN_CLOSE_UNKNOWN_DEVICE,
  LAN_CLOSE_SECRET_UNUSABLE,
} from './protocol-envelope'
export type {
  RelayControlMessage,
  WireMessage,
  PayloadChunkEnvelope,
  AuthChallenge,
  AuthResponse,
  AuthResult,
  AuthFailureReasonCode,
  AuthMessage,
  PairedDevice,
  TransportState,
} from './protocol-envelope'

// Re-export NormalizedEvent transform helpers (extracted to protocol-helpers.ts for line-cap).
export { normalizedToRemote } from './protocol-helpers'
