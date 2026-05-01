// ─── IPC Channel Names ───

export const IPC = {
  // Request-response (renderer → main)
  START: 'ion:start',
  CREATE_TAB: 'ion:create-tab',
  PROMPT: 'ion:prompt',
  CANCEL: 'ion:cancel',
  STOP_TAB: 'ion:stop-tab',
  RETRY: 'ion:retry',
  STATUS: 'ion:status',
  TAB_HEALTH: 'ion:tab-health',
  CLOSE_TAB: 'ion:close-tab',
  SELECT_DIRECTORY: 'ion:select-directory',
  SELECT_EXTENSION_FILES: 'ion:select-extension-files',
  OPEN_EXTERNAL: 'ion:open-external',
  OPEN_IN_VSCODE: 'ion:open-in-vscode',
  ATTACH_FILES: 'ion:attach-files',
  ATTACH_FILE_BY_PATH: 'ion:attach-file-by-path',
  TAKE_SCREENSHOT: 'ion:take-screenshot',
  TRANSCRIBE_AUDIO: 'ion:transcribe-audio',
  PASTE_IMAGE: 'ion:paste-image',
  GET_DIAGNOSTICS: 'ion:get-diagnostics',
  RESPOND_PERMISSION: 'ion:respond-permission',
  APPROVE_DENIED_TOOLS: 'ion:approve-denied-tools',
  INIT_SESSION: 'ion:init-session',
  RESET_TAB_SESSION: 'ion:reset-tab-session',
  ANIMATE_HEIGHT: 'ion:animate-height',
  LIST_SESSIONS: 'ion:list-sessions',
  LIST_ALL_SESSIONS: 'ion:list-all-sessions',
  LOAD_SESSION: 'ion:load-session',
  READ_PLAN: 'ion:read-plan',

  // One-way events (main → renderer)
  TEXT_CHUNK: 'ion:text-chunk',
  TOOL_CALL: 'ion:tool-call',
  TOOL_CALL_UPDATE: 'ion:tool-call-update',
  TOOL_CALL_COMPLETE: 'ion:tool-call-complete',
  TASK_UPDATE: 'ion:task-update',
  TASK_COMPLETE: 'ion:task-complete',
  SESSION_DEAD: 'ion:session-dead',
  SESSION_INIT: 'ion:session-init',
  ERROR: 'ion:error',
  RATE_LIMIT: 'ion:rate-limit',

  // Window management
  RESIZE_HEIGHT: 'ion:resize-height',
  SET_WINDOW_WIDTH: 'ion:set-window-width',
  HIDE_WINDOW: 'ion:hide-window',
  WINDOW_SHOWN: 'ion:window-shown',
  SET_IGNORE_MOUSE_EVENTS: 'ion:set-ignore-mouse-events',
  IS_VISIBLE: 'ion:is-visible',

  // Skill provisioning (main → renderer)
  SKILL_STATUS: 'ion:skill-status',

  // Theme
  GET_THEME: 'ion:get-theme',
  THEME_CHANGED: 'ion:theme-changed',

  // Command discovery
  DISCOVER_COMMANDS: 'ion:discover-commands',

  // Permission mode
  SET_PERMISSION_MODE: 'ion:set-permission-mode',

  // Settings persistence
  LOAD_SETTINGS: 'ion:load-settings',
  SAVE_SETTINGS: 'ion:save-settings',
  SHOW_SETTINGS: 'ion:show-settings',

  // Tab persistence
  LOAD_TABS: 'ion:load-tabs',
  SAVE_TABS: 'ion:save-tabs',

  // Session labels
  SAVE_SESSION_LABEL: 'ion:save-session-label',
  LOAD_SESSION_LABELS: 'ion:load-session-labels',
  GENERATE_TITLE: 'ion:generate-title',

  // Session chains (composite conversation grouping)
  LOAD_SESSION_CHAINS: 'ion:load-session-chains',
  SAVE_SESSION_CHAINS: 'ion:save-session-chains',

  // Conversation retrieval (agent child sessions)
  GET_CONVERSATION: 'ion:get-conversation',

  // Backend mode
  GET_BACKEND: 'ion:get-backend',
  SWITCH_BACKEND: 'ion:switch-backend',

  // Git operations
  GIT_GRAPH: 'ion:git-graph',
  GIT_CHANGES: 'ion:git-changes',
  GIT_IS_REPO: 'ion:git-is-repo',
  GIT_COMMIT: 'ion:git-commit',
  GIT_FETCH: 'ion:git-fetch',
  GIT_PULL: 'ion:git-pull',
  GIT_PUSH: 'ion:git-push',
  GIT_BRANCHES: 'ion:git-branches',
  GIT_CHECKOUT: 'ion:git-checkout',
  GIT_CREATE_BRANCH: 'ion:git-create-branch',
  GIT_DIFF: 'ion:git-diff',
  GIT_STAGE: 'ion:git-stage',
  GIT_UNSTAGE: 'ion:git-unstage',
  GIT_DISCARD: 'ion:git-discard',
  GIT_DELETE_BRANCH: 'ion:git-delete-branch',
  GIT_COMMIT_DETAIL: 'ion:git-commit-detail',
  GIT_COMMIT_FILES: 'ion:git-commit-files',
  GIT_COMMIT_FILE_DIFF: 'ion:git-commit-file-diff',
  GIT_IGNORED_FILES: 'ion:git-ignored-files',

  // Git worktree operations
  GIT_WORKTREE_ADD: 'ion:git-worktree-add',
  GIT_WORKTREE_REMOVE: 'ion:git-worktree-remove',
  GIT_WORKTREE_LIST: 'ion:git-worktree-list',
  GIT_WORKTREE_STATUS: 'ion:git-worktree-status',
  GIT_WORKTREE_MERGE: 'ion:git-worktree-merge',
  GIT_WORKTREE_PUSH: 'ion:git-worktree-push',
  GIT_WORKTREE_REBASE: 'ion:git-worktree-rebase',

  // Filesystem operations
  FS_READ_DIR: 'ion:fs-read-dir',
  FS_READ_FILE: 'ion:fs-read-file',
  FS_WRITE_FILE: 'ion:fs-write-file',
  FS_CREATE_DIR: 'ion:fs-create-dir',
  FS_CREATE_FILE: 'ion:fs-create-file',
  FS_RENAME: 'ion:fs-rename',
  FS_DELETE: 'ion:fs-delete',
  FS_SAVE_DIALOG: 'ion:fs-save-dialog',
  FS_REVEAL_IN_FINDER: 'ion:fs-reveal-in-finder',
  FS_OPEN_NATIVE: 'ion:fs-open-native',
  FS_WATCH_FILE: 'ion:fs-watch-file',
  FS_UNWATCH_FILE: 'ion:fs-unwatch-file',
  FS_FILE_CHANGED: 'ion:fs-file-changed',

  // Fonts
  LIST_FONTS: 'ion:list-fonts',

  // Terminal PTY
  TERMINAL_CREATE: 'ion:terminal-create',
  TERMINAL_DATA: 'ion:terminal-data',
  TERMINAL_RESIZE: 'ion:terminal-resize',
  TERMINAL_INCOMING: 'ion:terminal-incoming',
  TERMINAL_EXIT: 'ion:terminal-exit',
  TERMINAL_DESTROY: 'ion:terminal-destroy',

  // Bash command execution
  EXECUTE_BASH: 'ion:execute-bash',
  CANCEL_BASH: 'ion:cancel-bash',

  // Remote commands (main → renderer, for commands sent from iOS)
  REMOTE_USER_MESSAGE: 'ion:remote-user-message',
  REMOTE_BASH_COMMAND: 'ion:remote-bash-command',
  REMOTE_SET_PERMISSION_MODE: 'ion:remote-set-permission-mode',
  REMOTE_CLOSE_TAB: 'ion:remote-close-tab',
  REMOTE_RENAME_TAB: 'ion:remote-rename-tab',
  REMOTE_RENAME_TERMINAL_INSTANCE: 'ion:remote-rename-terminal-instance',
  // Remote send (renderer → main → iOS, for forwarding results to remote)
  REMOTE_SEND: 'ion:remote-send',
  REMOTE_SET_LAN_DISABLED: 'ion:remote-set-lan-disabled',

  // Remote control
  REMOTE_GET_STATE: 'ion:remote-get-state',
  REMOTE_START_PAIRING: 'ion:remote-start-pairing',
  REMOTE_CANCEL_PAIRING: 'ion:remote-cancel-pairing',
  REMOTE_REVOKE_DEVICE: 'ion:remote-revoke-device',
  REMOTE_STATE_CHANGED: 'ion:remote-state-changed',
  REMOTE_DISCOVER_RELAYS: 'ion:remote-discover-relays',
  REMOTE_STOP_DISCOVERY: 'ion:remote-stop-discovery',
  REMOTE_TEST_RELAY: 'ion:remote-test-relay',
  REMOTE_RELAYS_CHANGED: 'ion:remote-relays-changed',
  REMOTE_DEVICE_PAIRED: 'ion:remote-device-paired',
  REMOTE_DEVICE_REVOKED: 'ion:remote-device-revoked',
  REMOTE_GET_MESSAGES: 'ion:remote-get-messages',

  // Engine (native extension runtime)
  ENGINE_START: 'ion:engine-start',
  ENGINE_PROMPT: 'ion:engine-prompt',
  ENGINE_ABORT: 'ion:engine-abort',
  ENGINE_ABORT_AGENT: 'ion:engine-abort-agent',
  ENGINE_DIALOG_RESPONSE: 'ion:engine-dialog-response',
  ENGINE_COMMAND: 'ion:engine-command',
  ENGINE_STOP: 'ion:engine-stop',
  ENGINE_EVENT: 'ion:engine-event',

  // Legacy (kept for backward compat during migration)
  STREAM_EVENT: 'ion:stream-event',
  RUN_COMPLETE: 'ion:run-complete',
  RUN_ERROR: 'ion:run-error',
} as const
