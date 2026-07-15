import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import { atvApi } from './atv-api'
import type { NormalizedEvent, EnrichedError, GitEvent } from '../shared/types'
import type { IonAPI } from './ionapi'

export type { IonAPI } from './ionapi'

const api: IonAPI = {
  // Agent Team Visualizer bridge (see preload/atv-api.ts)
  ...atvApi,
  // ─── Request-response ───
  start: () => ipcRenderer.invoke(IPC.START),
  createTab: () => ipcRenderer.invoke(IPC.CREATE_TAB),
  adoptTab: (tabId: string) => ipcRenderer.invoke(IPC.ADOPT_TAB, tabId),
  prompt: (tabId, requestId, options) => ipcRenderer.invoke(IPC.PROMPT, { tabId, requestId, options }),
  cancel: (requestId) => ipcRenderer.invoke(IPC.CANCEL, requestId),
  steer: (tabId, message) => ipcRenderer.send(IPC.STEER, { tabId, message }),
  stopTab: (tabId) => ipcRenderer.invoke(IPC.STOP_TAB, tabId),
  retry: (tabId, requestId, options) => ipcRenderer.invoke(IPC.RETRY, { tabId, requestId, options }),
  status: () => ipcRenderer.invoke(IPC.STATUS),
  tabHealth: () => ipcRenderer.invoke(IPC.TAB_HEALTH),
  closeTab: (tabId) => ipcRenderer.invoke(IPC.CLOSE_TAB, tabId),
  tabMetaChanged: (payload: { tabId: string; title?: string; runCostUsd?: number; totalCostUsd?: number; groupId?: string | null }) =>
    ipcRenderer.send(IPC.TAB_META_CHANGED, payload),
  selectDirectory: () => ipcRenderer.invoke(IPC.SELECT_DIRECTORY),
  selectExtensionFiles: () => ipcRenderer.invoke(IPC.SELECT_EXTENSION_FILES),
  getEngineHostInfo: () => ipcRenderer.invoke(IPC.GET_ENGINE_HOST_INFO),
  listEngineDirectory: (path: string, showHidden: boolean) =>
    ipcRenderer.invoke(IPC.LIST_ENGINE_DIRECTORY, path, showHidden),
  engineIsRemote: () => ipcRenderer.invoke(IPC.ENGINE_IS_REMOTE),
  getEnterprisePolicy: () => ipcRenderer.invoke(IPC.GET_ENTERPRISE_POLICY),
  openExternal: (url) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
  attachFiles: () => ipcRenderer.invoke(IPC.ATTACH_FILES),
  attachFileByPath: (path) => ipcRenderer.invoke(IPC.ATTACH_FILE_BY_PATH, path),
  takeScreenshot: () => ipcRenderer.invoke(IPC.TAKE_SCREENSHOT),
  pasteImage: (dataUrl) => ipcRenderer.invoke(IPC.PASTE_IMAGE, dataUrl),
  transcribeAudio: (audioBase64) => ipcRenderer.invoke(IPC.TRANSCRIBE_AUDIO, audioBase64),
  getDiagnostics: () => ipcRenderer.invoke(IPC.GET_DIAGNOSTICS),
  respondPermission: (tabId, questionId, optionId) =>
    ipcRenderer.invoke(IPC.RESPOND_PERMISSION, { tabId, questionId, optionId }),
  respondElicitation: (tabId, requestId, response, cancelled) =>
    ipcRenderer.invoke(IPC.RESPOND_ELICITATION, { tabId, requestId, response, cancelled }),
  approveDeniedTools: (tabId: string, toolNames: string[]) =>
    ipcRenderer.invoke(IPC.APPROVE_DENIED_TOOLS, { tabId, toolNames }),
  initSession: (tabId) => ipcRenderer.send(IPC.INIT_SESSION, tabId),
  ensureEngineSession: (args) => ipcRenderer.invoke(IPC.ENSURE_ENGINE_SESSION, args),
  resetTabSession: (tabId) => ipcRenderer.send(IPC.RESET_TAB_SESSION, tabId),
  restartTabSession: (tabId: string) => ipcRenderer.send(IPC.RESTART_TAB_SESSION, tabId),
  listSessions: (projectPath?: string) => ipcRenderer.invoke(IPC.LIST_SESSIONS, projectPath),
  listAllSessions: () => ipcRenderer.invoke(IPC.LIST_ALL_SESSIONS),
  loadSession: (sessionId: string, projectPath?: string, encodedDir?: string) => ipcRenderer.invoke(IPC.LOAD_SESSION, { sessionId, projectPath, encodedDir }),
  conversationExists: (sessionId: string): Promise<boolean> => ipcRenderer.invoke(IPC.CONVERSATION_EXISTS, sessionId),
  readPlan: (filePath: string) => ipcRenderer.invoke(IPC.READ_PLAN, filePath),
  readImageDataUrl: (filePath: string) => ipcRenderer.invoke(IPC.READ_IMAGE_DATA_URL, filePath),
  discoverCommands: (projectPath: string) => ipcRenderer.invoke(IPC.DISCOVER_COMMANDS, projectPath),
  listFonts: () => ipcRenderer.invoke(IPC.LIST_FONTS),
  terminalCreate: (key, cwd) => ipcRenderer.invoke(IPC.TERMINAL_CREATE, { key, cwd }),
  terminalWrite: (key, data) => ipcRenderer.send(IPC.TERMINAL_DATA, { key, data }),
  terminalResize: (key, cols, rows) => ipcRenderer.send(IPC.TERMINAL_RESIZE, { key, cols, rows }),
  terminalDestroy: (key) => ipcRenderer.invoke(IPC.TERMINAL_DESTROY, { key }),
  onTerminalData: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, key: string, data: string) => callback(key, data)
    ipcRenderer.on(IPC.TERMINAL_INCOMING, handler)
    return () => ipcRenderer.removeListener(IPC.TERMINAL_INCOMING, handler)
  },
  onTerminalExit: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, key: string, exitCode: number) => callback(key, exitCode)
    ipcRenderer.on(IPC.TERMINAL_EXIT, handler)
    return () => ipcRenderer.removeListener(IPC.TERMINAL_EXIT, handler)
  },
  executeBash: (id, command, cwd) => ipcRenderer.invoke(IPC.EXECUTE_BASH, { id, command, cwd }),
  cancelBash: (id) => ipcRenderer.send(IPC.CANCEL_BASH, id),
  sendRemote: (event) => ipcRenderer.send(IPC.REMOTE_SEND, event),
  setPermissionMode: (tabId, mode, source, planFilePath) => ipcRenderer.send(IPC.SET_PERMISSION_MODE, { tabId, mode, source, planFilePath }),
  getTheme: () => ipcRenderer.invoke(IPC.GET_THEME),
  onThemeChange: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, isDark: boolean) => callback(isDark)
    ipcRenderer.on(IPC.THEME_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.THEME_CHANGED, handler)
  },
  loadSettings: () => ipcRenderer.invoke(IPC.LOAD_SETTINGS),
  saveSettings: (data) => ipcRenderer.invoke(IPC.SAVE_SETTINGS, data),
  loadTabs: () => ipcRenderer.invoke(IPC.LOAD_TABS),
  saveTabs: (data) => ipcRenderer.invoke(IPC.SAVE_TABS, data),
  saveSessionLabel: (sessionId, customTitle) => ipcRenderer.invoke(IPC.SAVE_SESSION_LABEL, { sessionId, customTitle }),
  loadSessionLabels: () => ipcRenderer.invoke(IPC.LOAD_SESSION_LABELS),
  generateTitle: (text) => ipcRenderer.invoke(IPC.GENERATE_TITLE, text),
  loadSessionChains: () => ipcRenderer.invoke(IPC.LOAD_SESSION_CHAINS),
  saveSessionChains: (data) => ipcRenderer.invoke(IPC.SAVE_SESSION_CHAINS, data),
  getConversation: (conversationId: string, offset = 0, limit = 50) =>
    ipcRenderer.invoke(IPC.GET_CONVERSATION, { conversationId, offset, limit }),
  loadChainHistory: (sessionIds: string[]) =>
    ipcRenderer.invoke(IPC.LOAD_CHAIN_HISTORY, sessionIds),
  getBackend: () => ipcRenderer.invoke(IPC.GET_BACKEND),
  switchBackend: (backend) => ipcRenderer.invoke(IPC.SWITCH_BACKEND, backend),
  loadOtherBackendTabs: () => ipcRenderer.invoke(IPC.LOAD_OTHER_BACKEND_TABS),
  migrateTabs: (conversationIds, targetBackend) => ipcRenderer.invoke(IPC.MIGRATE_TABS, { conversationIds, targetBackend }),

  // ─── Conversation backup ───
  conversationExportPreview: (scope) => ipcRenderer.invoke(IPC.CONVERSATION_EXPORT_PREVIEW, { scope }),
  conversationExport: (args) => ipcRenderer.invoke(IPC.CONVERSATION_EXPORT, args),
  conversationRestorePreview: (args) => ipcRenderer.invoke(IPC.CONVERSATION_RESTORE_PREVIEW, args ?? {}),
  conversationRestore: (args) => ipcRenderer.invoke(IPC.CONVERSATION_RESTORE, args),
  onConversationBackupProgress: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { current: number; total: number; label: string }) => callback(data)
    ipcRenderer.on(IPC.CONVERSATION_BACKUP_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC.CONVERSATION_BACKUP_PROGRESS, handler)
  },

  // ─── Git operations ───
  gitIsRepo: (directory) => ipcRenderer.invoke(IPC.GIT_IS_REPO, directory),
  gitGraph: (directory, skip, limit, search, author, extra) => ipcRenderer.invoke(IPC.GIT_GRAPH, { directory, skip, limit, search, author, ...(extra ?? {}) }),
  gitChanges: (directory) => ipcRenderer.invoke(IPC.GIT_CHANGES, { directory }),
  gitCommit: (directory, message, opts) => {
    const args = typeof opts === 'boolean'
      ? { directory, message, amend: opts }
      : { directory, message, amend: opts?.amend, signoff: opts?.signoff, gpg: opts?.gpg }
    return ipcRenderer.invoke(IPC.GIT_COMMIT, args)
  },
  gitFetch: (directory) => ipcRenderer.invoke(IPC.GIT_FETCH, { directory }),
  gitPull: (directory) => ipcRenderer.invoke(IPC.GIT_PULL, { directory }),
  gitPush: (directory) => ipcRenderer.invoke(IPC.GIT_PUSH, { directory }),
  gitBranches: (directory) => ipcRenderer.invoke(IPC.GIT_BRANCHES, { directory }),
  gitCheckout: (directory, branch) => ipcRenderer.invoke(IPC.GIT_CHECKOUT, { directory, branch }),
  gitCreateBranch: (directory, name) => ipcRenderer.invoke(IPC.GIT_CREATE_BRANCH, { directory, name }),
  gitDiff: (directory, path, staged) => ipcRenderer.invoke(IPC.GIT_DIFF, { directory, path, staged }),
  gitStage: (directory, paths) => ipcRenderer.invoke(IPC.GIT_STAGE, { directory, paths }),
  gitUnstage: (directory, paths) => ipcRenderer.invoke(IPC.GIT_UNSTAGE, { directory, paths }),
  gitDiscard: (directory, paths) => ipcRenderer.invoke(IPC.GIT_DISCARD, { directory, paths }),
  gitDeleteBranch: (directory, branch) => ipcRenderer.invoke(IPC.GIT_DELETE_BRANCH, { directory, branch }),
  gitCommitDetail: (directory, hash) => ipcRenderer.invoke(IPC.GIT_COMMIT_DETAIL, { directory, hash }),
  gitCommitFiles: (directory, hash) => ipcRenderer.invoke(IPC.GIT_COMMIT_FILES, { directory, hash }),
  gitCommitFileDiff: (directory, hash, path) => ipcRenderer.invoke(IPC.GIT_COMMIT_FILE_DIFF, { directory, hash, path }),
  gitIgnoredFiles: (directory) => ipcRenderer.invoke(IPC.GIT_IGNORED_FILES, directory),
  gitStashList: (directory: string) => ipcRenderer.invoke(IPC.GIT_STASH_LIST, { directory }),
  gitStashSave: (directory: string, message?: string) => ipcRenderer.invoke(IPC.GIT_STASH_SAVE, { directory, message }),
  gitStashPop: (directory: string, ref?: string) => ipcRenderer.invoke(IPC.GIT_STASH_POP, { directory, ref }),
  gitStashDrop: (directory: string, ref: string) => ipcRenderer.invoke(IPC.GIT_STASH_DROP, { directory, ref }),
  gitCherryPick: (directory: string, hash: string) => ipcRenderer.invoke(IPC.GIT_CHERRY_PICK, { directory, hash }),
  gitRevert: (directory: string, hash: string) => ipcRenderer.invoke(IPC.GIT_REVERT, { directory, hash }),
  gitReset: (directory: string, hash: string, mode: 'soft' | 'mixed' | 'hard') => ipcRenderer.invoke(IPC.GIT_RESET, { directory, hash, mode }),
  gitBlame: (directory: string, path: string) => ipcRenderer.invoke(IPC.GIT_BLAME, { directory, path }),
  gitConflicts: (directory: string) => ipcRenderer.invoke(IPC.GIT_CONFLICTS, { directory }),
  gitConflictFile: (directory: string, path: string) => ipcRenderer.invoke(IPC.GIT_CONFLICT_FILE, { directory, path }),
  gitResolveConflict: (directory: string, path: string, content: string) => ipcRenderer.invoke(IPC.GIT_RESOLVE_CONFLICT, { directory, path, content }),
  gitRebaseTodo: (directory: string, onto: string) => ipcRenderer.invoke(IPC.GIT_REBASE_TODO, { directory, onto }),
  gitRebaseExec: (directory: string, onto: string, commits: Array<{ hash: string; action: string }>) => ipcRenderer.invoke(IPC.GIT_REBASE_EXEC, { directory, onto, commits }),
  gitRebaseAbort: (directory: string) => ipcRenderer.invoke(IPC.GIT_REBASE_ABORT, { directory }),
  gitRebaseContinue: (directory: string) => ipcRenderer.invoke(IPC.GIT_REBASE_CONTINUE, { directory }),
  gitSubscribe: (directory) => ipcRenderer.invoke(IPC.GIT_SUBSCRIBE, { directory }),
  gitUnsubscribe: (directory) => ipcRenderer.invoke(IPC.GIT_UNSUBSCRIBE, { directory }),
  gitRefresh: (directory) => ipcRenderer.invoke(IPC.GIT_REFRESH, { directory }),
  gitApplyPatch: (directory, patch, opts) => ipcRenderer.invoke(IPC.GIT_APPLY_PATCH, { directory, patch, reverse: opts?.reverse, cached: opts?.cached }),
  gitTagCreate: (directory, name, ref, message) => ipcRenderer.invoke(IPC.GIT_TAG_CREATE, { directory, name, ref, message }),
  gitShowFile: (directory, hash, path) => ipcRenderer.invoke(IPC.GIT_SHOW_FILE, { directory, hash, path }),
  gitCommitSignature: (directory, hash) => ipcRenderer.invoke(IPC.GIT_COMMIT_SIGNATURE, { directory, hash }),
  gitRecentRefs: (directory, limit) => ipcRenderer.invoke(IPC.GIT_RECENT_REFS, { directory, limit }),
  onGitEvent: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, event: GitEvent) => callback(event)
    ipcRenderer.on(IPC.GIT_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC.GIT_EVENT, handler)
  },

  // ─── Git worktree operations ───
  gitWorktreeAdd: (repoPath, sourceBranch) => ipcRenderer.invoke(IPC.GIT_WORKTREE_ADD, { repoPath, sourceBranch }),
  gitWorktreeRemove: (repoPath, worktreePath, branchName, force) => ipcRenderer.invoke(IPC.GIT_WORKTREE_REMOVE, { repoPath, worktreePath, branchName, force }),
  gitWorktreeList: (repoPath) => ipcRenderer.invoke(IPC.GIT_WORKTREE_LIST, { repoPath }),
  gitWorktreeStatus: (worktreePath, sourceBranch) => ipcRenderer.invoke(IPC.GIT_WORKTREE_STATUS, { worktreePath, sourceBranch }),
  gitWorktreeMerge: (repoPath, worktreeBranch, sourceBranch, noFf) => ipcRenderer.invoke(IPC.GIT_WORKTREE_MERGE, { repoPath, worktreeBranch, sourceBranch, noFf }),
  gitWorktreePush: (worktreePath, sourceBranch) => ipcRenderer.invoke(IPC.GIT_WORKTREE_PUSH, { worktreePath, sourceBranch }),
  gitWorktreeRebase: (worktreePath, sourceBranch) => ipcRenderer.invoke(IPC.GIT_WORKTREE_REBASE, { worktreePath, sourceBranch }),

  // ─── Filesystem operations ───
  fsReadDir: (directory) => ipcRenderer.invoke(IPC.FS_READ_DIR, { directory }),
  fsReadFile: (filePath) => ipcRenderer.invoke(IPC.FS_READ_FILE, { filePath }),
  fsWriteFile: (filePath, content) => ipcRenderer.invoke(IPC.FS_WRITE_FILE, { filePath, content }),
  fsCreateDir: (dirPath) => ipcRenderer.invoke(IPC.FS_CREATE_DIR, { dirPath }),
  fsCreateFile: (filePath) => ipcRenderer.invoke(IPC.FS_CREATE_FILE, { filePath }),
  fsRename: (oldPath, newPath) => ipcRenderer.invoke(IPC.FS_RENAME, { oldPath, newPath }),
  fsDelete: (targetPath) => ipcRenderer.invoke(IPC.FS_DELETE, { targetPath }),
  fsSaveDialog: (defaultPath) => ipcRenderer.invoke(IPC.FS_SAVE_DIALOG, { defaultPath }),
  fsRevealInFinder: (targetPath) => ipcRenderer.invoke(IPC.FS_REVEAL_IN_FINDER, { targetPath }),
  fsOpenNative: (targetPath) => ipcRenderer.invoke(IPC.FS_OPEN_NATIVE, { targetPath }),
  fsExists: (targetPath) => ipcRenderer.invoke(IPC.FS_EXISTS, { targetPath }),
  fsWatchFile: (filePath) => ipcRenderer.invoke(IPC.FS_WATCH_FILE, { filePath }),
  fsUnwatchFile: (filePath) => ipcRenderer.invoke(IPC.FS_UNWATCH_FILE, { filePath }),
  onFileChanged: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, filePath: string) => callback(filePath)
    ipcRenderer.on(IPC.FS_FILE_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.FS_FILE_CHANGED, handler)
  },

  // ─── Engine operations ───
  engineStart: (key, config) => ipcRenderer.invoke(IPC.ENGINE_START, { key, config }),
  engineSetPlanMode: (key, enabled, planFilePath) => ipcRenderer.send('ion:engine-set-plan-mode', key, enabled, planFilePath),
  engineAbort: (key) => ipcRenderer.invoke(IPC.ENGINE_ABORT, { key }),
  engineAbortAgent: (key, agentName, subtree) =>
    ipcRenderer.invoke(IPC.ENGINE_ABORT_AGENT, { key, agentName, subtree }),
  engineDialogResponse: (key, dialogId, value) => ipcRenderer.invoke(IPC.ENGINE_DIALOG_RESPONSE, { key, dialogId, value }),
  engineCommand: (key, command, args) => ipcRenderer.invoke(IPC.ENGINE_COMMAND, { key, command, args }),
  engineStop: (key) => ipcRenderer.invoke(IPC.ENGINE_STOP, { key }),
  engineBranchBefore: (key, entryId) => ipcRenderer.invoke(IPC.ENGINE_BRANCH_BEFORE, { key, entryId }),
  engineRewind: (key, userTurnIndex) => ipcRenderer.invoke(IPC.ENGINE_REWIND, { key, userTurnIndex }),
  engineGetContextBreakdown: (key) => ipcRenderer.invoke(IPC.ENGINE_GET_CONTEXT_BREAKDOWN, { key }),
  engineRemapSession: (oldKey, newKey) => ipcRenderer.invoke(IPC.ENGINE_REMAP_SESSION, { oldKey, newKey }),
  engineBroadcastHistory: (tabId, instanceId) => ipcRenderer.invoke(IPC.ENGINE_BROADCAST_HISTORY, { tabId, instanceId }),
  notifyTabFocus: (tabId, engineProfileId) =>
    ipcRenderer.send(IPC.NOTIFY_TAB_FOCUS, { tabId, engineProfileId: engineProfileId ?? null }),
  markResourceRead: (kind, resourceId) => ipcRenderer.send(IPC.MARK_RESOURCE_READ, { kind, resourceId }),
  getReadResourceIds: () => ipcRenderer.invoke(IPC.GET_READ_RESOURCE_IDS),
  getPersistedResources: () => ipcRenderer.invoke(IPC.GET_PERSISTED_RESOURCES),
  publishResourceDelete: (kind, resourceId) => ipcRenderer.send(IPC.DELETE_RESOURCE, { kind, resourceId }),
  onEngineEvent: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, key: string, event: any) => callback(key, event)
    ipcRenderer.on(IPC.ENGINE_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC.ENGINE_EVENT, handler)
  },

  // ─── Plugin management ───
  pluginInstall: (source) => ipcRenderer.invoke('plugin:install', source),
  pluginList: () => ipcRenderer.invoke('plugin:list'),
  pluginRemove: (name) => ipcRenderer.invoke('plugin:remove', name),

  // ─── Model & provider management ───
  listModels: () => ipcRenderer.invoke(IPC.LIST_MODELS),
  storeCredential: (provider, credential) => ipcRenderer.invoke(IPC.STORE_CREDENTIAL, { provider, credential }),
  refreshModels: (provider) => ipcRenderer.invoke(IPC.REFRESH_MODELS, { provider }),

  // ─── Delegated-CLI provider auth (codex/grok/cursor) ───
  providerLogin: (provider) => ipcRenderer.invoke(IPC.PROVIDER_LOGIN, { provider }),
  providerLoginCancel: (provider) => ipcRenderer.invoke(IPC.PROVIDER_LOGIN_CANCEL, { provider }),
  providerLogout: (provider) => ipcRenderer.invoke(IPC.PROVIDER_LOGOUT, { provider }),
  setProviderBackend: (provider, backend) => ipcRenderer.invoke(IPC.PROVIDER_SET_BACKEND, { provider, backend }),
  onProviderLoginEvent: (handler) => {
    const listener = (_e: unknown, update: import('../shared/types-engine-event').ProviderLoginUpdate) => handler(update)
    ipcRenderer.on(IPC.PROVIDER_LOGIN_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.PROVIDER_LOGIN_EVENT, listener)
  },

  // ─── OAuth ───
  startOAuth: (provider) => ipcRenderer.invoke(IPC.OAUTH_START, { provider }),
  logoutOAuth: (provider) => ipcRenderer.invoke(IPC.OAUTH_LOGOUT, { provider }),
  oauthStatus: (provider) => ipcRenderer.invoke(IPC.OAUTH_STATUS, { provider }),
  oauthDeviceCode: (provider) => ipcRenderer.invoke(IPC.OAUTH_DEVICE_CODE, { provider }),
  oauthDevicePoll: (deviceCode, interval, expiresIn) => ipcRenderer.invoke(IPC.OAUTH_DEVICE_POLL, { deviceCode, interval, expiresIn }),

  // ─── Entra OIDC (Feature 0001 Part F — telemetry auth) ───
  entraSignIn: () => ipcRenderer.invoke(IPC.ENTRA_SIGN_IN),
  entraSignOut: () => ipcRenderer.invoke(IPC.ENTRA_SIGN_OUT),
  entraIdentity: () => ipcRenderer.invoke(IPC.ENTRA_IDENTITY),

  // ─── Remote control ───
  remoteGetState: () => ipcRenderer.invoke(IPC.REMOTE_GET_STATE),
  remoteGetMessages: (tabId) => ipcRenderer.invoke(IPC.REMOTE_GET_MESSAGES, tabId),
  remoteStartPairing: () => ipcRenderer.invoke(IPC.REMOTE_START_PAIRING),
  remoteCancelPairing: () => ipcRenderer.send(IPC.REMOTE_CANCEL_PAIRING),
  remoteRevokeDevice: (deviceId) => ipcRenderer.send(IPC.REMOTE_REVOKE_DEVICE, deviceId),
  remoteDiscoverRelays: () => ipcRenderer.invoke(IPC.REMOTE_DISCOVER_RELAYS),
  remoteStopDiscovery: () => ipcRenderer.send(IPC.REMOTE_STOP_DISCOVERY),
  remoteTestRelay: (url, key) => ipcRenderer.invoke(IPC.REMOTE_TEST_RELAY, url, key),
  remoteSetLanDisabled: (disabled) => ipcRenderer.invoke(IPC.REMOTE_SET_LAN_DISABLED, disabled),
  remoteSetDisplay: (customName, customIcon) => ipcRenderer.invoke(IPC.REMOTE_SET_DISPLAY, customName, customIcon),
  remoteGetDisplay: () => ipcRenderer.invoke('ion:remote-get-display'),

  // ─── Auto-update ───
  installUpdate: () => ipcRenderer.send(IPC.INSTALL_UPDATE),
  onUpdateDownloaded: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, info: { version: string }) => callback(info)
    ipcRenderer.on(IPC.UPDATE_DOWNLOADED, handler)
    return () => ipcRenderer.removeListener(IPC.UPDATE_DOWNLOADED, handler)
  },

  // ─── Renderer logging bridge ───
  logWrite: (level, tag, msg, fields) =>
    ipcRenderer.invoke(IPC.LOG_WRITE, { level, tag, msg, fields: fields ?? {} }),

  on: (channel, callback) => {
    const handler = (_e: Electron.IpcRendererEvent, ...args: any[]) => callback(_e, ...args)
    ipcRenderer.on(channel, handler)
  },
  off: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback)
  },

  // ─── Window management ───
  resizeHeight: (height) => ipcRenderer.send(IPC.RESIZE_HEIGHT, height),
  animateHeight: (from, to, durationMs) =>
    ipcRenderer.invoke(IPC.ANIMATE_HEIGHT, { from, to, durationMs }),
  hideWindow: () => ipcRenderer.send(IPC.HIDE_WINDOW),
  isVisible: () => ipcRenderer.invoke(IPC.IS_VISIBLE),
  setIgnoreMouseEvents: (ignore, options) =>
    ipcRenderer.send(IPC.SET_IGNORE_MOUSE_EVENTS, ignore, options || {}),
  setWindowWidth: (width) => ipcRenderer.send(IPC.SET_WINDOW_WIDTH, width),

  // ─── Event listeners ───
  onEvent: (callback) => {
    const _channels = [
      IPC.TEXT_CHUNK, IPC.TOOL_CALL, IPC.TOOL_CALL_UPDATE,
      IPC.TOOL_CALL_COMPLETE, IPC.TASK_UPDATE, IPC.TASK_COMPLETE,
      IPC.SESSION_DEAD, IPC.SESSION_INIT, IPC.ERROR, IPC.RATE_LIMIT,
    ]
    // Single unified handler — all normalized events come through one channel
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, event: NormalizedEvent) => callback(tabId, event)
    ipcRenderer.on('ion:normalized-event', handler)
    return () => ipcRenderer.removeListener('ion:normalized-event', handler)
  },

  onTabStatusChange: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, newStatus: string, oldStatus: string) =>
      callback(tabId, newStatus, oldStatus)
    ipcRenderer.on('ion:tab-status-change', handler)
    return () => ipcRenderer.removeListener('ion:tab-status-change', handler)
  },

  onError: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, error: EnrichedError) =>
      callback(tabId, error)
    ipcRenderer.on('ion:enriched-error', handler)
    return () => ipcRenderer.removeListener('ion:enriched-error', handler)
  },

  onSkillStatus: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, status: any) => callback(status)
    ipcRenderer.on(IPC.SKILL_STATUS, handler)
    return () => ipcRenderer.removeListener(IPC.SKILL_STATUS, handler)
  },

  onWindowShown: (callback) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.WINDOW_SHOWN, handler)
    return () => ipcRenderer.removeListener(IPC.WINDOW_SHOWN, handler)
  },

  onShowSettings: (callback) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.SHOW_SETTINGS, handler)
    return () => ipcRenderer.removeListener(IPC.SHOW_SETTINGS, handler)
  },
}

contextBridge.exposeInMainWorld('ion', api)
