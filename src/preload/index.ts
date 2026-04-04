import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import type { RunOptions, NormalizedEvent, HealthReport, EnrichedError, FileAttachment, SessionMeta, CatalogPlugin, SessionLoadMessage, GitGraphData, GitChangesData, GitBranchInfo, GitCommitDetail, PersistedTabState, FsEntry, WorktreeInfo, WorktreeStatus } from '../shared/types'
import type { DiscoveredCommand } from '../main/claude/command-discovery'

export interface CodaAPI {
  // ─── Request-response (renderer → main) ───
  start(): Promise<{ version: string; auth: { email?: string; subscriptionType?: string; authMethod?: string }; mcpServers: string[]; projectPath: string; homePath: string }>
  createTab(): Promise<{ tabId: string }>
  prompt(tabId: string, requestId: string, options: RunOptions): Promise<void>
  cancel(requestId: string): Promise<boolean>
  stopTab(tabId: string): Promise<boolean>
  retry(tabId: string, requestId: string, options: RunOptions): Promise<void>
  status(): Promise<HealthReport>
  tabHealth(): Promise<HealthReport>
  closeTab(tabId: string): Promise<void>
  selectDirectory(): Promise<string | null>
  openExternal(url: string): Promise<boolean>
  openInTerminal(sessionId: string | null, projectPath?: string, claudeCommand?: string): Promise<boolean>
  openInVSCode(projectPath: string): Promise<boolean>
  attachFiles(): Promise<FileAttachment[] | null>
  attachFileByPath(path: string): Promise<FileAttachment | null>
  takeScreenshot(): Promise<FileAttachment | null>
  pasteImage(dataUrl: string): Promise<FileAttachment | null>
  transcribeAudio(audioBase64: string): Promise<{ error: string | null; transcript: string | null }>
  getDiagnostics(): Promise<any>
  respondPermission(tabId: string, questionId: string, optionId: string): Promise<boolean>
  initSession(tabId: string): void
  resetTabSession(tabId: string): void
  listSessions(projectPath?: string): Promise<SessionMeta[]>
  listAllSessions(): Promise<SessionMeta[]>
  loadSession(sessionId: string, projectPath?: string, encodedDir?: string): Promise<SessionLoadMessage[]>
  readPlan(filePath: string): Promise<{ content: string | null; fileName: string | null }>
  discoverCommands(projectPath: string): Promise<DiscoveredCommand[]>
  fetchMarketplace(forceRefresh?: boolean): Promise<{ plugins: CatalogPlugin[]; error: string | null }>
  listInstalledPlugins(): Promise<string[]>
  installPlugin(repo: string, pluginName: string, marketplace: string, sourcePath?: string, isSkillMd?: boolean): Promise<{ ok: boolean; error?: string }>
  uninstallPlugin(pluginName: string): Promise<{ ok: boolean; error?: string }>
  listFonts(): Promise<string[]>
  terminalCreate(key: string, cwd: string): Promise<void>
  terminalWrite(key: string, data: string): void
  terminalResize(key: string, cols: number, rows: number): void
  terminalDestroy(key: string): Promise<void>
  onTerminalData(callback: (key: string, data: string) => void): () => void
  onTerminalExit(callback: (key: string, exitCode: number) => void): () => void
  executeBash(id: string, command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }>
  cancelBash(id: string): void
  sendRemote(event: any): void
  setPermissionMode(tabId: string, mode: string): void
  getTheme(): Promise<{ isDark: boolean }>
  onThemeChange(callback: (isDark: boolean) => void): () => void
  loadSettings(): Promise<Record<string, any>>
  saveSettings(data: Record<string, any>): Promise<void>
  loadTabs(): Promise<PersistedTabState | null>
  saveTabs(data: PersistedTabState): Promise<void>
  saveSessionLabel(sessionId: string, customTitle: string | null): Promise<void>
  loadSessionLabels(): Promise<Record<string, string>>
  loadSessionChains(): Promise<{ chains: Record<string, string[]>; reverse: Record<string, string> }>
  saveSessionChains(data: { chains: Record<string, string[]>; reverse: Record<string, string> }): Promise<void>

  // ─── Git operations ───
  gitIsRepo(directory: string): Promise<{ isRepo: boolean }>
  gitGraph(directory: string, skip?: number, limit?: number): Promise<GitGraphData>
  gitChanges(directory: string): Promise<GitChangesData>
  gitCommit(directory: string, message: string): Promise<{ ok: boolean; error?: string }>
  gitFetch(directory: string): Promise<{ ok: boolean; error?: string }>
  gitPull(directory: string): Promise<{ ok: boolean; error?: string }>
  gitPush(directory: string): Promise<{ ok: boolean; error?: string }>
  gitBranches(directory: string): Promise<{ branches: GitBranchInfo[]; current: string }>
  gitCheckout(directory: string, branch: string): Promise<{ ok: boolean; error?: string }>
  gitCreateBranch(directory: string, name: string): Promise<{ ok: boolean; error?: string }>
  gitDiff(directory: string, path: string, staged: boolean): Promise<{ diff: string; fileName: string }>
  gitStage(directory: string, paths: string[]): Promise<{ ok: boolean; error?: string }>
  gitUnstage(directory: string, paths: string[]): Promise<{ ok: boolean; error?: string }>
  gitDiscard(directory: string, paths: string[]): Promise<{ ok: boolean; error?: string }>
  gitDeleteBranch(directory: string, branch: string): Promise<{ ok: boolean; error?: string }>
  gitCommitDetail(directory: string, hash: string): Promise<GitCommitDetail>
  gitCommitFiles(directory: string, hash: string): Promise<{ files: Array<{ path: string; status: string; oldPath?: string }> }>
  gitCommitFileDiff(directory: string, hash: string, path: string): Promise<{ diff: string; fileName: string }>
  gitIgnoredFiles(directory: string): Promise<{ paths: string[] }>

  // ─── Git worktree operations ───
  gitWorktreeAdd(repoPath: string, sourceBranch: string): Promise<{ ok: boolean; worktree?: WorktreeInfo; error?: string }>
  gitWorktreeRemove(repoPath: string, worktreePath: string, branchName: string, force?: boolean): Promise<{ ok: boolean; error?: string }>
  gitWorktreeList(repoPath: string): Promise<{ worktrees: Array<{ path: string; branch: string; head: string }> }>
  gitWorktreeStatus(worktreePath: string, sourceBranch: string): Promise<WorktreeStatus>
  gitWorktreeMerge(repoPath: string, worktreeBranch: string, sourceBranch: string): Promise<{ ok: boolean; error?: string; hasConflicts?: boolean }>
  gitWorktreePush(worktreePath: string, sourceBranch: string): Promise<{ ok: boolean; error?: string; remoteBranch?: string; remoteUrl?: string }>
  gitWorktreeRebase(worktreePath: string, sourceBranch: string): Promise<{ ok: boolean; error?: string; hasConflicts?: boolean }>

  // ─── Filesystem operations ───
  fsReadDir(directory: string): Promise<{ entries: FsEntry[]; error?: string }>
  fsReadFile(filePath: string): Promise<{ content: string | null; error?: string }>
  fsWriteFile(filePath: string, content: string): Promise<{ ok: boolean; error?: string }>
  fsCreateDir(dirPath: string): Promise<{ ok: boolean; error?: string }>
  fsCreateFile(filePath: string): Promise<{ ok: boolean; error?: string }>
  fsRename(oldPath: string, newPath: string): Promise<{ ok: boolean; error?: string }>
  fsDelete(targetPath: string): Promise<{ ok: boolean; error?: string }>
  fsSaveDialog(defaultPath?: string): Promise<{ filePath: string | null }>
  fsRevealInFinder(targetPath: string): Promise<void>
  fsOpenNative(targetPath: string): Promise<{ ok: boolean; error?: string }>
  fsWatchFile(filePath: string): Promise<{ ok: boolean; error?: string }>
  fsUnwatchFile(filePath: string): Promise<{ ok: boolean; error?: string }>
  onFileChanged(callback: (filePath: string) => void): () => void

  // ─── Remote control ───
  remoteGetState(): Promise<{ transportState: string } | null>
  remoteGetMessages(tabId: string): Promise<any[]>
  remoteStartPairing(): Promise<string | null>
  remoteCancelPairing(): void
  remoteRevokeDevice(deviceId: string): void
  remoteDiscoverRelays(): Promise<Array<{ id: string; name: string; host: string; port: number; addresses: string[] }>>
  remoteStopDiscovery(): void
  remoteTestRelay(relayUrl: string, relayApiKey: string): Promise<{ success: boolean; error?: string }>
  remoteSetLanDisabled(disabled: boolean): Promise<void>
  on(channel: string, callback: (...args: any[]) => void): void
  off(channel: string, callback: (...args: any[]) => void): void

  // ─── Window management ───
  resizeHeight(height: number): void
  setWindowWidth(width: number): void
  animateHeight(from: number, to: number, durationMs: number): Promise<void>
  hideWindow(): void
  isVisible(): Promise<boolean>
  /** OS-level click-through for transparent window regions */
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void

  // ─── Event listeners (main → renderer) ───
  onEvent(callback: (tabId: string, event: NormalizedEvent) => void): () => void
  onTabStatusChange(callback: (tabId: string, newStatus: string, oldStatus: string) => void): () => void
  onError(callback: (tabId: string, error: EnrichedError) => void): () => void
  onSkillStatus(callback: (status: { name: string; state: string; error?: string; reason?: string }) => void): () => void
  onWindowShown(callback: () => void): () => void
  onShowSettings(callback: () => void): () => void
}

const api: CodaAPI = {
  // ─── Request-response ───
  start: () => ipcRenderer.invoke(IPC.START),
  createTab: () => ipcRenderer.invoke(IPC.CREATE_TAB),
  prompt: (tabId, requestId, options) => ipcRenderer.invoke(IPC.PROMPT, { tabId, requestId, options }),
  cancel: (requestId) => ipcRenderer.invoke(IPC.CANCEL, requestId),
  stopTab: (tabId) => ipcRenderer.invoke(IPC.STOP_TAB, tabId),
  retry: (tabId, requestId, options) => ipcRenderer.invoke(IPC.RETRY, { tabId, requestId, options }),
  status: () => ipcRenderer.invoke(IPC.STATUS),
  tabHealth: () => ipcRenderer.invoke(IPC.TAB_HEALTH),
  closeTab: (tabId) => ipcRenderer.invoke(IPC.CLOSE_TAB, tabId),
  selectDirectory: () => ipcRenderer.invoke(IPC.SELECT_DIRECTORY),
  openExternal: (url) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
  openInTerminal: (sessionId, projectPath, claudeCommand) => ipcRenderer.invoke(IPC.OPEN_IN_TERMINAL, { sessionId, projectPath, claudeCommand }),
  openInVSCode: (projectPath) => ipcRenderer.invoke(IPC.OPEN_IN_VSCODE, projectPath),
  attachFiles: () => ipcRenderer.invoke(IPC.ATTACH_FILES),
  attachFileByPath: (path) => ipcRenderer.invoke(IPC.ATTACH_FILE_BY_PATH, path),
  takeScreenshot: () => ipcRenderer.invoke(IPC.TAKE_SCREENSHOT),
  pasteImage: (dataUrl) => ipcRenderer.invoke(IPC.PASTE_IMAGE, dataUrl),
  transcribeAudio: (audioBase64) => ipcRenderer.invoke(IPC.TRANSCRIBE_AUDIO, audioBase64),
  getDiagnostics: () => ipcRenderer.invoke(IPC.GET_DIAGNOSTICS),
  respondPermission: (tabId, questionId, optionId) =>
    ipcRenderer.invoke(IPC.RESPOND_PERMISSION, { tabId, questionId, optionId }),
  approveDeniedTools: (tabId: string, toolNames: string[]) =>
    ipcRenderer.invoke(IPC.APPROVE_DENIED_TOOLS, { tabId, toolNames }),
  initSession: (tabId) => ipcRenderer.send(IPC.INIT_SESSION, tabId),
  resetTabSession: (tabId) => ipcRenderer.send(IPC.RESET_TAB_SESSION, tabId),
  listSessions: (projectPath?: string) => ipcRenderer.invoke(IPC.LIST_SESSIONS, projectPath),
  listAllSessions: () => ipcRenderer.invoke(IPC.LIST_ALL_SESSIONS),
  loadSession: (sessionId: string, projectPath?: string, encodedDir?: string) => ipcRenderer.invoke(IPC.LOAD_SESSION, { sessionId, projectPath, encodedDir }),
  readPlan: (filePath: string) => ipcRenderer.invoke(IPC.READ_PLAN, filePath),
  discoverCommands: (projectPath: string) => ipcRenderer.invoke(IPC.DISCOVER_COMMANDS, projectPath),
  fetchMarketplace: (forceRefresh) => ipcRenderer.invoke(IPC.MARKETPLACE_FETCH, { forceRefresh }),
  listInstalledPlugins: () => ipcRenderer.invoke(IPC.MARKETPLACE_INSTALLED),
  installPlugin: (repo, pluginName, marketplace, sourcePath, isSkillMd) =>
    ipcRenderer.invoke(IPC.MARKETPLACE_INSTALL, { repo, pluginName, marketplace, sourcePath, isSkillMd }),
  uninstallPlugin: (pluginName) =>
    ipcRenderer.invoke(IPC.MARKETPLACE_UNINSTALL, { pluginName }),
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
  setPermissionMode: (tabId, mode) => ipcRenderer.send(IPC.SET_PERMISSION_MODE, { tabId, mode }),
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
  loadSessionChains: () => ipcRenderer.invoke(IPC.LOAD_SESSION_CHAINS),
  saveSessionChains: (data) => ipcRenderer.invoke(IPC.SAVE_SESSION_CHAINS, data),

  // ─── Git operations ───
  gitIsRepo: (directory) => ipcRenderer.invoke(IPC.GIT_IS_REPO, directory),
  gitGraph: (directory, skip, limit) => ipcRenderer.invoke(IPC.GIT_GRAPH, { directory, skip, limit }),
  gitChanges: (directory) => ipcRenderer.invoke(IPC.GIT_CHANGES, { directory }),
  gitCommit: (directory, message) => ipcRenderer.invoke(IPC.GIT_COMMIT, { directory, message }),
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

  // ─── Git worktree operations ───
  gitWorktreeAdd: (repoPath, sourceBranch) => ipcRenderer.invoke(IPC.GIT_WORKTREE_ADD, { repoPath, sourceBranch }),
  gitWorktreeRemove: (repoPath, worktreePath, branchName, force) => ipcRenderer.invoke(IPC.GIT_WORKTREE_REMOVE, { repoPath, worktreePath, branchName, force }),
  gitWorktreeList: (repoPath) => ipcRenderer.invoke(IPC.GIT_WORKTREE_LIST, { repoPath }),
  gitWorktreeStatus: (worktreePath, sourceBranch) => ipcRenderer.invoke(IPC.GIT_WORKTREE_STATUS, { worktreePath, sourceBranch }),
  gitWorktreeMerge: (repoPath, worktreeBranch, sourceBranch) => ipcRenderer.invoke(IPC.GIT_WORKTREE_MERGE, { repoPath, worktreeBranch, sourceBranch }),
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
  fsWatchFile: (filePath) => ipcRenderer.invoke(IPC.FS_WATCH_FILE, { filePath }),
  fsUnwatchFile: (filePath) => ipcRenderer.invoke(IPC.FS_UNWATCH_FILE, { filePath }),
  onFileChanged: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, filePath: string) => callback(filePath)
    ipcRenderer.on(IPC.FS_FILE_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.FS_FILE_CHANGED, handler)
  },

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
    const channels = [
      IPC.TEXT_CHUNK, IPC.TOOL_CALL, IPC.TOOL_CALL_UPDATE,
      IPC.TOOL_CALL_COMPLETE, IPC.TASK_UPDATE, IPC.TASK_COMPLETE,
      IPC.SESSION_DEAD, IPC.SESSION_INIT, IPC.ERROR, IPC.RATE_LIMIT,
    ]
    // Single unified handler — all normalized events come through one channel
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, event: NormalizedEvent) => callback(tabId, event)
    ipcRenderer.on('coda:normalized-event', handler)
    return () => ipcRenderer.removeListener('coda:normalized-event', handler)
  },

  onTabStatusChange: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, newStatus: string, oldStatus: string) =>
      callback(tabId, newStatus, oldStatus)
    ipcRenderer.on('coda:tab-status-change', handler)
    return () => ipcRenderer.removeListener('coda:tab-status-change', handler)
  },

  onError: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, error: EnrichedError) =>
      callback(tabId, error)
    ipcRenderer.on('coda:enriched-error', handler)
    return () => ipcRenderer.removeListener('coda:enriched-error', handler)
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

contextBridge.exposeInMainWorld('coda', api)
