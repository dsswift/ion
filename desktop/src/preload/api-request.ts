import { ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import type { DeepLinkConfirmRequest, DeepLinkConfirmResult } from '../shared/types'
import type { GitEvent } from '../shared/types'
import type { IonAPI } from './ionapi'

/** Request, session, git, and listener methods exposed to the renderer. */
export const requestApi = {
  startupReport: (report) => ipcRenderer.send(IPC.STARTUP_REPORT, report),
  // ─── Request-response ───
  start: () => ipcRenderer.invoke(IPC.START),
  createTab: () => ipcRenderer.invoke(IPC.CREATE_TAB),
  adoptTab: (tabId: string) => ipcRenderer.invoke(IPC.ADOPT_TAB, tabId),
  prompt: (tabId, requestId, options) => ipcRenderer.invoke(IPC.PROMPT, { tabId, requestId, options }),
  cancel: (requestId) => ipcRenderer.invoke(IPC.CANCEL, requestId),
  steer: (tabId, message, clientMessageId) => ipcRenderer.send(IPC.STEER, { tabId, message, clientMessageId }),
  stopTab: (tabId) => ipcRenderer.invoke(IPC.STOP_TAB, tabId),
  retry: (tabId, requestId, options) => ipcRenderer.invoke(IPC.RETRY, { tabId, requestId, options }),
  status: () => ipcRenderer.invoke(IPC.STATUS),
  tabHealth: () => ipcRenderer.invoke(IPC.TAB_HEALTH),
  closeTab: (tabId) => ipcRenderer.invoke(IPC.CLOSE_TAB, tabId),
  tabMetaChanged: (payload: { tabId: string; title?: string; runCostUsd?: number; totalCostUsd?: number; groupId?: string | null }) =>
    ipcRenderer.send(IPC.TAB_META_CHANGED, payload),
  pushRemoteTabStates: (payload) => ipcRenderer.send(IPC.REMOTE_TAB_STATES_PUSH, payload),
  selectDirectory: () => ipcRenderer.invoke(IPC.SELECT_DIRECTORY),
  selectExtensionFiles: () => ipcRenderer.invoke(IPC.SELECT_EXTENSION_FILES),
  getEngineHostInfo: () => ipcRenderer.invoke(IPC.GET_ENGINE_HOST_INFO),
  listEngineDirectory: (path: string, showHidden: boolean) =>
    ipcRenderer.invoke(IPC.LIST_ENGINE_DIRECTORY, path, showHidden),
  engineIsRemote: () => ipcRenderer.invoke(IPC.ENGINE_IS_REMOTE),
  getEnterprisePolicy: () => ipcRenderer.invoke(IPC.GET_ENTERPRISE_POLICY),
  getEnterprisePolicyFull: () => ipcRenderer.invoke(IPC.GET_ENTERPRISE_POLICY_FULL),
  listCustomThemes: () => ipcRenderer.invoke(IPC.THEMES_LIST_CUSTOM),
  openExternal: (url) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
  getFavicon: (host) => ipcRenderer.invoke(IPC.FAVICON_GET, host),
  automationList: (projectPath) => ipcRenderer.invoke(IPC.AUTOMATION_LIST, projectPath),
  automationSave: (definitions) => ipcRenderer.invoke(IPC.AUTOMATION_SAVE, definitions),
  automationHistory: () => ipcRenderer.invoke(IPC.AUTOMATION_HISTORY),
  automationProjectIds: (projectPath) => ipcRenderer.invoke(IPC.AUTOMATION_PROJECT_IDS, projectPath),
  setProjectAutomationEnabled: (projectPath, id, enabled) =>
    ipcRenderer.invoke(IPC.AUTOMATION_PROJECT_ENABLED, { projectPath, id, enabled }),
  triggerPlanImplemented: (payload) => ipcRenderer.invoke(IPC.AUTOMATION_PLAN_IMPLEMENTED, payload),
  onAutomationEvent: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, event: import('../shared/types-automation').AutomationRuntimeEvent) => callback(event)
    ipcRenderer.on(IPC.AUTOMATION_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC.AUTOMATION_EVENT, handler)
  },
  onAutomationCommand: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, command: { id: string; action: import('../shared/types-automation').AutomationAction }) => callback(command)
    ipcRenderer.on(IPC.AUTOMATION_COMMAND, handler)
    return () => ipcRenderer.removeListener(IPC.AUTOMATION_COMMAND, handler)
  },
  resolveAutomationCommand: (id, result) => ipcRenderer.send(IPC.AUTOMATION_COMMAND_RESULT, { id, ...result }),
  revealPath: (path) => ipcRenderer.invoke(IPC.REVEAL_PATH, path),
  attachFiles: () => ipcRenderer.invoke(IPC.ATTACH_FILES),
  attachFileByPath: (path) => ipcRenderer.invoke(IPC.ATTACH_FILE_BY_PATH, path),
  takeScreenshot: () => ipcRenderer.invoke(IPC.TAKE_SCREENSHOT),
  pasteImage: (dataUrl) => ipcRenderer.invoke(IPC.PASTE_IMAGE, dataUrl),
  transcribeAudio: (audioBase64) => ipcRenderer.invoke(IPC.TRANSCRIBE_AUDIO, audioBase64),
  getDiagnostics: () => ipcRenderer.invoke(IPC.GET_DIAGNOSTICS),
  respondPermission: (tabId, questionId, optionId) =>
    ipcRenderer.invoke(IPC.RESPOND_PERMISSION, { tabId, questionId, optionId }),
  respondElicitation: (tabId, requestId, response, cancelled, declined) =>
    ipcRenderer.invoke(IPC.RESPOND_ELICITATION, { tabId, requestId, response, cancelled, declined }),
  approveDeniedTools: (tabId: string, toolNames: string[]) =>
    ipcRenderer.invoke(IPC.APPROVE_DENIED_TOOLS, { tabId, toolNames }),
  initSession: (tabId) => ipcRenderer.send(IPC.INIT_SESSION, tabId),
  ensureEngineSession: (args) => ipcRenderer.invoke(IPC.ENSURE_ENGINE_SESSION, args),
  resetTabSession: (tabId) => ipcRenderer.send(IPC.RESET_TAB_SESSION, tabId),
  restartTabSession: (tabId: string) => ipcRenderer.send(IPC.RESTART_TAB_SESSION, tabId),
  relocateTabSession: (tabId, workingDirectory) => ipcRenderer.invoke(IPC.RELOCATE_TAB_SESSION, { tabId, workingDirectory }),
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
  terminalAttach: (key, opts) => ipcRenderer.invoke(IPC.TERMINAL_ATTACH, { key, ...opts }),
  getActiveUi: () => ipcRenderer.invoke(IPC.GET_ACTIVE_UI),
  setActiveUi: (ui) => ipcRenderer.invoke(IPC.SET_ACTIVE_UI, ui),
  terminalGetScrollback: (key) => ipcRenderer.invoke(IPC.TERMINAL_GET_SCROLLBACK, { key }),
  terminalActiveTabs: () => ipcRenderer.invoke(IPC.TERMINAL_ACTIVE_TABS),
  onTerminalActivity: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, activity: { key: string; tabId: string; active: boolean }) => callback(activity)
    ipcRenderer.on(IPC.TERMINAL_ACTIVITY, handler)
    return () => ipcRenderer.removeListener(IPC.TERMINAL_ACTIVITY, handler)
  },
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
  // An untrusted ion:// deep link needs the operator's approval before anything
  // runs. Main describes the request; the renderer renders it and answers.
  onDeepLinkConfirmRequest: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, request: DeepLinkConfirmRequest) => callback(request)
    ipcRenderer.on(IPC.DEEPLINK_CONFIRM_REQUEST, handler)
    return () => ipcRenderer.removeListener(IPC.DEEPLINK_CONFIRM_REQUEST, handler)
  },
  onDeepLinkConfirmSettled: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string) => callback(id)
    ipcRenderer.on(IPC.DEEPLINK_CONFIRM_SETTLED, handler)
    return () => ipcRenderer.removeListener(IPC.DEEPLINK_CONFIRM_SETTLED, handler)
  },
  setDeepLinkConfirmAvailability: (owner, available) => ipcRenderer.send(
    available ? IPC.DEEPLINK_CONFIRM_READY : IPC.DEEPLINK_CONFIRM_UNAVAILABLE,
    { owner },
  ),
  resolveDeepLinkConfirm: (result: DeepLinkConfirmResult) => ipcRenderer.send(IPC.DEEPLINK_CONFIRM_RESULT, result),
  // iOS asked to open a worktree / bench conversation. Tab creation lives in
  // the renderer store (it owns panes and titling), so main relays the intent
  // here rather than duplicating that logic.
  onRemoteOpenWorktreeConversation: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: { worktreePath: string; newConversation: boolean },
    ) => callback(arg)
    ipcRenderer.on('ion:remote-open-worktree-conversation', handler)
    return () => ipcRenderer.removeListener('ion:remote-open-worktree-conversation', handler)
  },
  onRemoteRetireWorktree: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: { repoPath: string; worktreePath: string; branchName: string },
    ) => callback(arg)
    ipcRenderer.on('ion:remote-retire-worktree', handler)
    return () => ipcRenderer.removeListener('ion:remote-retire-worktree', handler)
  },
  onRemoteRetireLandedWorktrees: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, arg: { repoPath: string }) => callback(arg)
    ipcRenderer.on('ion:remote-retire-landed-worktrees', handler)
    return () => ipcRenderer.removeListener('ion:remote-retire-landed-worktrees', handler)
  },
  onRemoteOpenBenchConversation: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, arg: { repoPath: string; sourceBranch: string }) => callback(arg)
    ipcRenderer.on('ion:remote-open-bench-conversation', handler)
    return () => ipcRenderer.removeListener('ion:remote-open-bench-conversation', handler)
  },
  onRemoteOpenBenchTerminal: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, arg: { repoPath: string; sourceBranch: string }) => callback(arg)
    ipcRenderer.on('ion:remote-open-bench-terminal', handler)
    return () => ipcRenderer.removeListener('ion:remote-open-bench-terminal', handler)
  },
  onRemoteWorktreeAction: (callback) => {
    const channels = [
      'ion:remote-create-worktree',
      'ion:remote-convert-worktree-conversation',
      'ion:remote-rename-worktree',
      'ion:remote-reprovision-worktree',
      'ion:remote-recover-bench-conflict',
      'ion:remote-analyse-bench-verification',
      'ion:remote-discard-bench-member-recordings',
      'ion:remote-discard-all-bench-recordings',
      'ion:remote-worktree-conflict-assist',
      'ion:remote-bench-conflict-assist',
    ] as const
    const handlers = channels.map((channel) => {
      const handler = (_e: Electron.IpcRendererEvent, arg: Record<string, unknown>) => callback(channel, arg)
      ipcRenderer.on(channel, handler)
      return { channel, handler }
    })
    return () => handlers.forEach(({ channel, handler }) => ipcRenderer.removeListener(channel, handler))
  },
  // iOS drives the sync pipeline remotely: start / confirm-ai / cancel /
  // dismiss ride one channel with a verb so the listener stays a single
  // subscription. The pipeline itself is a renderer-store state machine.
  onRemoteWorktreePipeline: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: { verb: 'start' | 'confirm-ai' | 'cancel' | 'dismiss'; repoPath: string; sourceBranch?: string },
    ) => callback(arg)
    ipcRenderer.on('ion:remote-worktree-pipeline', handler)
    return () => ipcRenderer.removeListener('ion:remote-worktree-pipeline', handler)
  },
  // A worktree earned (or was given) a human title. Both windows listen so the
  // overlay and the Studio mirror rename the row at the same moment.
  onWorktreeTitled: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: { repoPath: string; worktreePath: string; title: string },
    ) => callback(arg)
    ipcRenderer.on('ion:worktree-titled', handler)
    return () => ipcRenderer.removeListener('ion:worktree-titled', handler)
  },
  onWorktreeLanded: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: { repoPath: string; worktreePath: string; prunedBenchPaths: string[] },
    ) => callback(arg)
    ipcRenderer.on('ion:worktree-landed', handler)
    return () => ipcRenderer.removeListener('ion:worktree-landed', handler)
  },
  onWorktreeFreshnessTick: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: { repoPaths: string[] },
    ) => callback(arg)
    ipcRenderer.on(IPC.WORKTREE_FRESHNESS_TICK, handler)
    return () => ipcRenderer.removeListener(IPC.WORKTREE_FRESHNESS_TICK, handler)
  },
  executeBash: (id, command, cwd) => ipcRenderer.invoke(IPC.EXECUTE_BASH, { id, command, cwd }),
  cancelBash: (id) => ipcRenderer.send(IPC.CANCEL_BASH, id),
  sendRemote: (event) => ipcRenderer.send(IPC.REMOTE_SEND, event),
  setPermissionMode: (tabId, mode, source, planFilePath) => ipcRenderer.send(IPC.SET_PERMISSION_MODE, { tabId, mode, source, planFilePath }),
  resolvePermissionDenials: (tabId) => ipcRenderer.send(IPC.RESOLVE_PERMISSION_DENIALS, { tabId }),
  loadSettings: () => ipcRenderer.invoke(IPC.LOAD_SETTINGS),
  saveSettings: (data) => ipcRenderer.invoke(IPC.SAVE_SETTINGS, data),
  loadTabs: () => ipcRenderer.invoke(IPC.LOAD_TABS),
  saveTabs: (data) => ipcRenderer.invoke(IPC.SAVE_TABS, data),
  loadTabContent: (tabId: string) => ipcRenderer.invoke(IPC.LOAD_TAB_CONTENT, tabId),
  saveTabContent: (tabId: string, instanceId: string, messages: unknown[]) =>
    ipcRenderer.invoke(IPC.SAVE_TAB_CONTENT, { tabId, instanceId, messages }),
  deleteTabContent: (tabId: string) => ipcRenderer.invoke(IPC.DELETE_TAB_CONTENT, tabId),
  saveSessionLabel: (sessionId, customTitle) => ipcRenderer.invoke(IPC.SAVE_SESSION_LABEL, { sessionId, customTitle }),
  loadSessionLabels: () => ipcRenderer.invoke(IPC.LOAD_SESSION_LABELS),
  generateTitle: (text) => ipcRenderer.invoke(IPC.GENERATE_TITLE, text),
  loadSessionChains: () => ipcRenderer.invoke(IPC.LOAD_SESSION_CHAINS),
  saveSessionChains: (data) => ipcRenderer.invoke(IPC.SAVE_SESSION_CHAINS, data),
  getConversation: (conversationId: string, offset = 0, limit = 50) =>
    ipcRenderer.invoke(IPC.GET_CONVERSATION, { conversationId, offset, limit }),
  deleteStoredConversations: (sessionIds: string[]) =>
    ipcRenderer.invoke(IPC.DELETE_STORED_CONVERSATIONS, sessionIds),
  loadChainHistory: (sessionIds: string[]) =>
    ipcRenderer.invoke(IPC.LOAD_CHAIN_HISTORY, sessionIds),

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
  gitResolveConflict: (directory: string, path: string, content: string) => ipcRenderer.invoke(IPC.GIT_RESOLVE_CONFLICT, { directory, path, content }),
  gitRebaseTodo: (directory: string, onto: string) => ipcRenderer.invoke(IPC.GIT_REBASE_TODO, { directory, onto }),
  gitRebaseExec: (directory: string, onto: string, commits: Array<{ hash: string; action: string }>) => ipcRenderer.invoke(IPC.GIT_REBASE_EXEC, { directory, onto, commits }),
  gitRebaseAbort: (directory: string) => ipcRenderer.invoke(IPC.GIT_REBASE_ABORT, { directory }),
  gitRebaseContinue: (directory: string) => ipcRenderer.invoke(IPC.GIT_REBASE_CONTINUE, { directory }),
  gitOpState: (directory: string) => ipcRenderer.invoke(IPC.GIT_OP_STATE, { directory }),
  gitConflictStages: (directory: string, path: string) => ipcRenderer.invoke(IPC.GIT_CONFLICT_STAGES, { directory, path }),
  gitConflictAccept: (directory: string, path: string, side: 'ours' | 'theirs') =>
    ipcRenderer.invoke(IPC.GIT_CONFLICT_ACCEPT, { directory, path, side }),
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

} satisfies Partial<IonAPI>
