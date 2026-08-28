/**
 * Remote control commands from iOS to Ion.
 *
 * Kept separate from protocol.ts so the public protocol barrel remains below
 * the TypeScript file-size cap. protocol.ts re-exports RemoteCommand.
 */

import type { RemoteWorktreeCommand } from "./protocol-worktree";
import type { RemoteQuestionsCommand } from "./protocol-questions";

export type RemoteCommand =
  | RemoteQuestionsCommand
  | { type: "desktop_sync" }
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
  // `clientCmdId` is an iOS-generated correlation id for the confirm-or-resend
  // reliability loop: the desktop echoes it back on `desktop_tab_created` so the
  // client can clear its pending-create tracker, and dedupes by it so a resend
  // (after a lost confirmation over a wedged transport) re-emits the existing
  // tab instead of creating a duplicate. Absent from older clients — creation
  // proceeds without dedup, exactly as before.
  | {
      type: "desktop_create_tab";
      workingDirectory?: string;
      pinToGroupId?: string;
      profileId?: string;
      extensions?: string[];
      clientCmdId?: string;
      useWorktree?: boolean;
      sourceBranch?: string;
    }
  | { type: "desktop_git_branches"; directory: string }
  | {
      type: "desktop_create_terminal_tab";
      workingDirectory?: string;
      clientCmdId?: string;
    }
  | { type: "desktop_close_tab"; tabId: string }
  // `instanceId` scopes a prompt to a specific engine instance (absent means
  // active instance or CLI tab). This merges the former desktop_engine_prompt
  // instanceId field into the unified prompt shape so iOS sends one command
  // type regardless of tab kind.
  | {
      type: "desktop_prompt";
      tabId: string;
      text: string;
      origin?: "desktop" | "remote";
      clientMsgId?: string;
      attachments?: Array<{
        type: "image" | "file";
        name: string;
        path: string;
        contentHash?: string;
      }>;
      implementationPhase?: boolean;
      instanceId?: string;
    }
  | {
      type: "desktop_cancel";
      tabId: string;
      scope?: "all" | "orchestrator" | "all_work";
    }
  | { type: "desktop_abort_dispatch"; tabId: string; dispatchId: string }
  | {
      type: "desktop_stop_background_task";
      tabId: string;
      taskId: string;
      requestId: string;
    }
  | {
      type: "desktop_respond_permission";
      tabId: string;
      questionId: string;
      optionId: string;
    }
  | {
      type: "desktop_respond_elicitation";
      tabId: string;
      requestId: string;
      response?: Record<string, unknown>;
      cancelled: boolean;
    }
  | {
      type: "desktop_set_permission_mode";
      tabId: string;
      mode: "auto" | "plan";
    }
  // Per-conversation extended-thinking effort change from iOS. The desktop
  // applies it to the same per-conversation state used for its own prompts
  // (tab.thinkingEffort or active instance.thinkingEffort), so the next prompt
  // from either client carries the level. 'off' clears thinking. Lockstep
  // desktop↔iOS wire — added to RemoteCommand.swift in the same change.
  | {
      type: "desktop_set_thinking_effort";
      tabId: string;
      effort: "off" | "adaptive" | "low" | "medium" | "high" | "xhigh" | "max";
    }
  // Inbox actions (settle/snooze/mark-unread) from iOS. Route into the owner
  // renderer's FORWARDED store actions; the next snapshot cycle reflects the
  // change on every client. Lockstep wire — RemoteCommand.swift in the same
  // change (ADR-008).
  | { type: "desktop_tab_settle"; tabId: string }
  /** Permanently delete a conversation and its stored transcript. */
  | { type: "desktop_tab_delete"; tabId: string }
  /** Open a settled record as read-only history without resuming its session. */
  | { type: "desktop_review_settled_tab"; tabId: string }
  | { type: "desktop_tab_unsettle"; tabId: string }
  | { type: "desktop_tab_snooze"; tabId: string; untilMs: number }
  | { type: "desktop_tab_unsnooze"; tabId: string }
  | { type: "desktop_tab_mark_unread"; tabId: string }
  | { type: "desktop_tab_pin"; tabId: string }
  | { type: "desktop_tab_unpin"; tabId: string }
  | {
      type: "desktop_tab_reorder_pin";
      assignments: Array<{ tabId: string; orderKey: string }>;
    }
  | { type: "desktop_tab_regenerate_title"; tabId: string }
  | { type: "desktop_reset_tab_session"; tabId: string }
  // Engine-instance counterpart to desktop_reset_tab_session: stops the engine
  // session keyed by `${tabId}:${instanceId}` and wipes the renderer-side
  // per-instance state (messages, status, dialogs, etc.) without removing
  // the instance pane itself. iOS sends this for engine tabs when the
  // user picks "Implement, clear context" on the plan-approval card —
  // `desktop_reset_tab_session` only addresses the CLI session plane and silently
  // misses engine instances.
  | { type: "desktop_reset_engine_session"; tabId: string; instanceId: string }
  | { type: "desktop_load_conversation"; tabId: string; before?: string }
  | { type: "desktop_request_transcript"; tabId: string; requestId: string }
  // desktop_request_resend: iOS detected a forward seq gap; asks the desktop to
  // replay missing wire frames [fromSeq,toSeq] from its retransmit buffer (see
  // retransmit-buffer.ts). Makes the fire-and-forget wire self-healing for the
  // live stream without waiting for the snapshot reconcile.
  | { type: "desktop_request_resend"; fromSeq: number; toSeq: number }
  | {
      type: "desktop_terminal_input";
      tabId: string;
      instanceId: string;
      data: string;
    }
  | {
      type: "desktop_terminal_resize";
      tabId: string;
      instanceId: string;
      cols: number;
      rows: number;
    }
  | { type: "desktop_terminal_add_instance"; tabId: string }
  | {
      type: "desktop_terminal_remove_instance";
      tabId: string;
      instanceId: string;
    }
  | {
      type: "desktop_terminal_select_instance";
      tabId: string;
      instanceId: string;
    }
  | { type: "desktop_request_terminal_snapshot"; tabId: string }
  | { type: "desktop_open_terminal_application"; tabId: string; url: string }
  // Ask the desktop to re-send the agent roster for one tab. Scoped
  // deliberately: desktop_sync rebuilds every tab, engine profiles, settings,
  // and terminal buffers, which is the amplification this whole change
  // removes. A client uses this after receiving a degraded payload
  // (metadataOmitted) or on a detected gap.
  | {
      type: "desktop_request_agent_state";
      tabId: string;
      instanceId?: string | null;
    }
  | { type: "desktop_request_context_breakdown"; tabId: string }
  | { type: "desktop_rename_tab"; tabId: string; customTitle: string | null }
  | {
      type: "desktop_rename_terminal_instance";
      tabId: string;
      instanceId: string;
      label: string;
    }
  | { type: "desktop_fork_from_message"; tabId: string; messageId: string }
  | {
      type: "desktop_engine_rewind";
      tabId: string;
      instanceId: string;
      messageId: string;
      userTurnIndex?: number;
    }
  | { type: "desktop_engine_abort"; tabId: string; instanceId?: string }
  | {
      type: "desktop_engine_dialog_response";
      tabId: string;
      instanceId?: string;
      dialogId: string;
      value: any;
    }
  | { type: "desktop_engine_add_instance"; tabId: string }
  | {
      type: "desktop_engine_remove_instance";
      tabId: string;
      instanceId: string;
    }
  | {
      type: "desktop_engine_select_instance";
      tabId: string;
      instanceId: string;
    }
  | {
      type: "desktop_engine_move_instance";
      sourceTabId: string;
      instanceId: string;
      targetTabId: string;
    }
  | {
      type: "desktop_engine_set_model";
      tabId: string;
      instanceId?: string;
      model: string;
    }
  // desktop_load_engine_conversation is retired (WI-004 / #259). iOS now sends
  // desktop_load_conversation for every tab. The type is kept here as a comment
  // only; it is no longer a union member so the TypeScript type discriminator
  // does not accept it. The command-handler retains a tolerance case for stale
  // paired clients that still send the old string.
  | { type: "desktop_load_agent_conversation"; conversationIds: string[] }
  | { type: "desktop_set_tab_group_mode"; mode: "auto" | "manual" }
  | { type: "desktop_move_tab_to_group"; tabId: string; groupId: string }
  | { type: "desktop_toggle_tab_group_pin"; tabId: string }
  | { type: "desktop_reorder_tab_groups"; orderedIds: string[] }
  | { type: "desktop_set_tab_model"; tabId: string; model: string }
  | { type: "desktop_load_attachments"; tabId: string }
  | { type: "desktop_set_preferred_model"; model: string }
  | { type: "desktop_set_engine_default_model"; model: string }
  | { type: "desktop_unpair" }
  | { type: "desktop_git_changes"; directory: string }
  | {
      type: "desktop_git_graph";
      directory: string;
      skip?: number;
      limit?: number;
    }
  | {
      type: "desktop_git_diff";
      directory: string;
      path: string;
      staged: boolean;
    }
  | { type: "desktop_git_stage"; directory: string; paths: string[] }
  | { type: "desktop_git_unstage"; directory: string; paths: string[] }
  | { type: "desktop_git_commit"; directory: string; message: string }
  | { type: "desktop_git_discard"; directory: string; paths: string[] }
  | { type: "desktop_git_fetch"; directory: string }
  | { type: "desktop_git_pull"; directory: string }
  | { type: "desktop_git_push"; directory: string }
  | { type: "desktop_git_commit_files"; directory: string; hash: string }
  | {
      type: "desktop_git_commit_file_diff";
      directory: string;
      hash: string;
      path: string;
    }
  | RemoteWorktreeCommand
  | { type: "desktop_fs_list_dir"; directory: string; includeHidden?: boolean }
  | { type: "desktop_fs_read_file"; filePath: string }
  | { type: "desktop_fs_read_image"; filePath: string }
  | { type: "desktop_fs_write_file"; filePath: string; content: string }
  // Rename a file or directory inside a project root. Both `oldPath` and
  // `newPath` are validated by `isValidProjectPath` on the desktop;
  // failures surface via `desktop_fs_rename_result` with `ok: false` rather than
  // throwing. This is purely a client↔harness wire — the engine has no
  // notion of a "file explorer" and never sees these commands.
  | { type: "desktop_fs_rename"; oldPath: string; newPath: string }
  | { type: "desktop_discover_commands"; directory: string }
  | {
      type: "desktop_upload_attachment";
      dataUrl: string;
      name: string;
      correlationId?: string;
    }
  // desktop_request_theme_asset: lazy fetch of one theme-pack image asset
  // (same pattern as desktop_fs_read_image). iOS sends this after a
  // desktop_theme_manifest whose asset descriptor sha256 misses its local
  // cache; the desktop answers with desktop_theme_asset_content. Assets are
  // capped at 3 MB raw (theme-packs.ts) so the base64 response stays under
  // the wire plaintext gate.
  | {
      type: "desktop_request_theme_asset";
      themeId: string;
      slot: "background" | "logo";
    }
  | {
      type: "desktop_voice_config";
      enabled: boolean;
      mode: "client" | "desktop";
      systemPrompt?: string;
    }
  | {
      type: "desktop_diagnostic_logs_response";
      logs: string;
      pairingId: string;
      nextSeq: number;
    }
  | {
      type: "desktop_set_remote_display";
      customName: string | null;
      customIcon: string | null;
      updatedAt: number;
    }
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
  | { type: "desktop_set_desktop_setting"; key: string; value: unknown }
  | { type: "desktop_set_pill_color"; tabId: string; pillColor: string | null }
  | { type: "desktop_set_pill_icon"; tabId: string; pillIcon: string | null }
  // ─── Focus reporting (intercept routing) ────────────────────────────
  // Sent by iOS whenever the focused tab changes, the app foregrounds/
  // backgrounds, or the per-device intercept preference toggles. The desktop
  // stores the mapping in its deviceFocusMap to route engine_intercept events
  // to the right device(s). tabId null means the device is backgrounded.
  | {
      type: "desktop_report_focus";
      tabId: string | null;
      interceptEnabled: boolean;
    }
  | {
      type: "desktop_request_resource_content";
      kind: string;
      resourceId: string;
      producer?: string;
    }
  | { type: "desktop_mark_resource_read"; kind: string; resourceId: string; producer?: string }
  // Permanently remove a notification from the global resource broker.
  // The desktop publishes a delete delta through the engine so all
  // subscribers (desktop + iOS) remove the item from their collections.
  | { type: "desktop_delete_resource"; kind: string; resourceId: string; producer?: string }
  // ─── Plan-mode remote implement (plan gentle-perching-lemon) ─────────
  // iOS sends desktop_implement_plan instead of building a prompt string. The
  // desktop runs its own onImplement pipeline (permission mode → auto,
  // implement divider, sendMessage with implementationPhase=true and the
  // plan attachment). The plan body never crosses the wire — desktop reads
  // it from disk. clearContext=true maps to the "Implement, clear context"
  // button behavior (resets engine session before implementing).
  | {
      type: "desktop_implement_plan";
      tabId: string;
      questionId: string;
      instanceId?: string;
      clearContext?: boolean;
    }
  // iOS sends desktop_request_plan_content to page through a plan file. The desktop
  // returns a bounded byte window via desktop_plan_content events, modeled on
  // desktop_request_resource_content → desktop_resource_content. The snapshot no longer
  // embeds the full plan body — iOS fetches pages on expand/copy.
  | {
      type: "desktop_request_plan_content";
      tabId: string;
      questionId: string;
      planFilePath: string;
      offset: number;
      length: number;
    }
  | {
      type: "desktop_report_mobile_auth";
      accountUsername?: string;
      accountName?: string;
      subject?: string;
      tenantId?: string;
      signedInAt?: string;
      clearIdentity?: boolean;
      accessStatus?: string;
      accessReason?: string;
      reportedAt?: string;
    };
