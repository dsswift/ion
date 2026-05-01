import type { TabState, NormalizedEvent, EnrichedError, Attachment, FileAttachment, TerminalPaneState, EngineInstance, EnginePaneState, AgentStateUpdate, StatusFields, Message } from '../../shared/types'

export interface StaticInfo {
  version: string
  email: string | null
  subscriptionType: string | null
  projectPath: string
  homePath: string
}

export interface FileEditorTab {
  id: string
  filePath: string | null
  fileName: string
  content: string
  savedContent: string
  isDirty: boolean
  isReadOnly: boolean
  isPreview: boolean
}

export interface FileEditorDirState {
  activeFileId: string | null
  files: FileEditorTab[]
}

export interface State {
  tabs: TabState[]
  activeTabId: string
  isExpanded: boolean
  staticInfo: StaticInfo | null
  gitPanelOpen: boolean
  terminalOpenTabIds: Set<string>
  terminalPendingCommands: Map<string, string>
  terminalPanes: Map<string, TerminalPaneState>
  terminalTallTabId: string | null
  terminalBigScreenTabId: string | null
  fileExplorerOpenDirs: Set<string>
  fileExplorerStates: Map<string, { expandedPaths: Set<string>; selectedPath: string | null }>
  fileEditorOpenDirs: Set<string>
  fileEditorFocused: boolean
  fileEditorStates: Map<string, FileEditorDirState>
  editorGeometry: { x: number; y: number; w: number; h: number }
  planGeometry: { x: number; y: number; w: number; h: number }
  tabsReady: boolean
  backend: 'api' | 'cli'
  worktreeUncommittedMap: Map<string, boolean>

  engineAgentStates: Map<string, AgentStateUpdate[]>
  engineStatusFields: Map<string, StatusFields>
  engineWorkingMessages: Map<string, string>
  engineNotifications: Map<string, Array<{ id: string; message: string; level: string; timestamp: number }>>
  engineDialogs: Map<string, { dialogId: string; method: string; title: string; options?: string[]; defaultValue?: string } | null>
  enginePinnedPrompt: Map<string, string>
  engineUsage: Map<string, { percent: number; tokens: number; cost: number }>
  engineConversationIds: Map<string, string[]>
  enginePanes: Map<string, EnginePaneState>
  engineMessages: Map<string, Message[]>

  tallViewTabId: string | null
  scrollToBottomCounter: number
  settingsOpen: boolean

  initStaticInfo: () => Promise<void>
  setPermissionMode: (mode: 'auto' | 'plan', source?: string) => void
  createTab: (useWorktree?: boolean) => Promise<string>
  createTabInDirectory: (dir: string, useWorktree?: boolean, skipDuplicateCheck?: boolean) => Promise<string>
  selectTab: (tabId: string) => void
  closeTab: (tabId: string) => void
  reorderTabs: (reorderedTabs: TabState[]) => void
  renameTab: (tabId: string, customTitle: string | null) => void
  setTabPillColor: (tabId: string, color: string | null) => void
  setTabPillIcon: (tabId: string, icon: string | null) => void
  clearTab: () => void
  toggleExpanded: () => void
  toggleTallView: (tabId: string) => void
  openSettings: () => void
  closeSettings: () => void
  toggleGitPanel: () => void
  closeGitPanel: () => void
  toggleTerminal: (tabId: string) => void
  runInTerminal: (tabId: string, cmd: string) => void
  consumeTerminalPendingCommand: (key: string) => string | undefined
  createTerminalTab: (dir?: string) => Promise<string>
  addTerminalInstance: (tabId: string, kind: string, cwd?: string) => string
  removeTerminalInstance: (tabId: string, instanceId: string) => void
  selectTerminalInstance: (tabId: string, instanceId: string) => void
  toggleTerminalReadOnly: (tabId: string, instanceId: string) => void
  toggleTerminalTall: (tabId: string) => void
  toggleTerminalBigScreen: (tabId: string) => void
  getOrCreateDedicatedTerminal: (tabId: string, kind: string) => string
  runQuickTool: (tabId: string, toolId: string) => void
  renameTerminalInstance: (tabId: string, instanceId: string, label: string) => void
  toggleFileExplorer: (tabId: string) => void
  setFileExplorerExpanded: (dir: string, path: string, expanded: boolean) => void
  setFileExplorerSelected: (dir: string, path: string | null) => void
  collapseAllExplorer: (dir: string) => void
  toggleFileEditor: (tabId: string) => void
  focusFileEditor: () => void
  blurFileEditor: () => void
  openFileInEditor: (dir: string, tabId: string, filePath: string, opts?: { insertAfterActive?: boolean }) => void
  closeFileEditorTab: (dir: string, fileId: string) => void
  setActiveEditorFile: (dir: string, fileId: string) => void
  createScratchFile: (dir: string) => void
  updateEditorContent: (dir: string, fileId: string, content: string) => void
  markEditorSaved: (dir: string, fileId: string, filePath: string) => void
  reorderEditorFiles: (dir: string, reordered: FileEditorTab[]) => void
  toggleEditorPreview: (dir: string, fileId: string) => void
  toggleEditorReadOnly: (dir: string, fileId: string) => void
  setEditorGeometry: (geo: { x: number; y: number; w: number; h: number }) => void
  setPlanGeometry: (geo: { x: number; y: number; w: number; h: number }) => void
  forkTab: (sourceTabId: string) => Promise<string | null>
  rewindToMessage: (tabId: string, messageId: string) => void
  forkFromMessage: (tabId: string, messageId: string) => Promise<string | null>
  resumeSession: (sessionId: string, title?: string, projectPath?: string, customTitle?: string | null, encodedDir?: string | null) => Promise<string>
  resumeSessionWithChain: (sessionId: string, historicalSessionIds: string[], title?: string, projectPath?: string, customTitle?: string | null, encodedDir?: string | null) => Promise<string>
  addSystemMessage: (content: string) => void
  startBashCommand: (command: string, execId: string) => { toolMsgId: string; tabId: string }
  completeBashCommand: (tabId: string, toolMsgId: string, command: string, stdout: string, stderr: string, exitCode: number | null) => void
  sendMessage: (prompt: string, projectPath?: string, extraAttachments?: Attachment[], appendSystemPrompt?: string) => void
  submitRemotePrompt: (tabId: string, prompt: string) => void
  submitRemoteBash: (tabId: string, command: string) => void
  respondPermission: (tabId: string, questionId: string, optionId: string) => void
  addDirectory: (dir: string) => void
  removeDirectory: (dir: string) => void
  setBaseDirectory: (dir: string) => void
  setupWorktree: (tabId: string, sourceBranch: string, setAsDefault: boolean) => Promise<void>
  convertToWorktree: (tabId: string) => Promise<void>
  cancelWorktreeSetup: (tabId: string) => void
  finishWorktreeTab: (tabId: string, strategyOverride?: 'merge' | 'pr') => Promise<void>
  addAttachments: (attachments: FileAttachment[]) => void
  removeAttachment: (attachmentId: string) => void
  clearAttachments: () => void
  editQueuedMessage: (tabId: string) => void
  setDraftInput: (tabId: string, text: string) => void
  clearPendingInput: (tabId: string) => void
  handleNormalizedEvent: (tabId: string, event: NormalizedEvent) => void
  handleStatusChange: (tabId: string, newStatus: string, oldStatus: string) => void
  handleError: (tabId: string, error: EnrichedError) => void
  forceRecoverTab: (tabId: string, reason: string) => void
  moveTabToGroup: (tabId: string, groupId: string) => void
  setTabGroupId: (tabId: string, groupId: string | null) => void
  setWorktreeUncommitted: (tabId: string, hasChanges: boolean) => void
  createEngineTab: (dir?: string, profileId?: string) => string
  handleEngineEvent: (key: string, event: any) => void
  submitEnginePrompt: (tabId: string, text: string) => void
  respondEngineDialog: (tabId: string, dialogId: string, value: any) => void
  addEngineInstance: (tabId: string) => string
  removeEngineInstance: (tabId: string, instanceId: string) => void
  selectEngineInstance: (tabId: string, instanceId: string) => void
  renameEngineInstance: (tabId: string, instanceId: string, label: string) => void
  reorderEngineInstances: (tabId: string, reordered: EngineInstance[]) => void
}

export type StoreSet = (partial: State | Partial<State> | ((state: State) => State | Partial<State>), replace?: false) => void
export type StoreGet = () => State
