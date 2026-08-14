// ─── IPC Channel Names ───

export const IPC = {
  // Request-response (renderer → main)
  START: "ion:start",
  CREATE_TAB: "ion:create-tab",
  ADOPT_TAB: "ion:adopt-tab",
  PROMPT: "ion:prompt",
  CANCEL: "ion:cancel",
  STEER: "ion:steer",
  STOP_TAB: "ion:stop-tab",
  RETRY: "ion:retry",
  STATUS: "ion:status",
  TAB_HEALTH: "ion:tab-health",
  CLOSE_TAB: "ion:close-tab",
  SELECT_DIRECTORY: "ion:select-directory",
  LIST_ENGINE_DIRECTORY: "ion:engine-list-directory",
  GET_ENGINE_HOST_INFO: "ion:engine-host-info",
  ENGINE_IS_REMOTE: "ion:engine-is-remote",
  SELECT_EXTENSION_FILES: "ion:select-extension-files",
  OPEN_EXTERNAL: "ion:open-external",
  ATTACH_FILES: "ion:attach-files",
  ATTACH_FILE_BY_PATH: "ion:attach-file-by-path",
  TAKE_SCREENSHOT: "ion:take-screenshot",
  TRANSCRIBE_AUDIO: "ion:transcribe-audio",
  PASTE_IMAGE: "ion:paste-image",
  GET_DIAGNOSTICS: "ion:get-diagnostics",
  RESPOND_PERMISSION: "ion:respond-permission",
  RESPOND_ELICITATION: "ion:respond-elicitation",
  APPROVE_DENIED_TOOLS: "ion:approve-denied-tools",
  INIT_SESSION: "ion:init-session",
  ENSURE_ENGINE_SESSION: "ion:ensure-engine-session",
  RESET_TAB_SESSION: "ion:reset-tab-session",
  RESTART_TAB_SESSION: "ion:restart-tab-session",
  // Move a live conversation to a different working directory, preserving its
  // conversationId and history. See engine-control-plane-relocate.ts.
  RELOCATE_TAB_SESSION: "ion:relocate-tab-session",
  ANIMATE_HEIGHT: "ion:animate-height",
  LIST_SESSIONS: "ion:list-sessions",
  LIST_ALL_SESSIONS: "ion:list-all-sessions",
  LOAD_SESSION: "ion:load-session",
  CONVERSATION_EXISTS: "ion:conversation-exists",
  READ_PLAN: "ion:read-plan",
  READ_IMAGE_DATA_URL: "ion:read-image-data-url",

  // One-way events (main → renderer)
  TEXT_CHUNK: "ion:text-chunk",
  TOOL_CALL: "ion:tool-call",
  TOOL_CALL_UPDATE: "ion:tool-call-update",
  TOOL_CALL_COMPLETE: "ion:tool-call-complete",
  TASK_UPDATE: "ion:task-update",
  TASK_COMPLETE: "ion:task-complete",
  SESSION_DEAD: "ion:session-dead",
  SESSION_INIT: "ion:session-init",
  ERROR: "ion:error",
  RATE_LIMIT: "ion:rate-limit",

  // Window management
  RESIZE_HEIGHT: "ion:resize-height",
  SET_WINDOW_WIDTH: "ion:set-window-width",
  HIDE_WINDOW: "ion:hide-window",
  WINDOW_SHOWN: "ion:window-shown",
  SET_IGNORE_MOUSE_EVENTS: "ion:set-ignore-mouse-events",
  IS_VISIBLE: "ion:is-visible",

  // Skill provisioning (main → renderer)
  SKILL_STATUS: "ion:skill-status",

  // Theme

  // Command discovery
  DISCOVER_COMMANDS: "ion:discover-commands",

  // Permission mode
  SET_PERMISSION_MODE: "ion:set-permission-mode",

  // Settings persistence
  LOAD_SETTINGS: "ion:load-settings",
  SAVE_SETTINGS: "ion:save-settings",
  SHOW_SETTINGS: "ion:show-settings",

  // Tab persistence
  LOAD_TABS: "ion:load-tabs",
  SAVE_TABS: "ion:save-tabs",
  LOAD_TAB_CONTENT: "ion:load-tab-content",
  SAVE_TAB_CONTENT: "ion:save-tab-content",
  DELETE_TAB_CONTENT: "ion:delete-tab-content",

  // Conversation backup (user-driven export/restore zip archives)
  CONVERSATION_EXPORT_PREVIEW: "ion:conversation-export-preview",
  CONVERSATION_EXPORT: "ion:conversation-export",
  CONVERSATION_RESTORE_PREVIEW: "ion:conversation-restore-preview",
  CONVERSATION_RESTORE: "ion:conversation-restore",
  CONVERSATION_BACKUP_PROGRESS: "ion:conversation-backup-progress",

  // Session labels
  SAVE_SESSION_LABEL: "ion:save-session-label",
  LOAD_SESSION_LABELS: "ion:load-session-labels",
  GENERATE_TITLE: "ion:generate-title",

  // Session chains (composite conversation grouping)
  LOAD_SESSION_CHAINS: "ion:load-session-chains",
  SAVE_SESSION_CHAINS: "ion:save-session-chains",

  // Conversation retrieval (agent child sessions)
  GET_CONVERSATION: "ion:get-conversation",

  // Batch conversation loading (all sessions in a chain in one roundtrip)
  LOAD_CHAIN_HISTORY: "ion:load-chain-history",

  // Enterprise policy
  GET_ENTERPRISE_POLICY: "ion:get-enterprise-policy",
  GET_ENTERPRISE_POLICY_FULL: "ion:get-enterprise-policy-full",

  // Theme packs (custom color themes; main scans disk, renderer registers)
  THEMES_LIST_CUSTOM: "ion:themes-list-custom",

  // Git operations
  GIT_GRAPH: "ion:git-graph",
  GIT_CHANGES: "ion:git-changes",
  GIT_IS_REPO: "ion:git-is-repo",
  GIT_COMMIT: "ion:git-commit",
  GIT_FETCH: "ion:git-fetch",
  GIT_PULL: "ion:git-pull",
  GIT_PUSH: "ion:git-push",
  GIT_BRANCHES: "ion:git-branches",
  GIT_CHECKOUT: "ion:git-checkout",
  GIT_CREATE_BRANCH: "ion:git-create-branch",
  GIT_DIFF: "ion:git-diff",
  GIT_STAGE: "ion:git-stage",
  GIT_UNSTAGE: "ion:git-unstage",
  GIT_DISCARD: "ion:git-discard",
  GIT_DELETE_BRANCH: "ion:git-delete-branch",
  GIT_COMMIT_DETAIL: "ion:git-commit-detail",
  GIT_COMMIT_FILES: "ion:git-commit-files",
  GIT_COMMIT_FILE_DIFF: "ion:git-commit-file-diff",
  GIT_IGNORED_FILES: "ion:git-ignored-files",
  GIT_STASH_LIST: "git:stash-list",
  GIT_STASH_SAVE: "git:stash-save",
  GIT_STASH_POP: "git:stash-pop",
  GIT_STASH_DROP: "git:stash-drop",
  GIT_CHERRY_PICK: "git:cherry-pick",
  GIT_REVERT: "git:revert",
  GIT_RESET: "git:reset",
  GIT_BLAME: "ion:git-blame",
  GIT_RESOLVE_CONFLICT: "ion:git-resolve-conflict",
  GIT_APPLY_PATCH: "ion:git-apply-patch",
  GIT_TAG_CREATE: "ion:git-tag-create",
  GIT_SHOW_FILE: "ion:git-show-file",
  GIT_COMMIT_SIGNATURE: "ion:git-commit-signature",
  GIT_RECENT_REFS: "ion:git-recent-refs",
  GIT_SUBSCRIBE: "ion:git-subscribe",
  GIT_UNSUBSCRIBE: "ion:git-unsubscribe",
  GIT_EVENT: "ion:git-event",
  GIT_SNAPSHOT: "ion:git-snapshot",
  GIT_REFRESH: "ion:git-refresh",

  // Git rebase operations
  GIT_REBASE_TODO: "ion:git-rebase-todo",
  GIT_REBASE_EXEC: "ion:git-rebase-exec",
  GIT_REBASE_ABORT: "ion:git-rebase-abort",
  GIT_REBASE_CONTINUE: "ion:git-rebase-continue",

  // Conflict resolution (3-way merge, accept-side, operation labels)
  GIT_CONFLICT_STAGES: "ion:git-conflict-stages",
  GIT_CONFLICT_ACCEPT: "ion:git-conflict-accept",
  GIT_OP_STATE: "ion:git-op-state",

  // Git worktree operations
  GIT_WORKTREE_ADD: "ion:git-worktree-add",
  GIT_WORKTREE_REMOVE: "ion:git-worktree-remove",
  GIT_WORKTREE_LIST: "ion:git-worktree-list",
  GIT_WORKTREE_STATUS: "ion:git-worktree-status",
  GIT_WORKTREE_MERGE: "ion:git-worktree-merge",
  GIT_WORKTREE_PUSH: "ion:git-worktree-push",
  GIT_WORKTREE_REBASE: "ion:git-worktree-rebase",
  // Worktree lifecycle: repeatable land, sync, and the retire / re-attach
  // pair that lets a conversation outlive its worktree.
  GIT_WORKTREE_LAND: "ion:git-worktree-land",
  GIT_WORKTREE_SYNC: "ion:git-worktree-sync",
  // Bulk sync: every worktree of a repo, sequentially, with rerere replay.
  GIT_WORKTREE_SYNC_ALL: "ion:git-worktree-sync-all",
  GIT_WORKTREE_RETIRE: "ion:git-worktree-retire",
  // Read-only blast-radius preview for a retire: which bench directories would
  // this retire remove? Asked BEFORE the retire, so the caller can refuse when
  // an active conversation lives in a directory the retire would delete.
  GIT_WORKTREE_RETIRE_PREVIEW: "ion:git-worktree-retire-preview",
  GIT_WORKTREE_REATTACH: "ion:git-worktree-reattach",
  // Base staleness: has the feature branch moved ahead of this worktree?
  GIT_WORKTREE_BASE_STATUS: "ion:git-worktree-base-status",
  // Worktree inventory: what worktrees exist for a repo, with the state needed
  // to describe and act on them (the re-entry surface after a tab close).
  GIT_WORKTREE_INVENTORY: "ion:git-worktree-inventory",
  GIT_WORKTREE_APPRAISE: "ion:git-worktree-appraise",
  // Worktree naming. A worktree's own identifiers (`ion-03e81090`,
  // `wt/ion-03e81090`) describe nothing about the work, so a worktree is SEEDED
  // with the name of the conversation that started it (SEED_TITLE, which
  // decides in the main process whether the seed applies — first prompt wins,
  // and a worktree that already has a name keeps it) and the operator can
  // override it (SET_TITLE).
  GIT_WORKTREE_SEED_TITLE: "ion:git-worktree-seed-title",
  GIT_WORKTREE_SET_TITLE: "ion:git-worktree-set-title",
  GIT_WORKTREE_REGISTRATION: "ion:git-worktree-registration",
  // Set or clear the operator's workflow stage on a worktree (registry-scoped;
  // see shared/types-git.ts WorkStage).
  GIT_WORKTREE_SET_STAGE: "ion:git-worktree-set-stage",
  // Re-run provisioning for a worktree whose dependency state the operator
  // believes is wrong. Same code path as creation.
  GIT_WORKTREE_REPROVISION: "ion:git-worktree-reprovision",
  // Reveal a directory in the OS file manager. Separate from OPEN_EXTERNAL,
  // which deliberately rejects non-http(s) URLs.
  REVEAL_PATH: "ion:reveal-path",
  // Integration workspace (the bench): read the workspace list, mutate the
  // member set, and assemble. Assembly is always operator-triggered.
  BENCH_LIST: "ion:bench-list",
  BENCH_RESOLVE_PATH: "ion:bench-resolve-path",
  BENCH_ENSURE: "ion:bench-ensure",
  BENCH_ADD_MEMBER: "ion:bench-add-member",
  BENCH_REMOVE_MEMBER: "ion:bench-remove-member",
  BENCH_SET_ENABLED: "ion:bench-set-enabled",
  BENCH_SET_ORDER: "ion:bench-set-order",
  BENCH_UPDATE_MEMBER: "ion:bench-update-member",
  BENCH_UPDATE_ALL: "ion:bench-update-all",
  BENCH_ASSEMBLE: "ion:bench-assemble",
  BENCH_REFRESH_STALENESS: "ion:bench-refresh-staleness",
  // Reconcile a proven AI-assisted resolve-once merge with its persisted row
  // verdict. Readiness refresh then projects corrected state without assembly.
  BENCH_RECONCILE_RESOLUTION: "ion:bench-reconcile-resolution",
  // Resolve-once: re-create the failed assembly merge and leave it in
  // progress so the ConflictsDialog can resolve it (and rerere record it).
  BENCH_RESOLVE_CONFLICT: "ion:bench-resolve-conflict",
  BENCH_RERERE_COUNT: "ion:bench-rerere-count",
  BENCH_RERERE_FORGET: "ion:bench-rerere-forget",
  BENCH_RERERE_DISCARD_ALL: "ion:bench-rerere-discard-all",
  // Bench-verification analysis materialises the failed tree for read-only diagnosis.
  BENCH_PREPARE_VERIFICATION_ANALYSIS:
    "ion:bench-prepare-verification-analysis",
  // Targeted bench recording recovery: reconstruct selected member merge
  // contexts, forget only their rerere entries, then reassemble.
  BENCH_DISCARD_MEMBER_RECORDINGS: "ion:bench-discard-member-recordings",
  // Desktop-local worktree overlap visualizer. The main process owns the
  // selected repository context so the standalone window never selects paths.
  WORKTREE_OVERLAP_OPEN: "ion:worktree-overlap-open",
  WORKTREE_OVERLAP_CONTEXT: "ion:worktree-overlap-context",
  WORKTREE_OVERLAP_ANALYZE: "ion:worktree-overlap-analyze",
  WORKTREE_OVERLAP_PREVIEW: "ion:worktree-overlap-preview",
  WORKTREE_OVERLAP_APPLY_PREVIEW: "ion:worktree-overlap-apply-preview",
  WORKTREE_OVERLAP_APPLY: "ion:worktree-overlap-apply",
  WORKTREE_OVERLAP_SOLVE: "ion:worktree-overlap-solve",
  WORKTREE_OVERLAP_AUTO_ORDER: "ion:worktree-overlap-auto-order",

  // Filesystem operations
  FS_READ_DIR: "ion:fs-read-dir",
  FS_READ_FILE: "ion:fs-read-file",
  FS_WRITE_FILE: "ion:fs-write-file",
  FS_CREATE_DIR: "ion:fs-create-dir",
  FS_CREATE_FILE: "ion:fs-create-file",
  FS_RENAME: "ion:fs-rename",
  FS_DELETE: "ion:fs-delete",
  FS_SAVE_DIALOG: "ion:fs-save-dialog",
  FS_REVEAL_IN_FINDER: "ion:fs-reveal-in-finder",
  FS_OPEN_NATIVE: "ion:fs-open-native",
  FS_EXISTS: "ion:fs-exists",
  // Fetch + cache a site favicon in the main process, returned as a data:
  // URL so the renderer CSP (img-src 'self' data: blob:) stays untouched.
  FAVICON_GET: "ion:favicon-get",
  FS_WATCH_FILE: "ion:fs-watch-file",
  FS_UNWATCH_FILE: "ion:fs-unwatch-file",
  FS_FILE_CHANGED: "ion:fs-file-changed",

  // Fonts
  LIST_FONTS: "ion:list-fonts",

  // Terminal PTY
  // Terminal PTY
  TERMINAL_CREATE: "ion:terminal-create",
  TERMINAL_DATA: "ion:terminal-data",
  TERMINAL_RESIZE: "ion:terminal-resize",
  TERMINAL_INCOMING: "ion:terminal-incoming",
  TERMINAL_EXIT: "ion:terminal-exit",
  TERMINAL_DESTROY: "ion:terminal-destroy",
  TERMINAL_GET_SCROLLBACK: "ion:terminal-get-scrollback",

  // Deep links (ion:// URL scheme). An untrusted request is described to the
  // operator and waits for an explicit decision before anything runs.
  DEEPLINK_CONFIRM_REQUEST: "ion:deeplink-confirm-request",
  DEEPLINK_CONFIRM_RESULT: "ion:deeplink-confirm-result",
  DEEPLINK_CONFIRM_SETTLED: "ion:deeplink-confirm-settled",
  DEEPLINK_CONFIRM_READY: "ion:deeplink-confirm-ready",
  DEEPLINK_CONFIRM_UNAVAILABLE: "ion:deeplink-confirm-unavailable",

  // Bash command execution
  EXECUTE_BASH: "ion:execute-bash",
  CANCEL_BASH: "ion:cancel-bash",

  // Remote commands (main → renderer, for commands sent from iOS)
  REMOTE_USER_MESSAGE: "ion:remote-user-message",
  REMOTE_BASH_COMMAND: "ion:remote-bash-command",
  REMOTE_SET_PERMISSION_MODE: "ion:remote-set-permission-mode",
  REMOTE_SET_THINKING_EFFORT: "ion:remote-set-thinking-effort",
  REMOTE_CLOSE_TAB: "ion:remote-close-tab",
  REMOTE_RENAME_TAB: "ion:remote-rename-tab",
  REMOTE_RENAME_TERMINAL_INSTANCE: "ion:remote-rename-terminal-instance",
  REMOTE_ENGINE_PROMPT: "ion:remote-engine-prompt",
  REMOTE_SET_PILL_COLOR: "ion:remote-set-pill-color",
  REMOTE_SET_PILL_ICON: "ion:remote-set-pill-icon",
  // Remote send (renderer → main → iOS, for forwarding results to remote)
  REMOTE_SEND: "ion:remote-send",
  REMOTE_SET_LAN_DISABLED: "ion:remote-set-lan-disabled",

  // Remote control
  REMOTE_GET_STATE: "ion:remote-get-state",
  REMOTE_START_PAIRING: "ion:remote-start-pairing",
  REMOTE_CANCEL_PAIRING: "ion:remote-cancel-pairing",
  REMOTE_REVOKE_DEVICE: "ion:remote-revoke-device",
  REMOTE_STATE_CHANGED: "ion:remote-state-changed",
  REMOTE_DISCOVER_RELAYS: "ion:remote-discover-relays",
  REMOTE_STOP_DISCOVERY: "ion:remote-stop-discovery",
  REMOTE_TEST_RELAY: "ion:remote-test-relay",
  REMOTE_RELAY_AUTH_CONFIG: "ion:remote-relay-auth-config",
  REMOTE_RELAYS_CHANGED: "ion:remote-relays-changed",
  REMOTE_DEVICE_PAIRED: "ion:remote-device-paired",
  REMOTE_DEVICE_REVOKED: "ion:remote-device-revoked",
  REMOTE_GET_MESSAGES: "ion:remote-get-messages",
  REMOTE_REQUEST_IOS_LOGS: "ion:remote-request-ios-logs",
  REMOTE_SET_DISPLAY: "ion:remote-set-display",
  REMOTE_DISPLAY_CHANGED: "ion:remote-display-changed",

  // Engine (native extension runtime)
  ENGINE_START: "ion:engine-start",
  ENGINE_ABORT: "ion:engine-abort",
  ENGINE_ABORT_AGENT: "ion:engine-abort-agent",
  ENGINE_DIALOG_RESPONSE: "ion:engine-dialog-response",
  ENGINE_COMMAND: "ion:engine-command",
  ENGINE_STOP: "ion:engine-stop",
  ENGINE_BRANCH_BEFORE: "ion:engine-branch-before",
  ENGINE_REWIND: "ion:engine-rewind",
  ENGINE_EVENT: "ion:engine-event",
  ENGINE_REMAP_SESSION: "ion:engine-remap-session",
  ENGINE_BROADCAST_HISTORY: "ion:engine-broadcast-history",
  ENGINE_GET_CONTEXT_BREAKDOWN: "ion:engine-get-context-breakdown",

  // Plan-mode Bash allowlist (engine policy, stored in engine.json).
  // Read/write the operator-editable list of Bash command prefixes the model
  // may run during plan mode. Backed by ~/.ion/engine.json's
  // limits.planModeAllowedBashCommands; the engine re-reads it fresh at each
  // dispatch, so a write takes effect on the next prompt with no restart.
  GET_PLAN_BASH_ALLOWLIST: "ion:get-plan-bash-allowlist",
  SET_PLAN_BASH_ALLOWLIST: "ion:set-plan-bash-allowlist",

  // Resource focus tracking
  NOTIFY_TAB_FOCUS: "ion:notify-tab-focus",
  MARK_RESOURCE_READ: "ion:mark-resource-read",
  GET_READ_RESOURCE_IDS: "ion:get-read-resource-ids",
  GET_PERSISTED_RESOURCES: "ion:get-persisted-resources",
  DELETE_RESOURCE: "ion:delete-resource",
  RESOURCE_GET: "ion:resource-get",

  // Model & provider management
  LIST_MODELS: "ion:list-models",
  MODEL_TIER_RESOLVE: "ion:model-tier-resolve",
  LIST_MODEL_TIERS: "ion:list-model-tiers",
  SET_MODEL_TIER: "ion:set-model-tier",
  REMOVE_MODEL_TIER: "ion:remove-model-tier",
  MODEL_TIERS_UPDATED: "ion:model-tiers-updated",
  STORE_CREDENTIAL: "ion:store-credential",
  REFRESH_MODELS: "ion:refresh-models",

  // Delegated-CLI provider auth (codex/claude-code/grok/cursor) + per-provider backend
  PROVIDER_LOGIN: "ion:provider-login",
  PROVIDER_LOGIN_CANCEL: "ion:provider-login-cancel",
  PROVIDER_LOGIN_CODE: "ion:provider-login-code",
  PROVIDER_LOGOUT: "ion:provider-logout",
  PROVIDER_LOGIN_EVENT: "ion:provider-login-event",

  // OAuth
  OAUTH_START: "ion:oauth-start",
  OAUTH_LOGOUT: "ion:oauth-logout",
  OAUTH_STATUS: "ion:oauth-status",
  OAUTH_DEVICE_CODE: "ion:oauth-device-code",
  OAUTH_DEVICE_POLL: "ion:oauth-device-poll",

  // Entra OIDC (telemetry auth — Feature 0001 Part F)
  // MCP server administration. The engine owns the mechanism (engine.json CRUD,
  // OAuth discovery, dynamic client registration, PKCE, token storage); these
  // channels forward to it. MCP_LOGIN resolves only after the operator finishes
  // the browser step, so its caller must tolerate a long-running invoke.
  MCP_LIST: "ion:mcp-list",
  MCP_ADD: "ion:mcp-add",
  MCP_REMOVE: "ion:mcp-remove",
  MCP_LOGIN: "ion:mcp-login",
  MCP_LOGOUT: "ion:mcp-logout",

  ENTRA_SIGN_IN: "ion:entra-sign-in",
  ENTRA_SIGN_OUT: "ion:entra-sign-out",
  ENTRA_IDENTITY: "ion:entra-identity",

  // Auto-update
  INSTALL_UPDATE: "ion:install-update",
  UPDATE_DOWNLOADED: "ion:update-downloaded",

  // Legacy (kept for backward compat during migration)
  STREAM_EVENT: "ion:stream-event",
  RUN_COMPLETE: "ion:run-complete",
  RUN_ERROR: "ion:run-error",

  // Event-driven tab metadata delta push (renderer → main → iOS)
  // Fired by tab-slice.ts after any tab field change (title, customTitle, groupId)
  // so the main process can push a lightweight desktop_tab_meta delta over the
  // remote transport without waiting for the next 5 s snapshot poll tick.
  TAB_META_CHANGED: "ion:tab-meta-changed",

  // Renderer-push snapshot projection (renderer → main). The OWNER (overlay)
  // renderer projects RemoteTabStatesPayload from its session store on change
  // (debounced) and pushes it here; the main process caches it in
  // state.rendererSnapshotCache and getRemoteTabStates() serves the cache
  // instead of polling the renderer via executeJavaScript. See
  // renderer/stores/remote-projection-push.ts and main/remote/snapshot.ts.
  REMOTE_TAB_STATES_PUSH: "ion:remote-tab-states-push",

  // Structured renderer-side logging (renderer → main). The main process
  // stamps component=desktop and forwards to the desktop logger.
  LOG_WRITE: "log:write",

  // Agent Team Visualizer (ATV) — secondary floating window
  ATV_OPEN: "atv:open",
  ATV_GET_STATE: "atv:get-state",
  ATV_ACTIVE_TAB: "atv:active-tab",
  ATV_GET_SETTINGS: "atv:get-settings",
  ATV_SET_SETTING: "atv:set-setting",
  ATV_LIST_TABS: "atv:list-tabs",
  ATV_FOCUS_TAB: "atv:focus-tab",
  ATV_FOCUS_AGENT: "atv:focus-agent",
  ATV_LIST_THEMES: "atv:list-themes",
  ATV_READ_THEME_BUNDLE: "atv:read-theme-bundle",
  ATV_READ_THEME_ASSET: "atv:read-theme-asset",
  // Main → overlay renderer push: the ATV window opened/closed (drives the
  // launcher button's active indicator).
  ATV_WINDOW_STATE: "atv:window-state",
  // Mirror-store action forwarding: ATV renderer → main (validated against
  // FORWARDED_ACTIONS) → overlay renderer, which executes on the owner store
  // and replies with the action's return value.
  //
  // Request/response, not fire-and-forget: a mirror caller does
  // `const result = await store.retireWorktree(…)` and needs the owner's real
  // answer. Main mints a callId, relays it with the action on ATV_EXEC_ACTION,
  // and the owner replies once on ATV_ACTION_RESULT.
  ATV_CALL_ACTION: "atv:call-action",
  ATV_EXEC_ACTION: "atv:exec-action",
  ATV_ACTION_RESULT: "atv:action-result",
  // Owner-published tab-metadata snapshot: owner renderer → main (publish),
  // main → ATV window (push), ATV → main (boot pull).
  ATV_PUBLISH_TABS_SYNC: "atv:publish-tabs-sync",
  ATV_TABS_SYNC: "atv:tabs-sync",
  ATV_GET_TABS_SYNC: "atv:get-tabs-sync",
  // Main → ATV push: a permission was answered on SOME surface (overlay,
  // iOS, or ATV) — clear it from the mirror queue and the canvas bubble.
  ATV_PERMISSION_RESOLVED: "atv:permission-resolved",
  // ATV → main: surface the overlay glass (palette cross-link).
  ATV_SHOW_OVERLAY: "atv:show-overlay",
  // ATV → main: save a composed office snapshot PNG via the save dialog.
  ATV_EXPORT_IMAGE: "atv:export-image",
  // ATV → main: live per-tab summaries for the campus view.
  ATV_GET_ALL_STATUS: "atv:get-all-status",
  // ATV → main: save a recorded office clip (webm) via the save dialog.
  ATV_EXPORT_VIDEO: "atv:export-video",
  // Main → ATV push: a user prompt was submitted (any surface) — the mirror
  // inserts it so its transcript matches the owner's optimistic insert.
  // Main → ATV push: a user prompt was submitted (any surface) — the mirror
  // inserts it so its transcript matches the owner's optimistic insert.
  ATV_USER_MESSAGE_ECHO: "atv:user-message-echo",
} as const;

/**
 * An untrusted `ion://` request awaiting the operator's decision.
 *
 * Lives in `shared/` because it crosses the process boundary: main builds it,
 * the preload bridge types it, and the renderer dialog renders it. Every field
 * the operator needs to decide is present — the dialog shows the real
 * command or the real prompt text, because a confirmation that describes the
 * request only vaguely trains people to approve without reading.
 */
export type DeepLinkConfirmOwner = "overlay" | "atv";

export interface DeepLinkConfirmResult {
  id: string;
  owner: DeepLinkConfirmOwner;
  approved: boolean;
  /** Required only when an untrusted terminal link omitted its target. */
  tabId?: string;
}

export interface DeepLinkConfirmRequest {
  /** Correlates the operator's answer with the pending request in main. */
  id: string;
  /** Exactly one renderer presents and may answer this request. */
  owner: DeepLinkConfirmOwner;
  action: "terminal" | "prompt";
  /** True when untrusted terminal request needs explicit target selection. */
  selectTab?: boolean;
  /** Target conversation id (terminal requests). */
  tabId?: string;
  /** Pane label (terminal requests). */
  title?: string;
  /** The command that would run (terminal requests). */
  cmd?: string;
  /** Working directory. */
  dir?: string;
  /** The prompt that would be sent (prompt requests). */
  text?: string;
  /** Whether the prompt would be submitted immediately (prompt requests). */
  submit?: boolean;
}
