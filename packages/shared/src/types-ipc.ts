import { STUDIO_BROWSER_IPC } from './types-ipc-browser'
import { SYSTEM_IPC } from './types-ipc-system'
import { STUDIO_WINDOW_IPC } from './types-ipc-studio'

// ─── IPC Channel Names ───

export const IPC = {
  // Request-response (renderer → main)
  START: "ion:start",
  PROMPT: "ion:prompt",
  SELECT_DIRECTORY: "ion:select-directory",
  SELECT_EXTENSION_FILES: "ion:select-extension-files",
  OPEN_EXTERNAL: "ion:open-external",
  ATTACH_FILES: "ion:attach-files",
  ATTACH_FILE_BY_PATH: "ion:attach-file-by-path",
  TAKE_SCREENSHOT: "ion:take-screenshot",
  // Move a live conversation to a different working directory, preserving its
  // conversationId and history. See engine-control-plane-relocate.ts.

  // One-way events (main → renderer)

  // Window management
  WINDOW_SHOWN: "ion:window-shown",

  // Skill provisioning (main → renderer)
  SKILL_STATUS: "ion:skill-status",

  // Theme

  // Command discovery
  DISCOVER_COMMANDS: "ion:discover-commands",

  // Permission mode
  // Tell the engine a pending plan/question card was resolved by this client,
  // so it stops re-publishing the denial on every status snapshot.

  // Settings persistence
  SHOW_SETTINGS: "ion:show-settings",

  // Tab persistence
  LOAD_TABS: "ion:load-tabs",

  // Conversation backup (user-driven export/restore zip archives)
  CONVERSATION_BACKUP_PROGRESS: "ion:conversation-backup-progress",

  // Session labels

  // File-explorer tree state (expansion, folded roots, selection). Main owns
  // the snapshot so both presentations converge and it survives a relaunch.
  EXPLORER_STATE_CHANGED: "ion:explorer-state-changed",

  // Session chains (composite conversation grouping)

  // Conversation retrieval (agent child sessions)

  // Batch conversation loading (all sessions in a chain in one roundtrip)

  // Enterprise policy

  // Theme packs (custom color themes; main scans disk, renderer registers)

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
  GIT_EVENT: "ion:git-event",
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
  // Explicit destructive lifecycle operation. It appraises and preserves work
  // before removing the checkout and branch without integrating into source.
  GIT_WORKTREE_REBASE: "ion:git-worktree-rebase",
  // Terminal lifecycle operation: integrate the branch, then remove the clean
  // worktree and its branch in the same repository mutation slot.
  // Bulk sync: every worktree of a repo, sequentially, with rerere replay.
  // Read-only blast-radius preview for a retire: which bench directories would
  // this retire remove? Asked BEFORE the retire, so the caller can refuse when
  // an active conversation lives in a directory the retire would delete.
  GIT_WORKTREE_RETIRE_PREVIEW: "ion:git-worktree-retire-preview",
  // Base staleness: has the feature branch moved ahead of this worktree?
  // Worktree inventory: what worktrees exist for a repo, with the state needed
  // to describe and act on them (the re-entry surface after a tab close).
  GIT_WORKTREE_APPRAISE: "ion:git-worktree-appraise",
  // Worktree naming. A worktree's own identifiers (`ion-03e81090`,
  // `wt/ion-03e81090`) describe nothing about the work, so a worktree is SEEDED
  // with the name of the conversation that started it (SEED_TITLE, which
  // decides in the main process whether the seed applies — first prompt wins,
  // and a worktree that already has a name keeps it) and the operator can
  // override it (SET_TITLE).
  GIT_WORKTREE_SET_TITLE: "ion:git-worktree-set-title",
  // Set or clear the operator's workflow stage on a worktree (registry-scoped;
  // see shared/types-git.ts WorkStage).
  // Durable main-process automations. No renderer executes automation code.
  // Source-aware listing + per-item user CRUD; the old whole-list AUTOMATION_SAVE
  // is gone so a merged effective list can never copy a non-user rule into ~/.ion.
  // Main forwards validated declarative actions to owner renderer only.
  AUTOMATION_COMMAND: "ion:automation-command",
  OPEN_AUTH_URL: "ion:open-auth-url",
  // FR-04: per-principal git credentials (Studio Settings "Git identity").
  // Mirrors the git.identity.* studio_actions the browser client dispatches
  // directly -- the desktop main process calls the same @ion/server/git/identity
  // modules in-process, using its own local principal.
  // Owner renderer acknowledges success or failure for each command.
  // Re-run provisioning for a worktree whose dependency state the operator
  // believes is wrong. Same code path as creation.
  // Reveal a directory in the OS file manager. Separate from OPEN_EXTERNAL,
  // which deliberately rejects non-http(s) URLs.
  REVEAL_PATH: "ion:reveal-path",
  // Catch an OAuth redirect on this machine for a sign-in a server elsewhere
  // finishes: listen returns { id, redirectUri }, await resolves with the
  // address the browser landed on, cancel stops waiting.
  OAUTH_CALLBACK_LISTEN: "ion:oauth-callback-listen",
  OAUTH_CALLBACK_AWAIT: "ion:oauth-callback-await",
  OAUTH_CALLBACK_CANCEL: "ion:oauth-callback-cancel",
  // Integration workspace (the bench): read the workspace list, mutate the
  // member set, and assemble. Assembly is always operator-triggered.
  // Reconcile a proven AI-assisted resolve-once merge with its persisted row
  // verdict. Readiness refresh then projects corrected state without assembly.
  // Resolve-once: re-create the failed assembly merge and leave it in
  // progress so the ConflictsDialog can resolve it (and rerere record it).
  // Bench-verification recovery: materialise the failing tree for the
  // AI-assisted analysis conversation, and the targeted discard-and-reassemble
  // verb the recovery dialog offers.

  // Filesystem operations
  FS_SAVE_DIALOG: "ion:fs-save-dialog",
  FS_REVEAL_IN_FINDER: "ion:fs-reveal-in-finder",
  FS_OPEN_NATIVE: "ion:fs-open-native",
  // Open a local copy of a file whose bytes came from a remote Environment.
  FS_OPEN_NATIVE_DATA: "ion:fs-open-native-data",
  // Save a copy of a file whose bytes came from a remote Environment, via a
  // Save dialog that opens in Downloads.
  FS_SAVE_DATA: "ion:fs-save-data",
  // Fetch + cache a site favicon in the main process, returned as a data:
  // URL so the renderer CSP (img-src 'self' data: blob:) stays untouched.
  FAVICON_GET: "ion:favicon-get",
  FS_FILE_CHANGED: "ion:fs-file-changed",

  // Graph View
  GRAPH_VIEW_CONFIG_CHANGED: "ion:graph-view-config-changed",
  GRAPH_CORPUS_DELTA: "ion:graph-corpus-delta",
  // Correlated main -> Studio graph tool commands; answered on RESULT by callId.
  // The graph store lives in the Studio renderer, so an agent's graph tool
  // call is a request the renderer applies and acknowledges.

  // Fonts

  // Terminal PTY
  TERMINAL_ACTIVITY: "ion:terminal-activity",
  TERMINAL_INCOMING: "ion:terminal-incoming",
  TERMINAL_EXIT: "ion:terminal-exit",
  // A terminal's processes were stopped and a fresh shell started under the
  // same key. Published as (key, startError | null); clients clear the view.
  TERMINAL_RESTARTED: "ion:terminal-restarted",
  // Attach protocol (D2): history snapshot + lifecycle state in one call,
  // with optional respawn-on-demand for dead terminals.
  // Conversation Terminal Panel metadata, a per-principal studio_event
  // channel every client hydrates from.
  STUDIO_CONVERSATION_TERMINALS: "studio:conversation-terminals",
  ...STUDIO_BROWSER_IPC,
  // System/OS facilities: fonts, diagnostics, clipboard, chart navigation.
  ...SYSTEM_IPC,
  WORKTREE_OVERLAP_OPEN: "ion:worktree-overlap-open",
  WORKTREE_OVERLAP_CONTEXT: "ion:worktree-overlap-context",

  // Deep links (ion:// URL scheme). An untrusted request is described to the
  // operator and waits for an explicit decision before anything runs.
  DEEPLINK_CONFIRM_REQUEST: "ion:deeplink-confirm-request",
  DEEPLINK_CONFIRM_SETTLED: "ion:deeplink-confirm-settled",

  // Bash command execution

  // Remote send (renderer → main → iOS, for forwarding results to remote)

  // Remote control
  REMOTE_STATE_CHANGED: "ion:remote-state-changed",
  REMOTE_RELAYS_CHANGED: "ion:remote-relays-changed",
  REMOTE_DEVICE_PAIRED: "ion:remote-device-paired",
  REMOTE_DEVICE_REVOKED: "ion:remote-device-revoked",
  REMOTE_DISPLAY_CHANGED: "ion:remote-display-changed",


  // Plan-mode Bash allowlist (engine policy, stored in engine.json).
  // Read/write the operator-editable list of Bash command prefixes the model
  // may run during plan mode. Backed by ~/.ion/engine.json's
  // limits.planModeAllowedBashCommands; the engine re-reads it fresh at each
  // dispatch, so a write takes effect on the next prompt with no restart.

  // Guided Questions (AskUserQuestions wizard). Main owns the workflow
  // (QuestionsCoordinator); renderers read state and send revisioned
  // patches/actions. QUESTIONS_STATE is the broadcast channel.
  QUESTIONS_STATE: "ion:questions-state",
  // Native image picker for per-question answer attachments.
  QUESTIONS_PICK_ATTACHMENTS: "ion:questions-pick-attachments",
  // Rebuild a parked question from a restored conversation transcript. The
  // transcript is the authority for whether a question is outstanding; the
  // ~/.ion/questions record only caches the operator's typed draft.

  // Resource focus tracking
  /** Main → renderer: catalog changed outside a live delta (see chart-restore). */
  RESOURCE_CATALOG_CHANGED: "ion:resource-catalog-changed",

  // Model & provider management

  // Delegated-CLI provider auth (codex/claude-code/grok/cursor) + per-provider backend
  PROVIDER_LOGIN_EVENT: "ion:provider-login-event",

  // OAuth

  // Entra OIDC (telemetry auth — Feature 0001 Part F)
  // MCP server administration. The engine owns the mechanism (engine.json CRUD,
  // OAuth discovery, dynamic client registration, PKCE, token storage); these
  // channels forward to it. MCP_LOGIN resolves only after the operator finishes
  // the browser step, so its caller must tolerate a long-running invoke.

  // Auto-update
  INSTALL_UPDATE: "ion:install-update",
  RESTART_FOR_UPDATE: "ion:restart-for-update",
  UPDATE_DOWNLOADED: "ion:update-downloaded",
  UPDATE_PROGRESS: "ion:update-progress",
  UPDATE_STAGED: "ion:update-staged",
  UPDATE_ERROR: "ion:update-error",

  // Legacy (kept for backward compat during migration)

  // Event-driven tab metadata delta push (renderer → main → iOS)
  // Fired by tab-slice.ts after any tab field change (title, customTitle)
  // so the main process can push a lightweight desktop_tab_meta delta over the
  // remote transport without waiting for the next 5 s snapshot poll tick.

  // Renderer-push snapshot projection (renderer → main). The OWNER (overlay)
  // renderer projects RemoteTabStatesPayload from its session store on change
  // (debounced) and pushes it here; the main process caches it in
  // state.rendererSnapshotCache and getRemoteTabStates() serves the cache
  // instead of polling the renderer via executeJavaScript. See
  // renderer/stores/remote-projection-push.ts and main/remote/snapshot.ts.

  // Structured renderer-side logging (renderer → main). The main process
  // stamps component=desktop and forwards to the desktop logger.
  LOG_WRITE: "log:write",

  ...STUDIO_WINDOW_IPC,
} as const;

export type {
  DeepLinkConfirmOwner,
  DeepLinkConfirmRequest,
  DeepLinkConfirmResult,
} from './types-ipc-deeplink'
