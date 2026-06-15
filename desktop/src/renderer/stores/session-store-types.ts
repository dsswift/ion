import type { TabState, NormalizedEvent, EnrichedError, Attachment, FileAttachment, TerminalPaneState, ConversationRef, ConversationPane, ConversationInstance, AgentStateUpdate, StatusFields, Message, ImageAttachmentPayload } from '../../shared/types'
import type { ResourceItem } from '../../shared/types-engine'

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
  briefingGeometry: { x: number; y: number; w: number; h: number }
  agentDetailGeometry: { x: number; y: number; w: number; h: number }
  tabsReady: boolean
  initProgress: string | null
  backend: 'api' | 'cli'
  worktreeUncommittedMap: Map<string, boolean>

  engineWorkingMessages: Map<string, string>
  engineNotifications: Map<string, Array<{ id: string; message: string; level: string; timestamp: number }>>
  engineDialogs: Map<string, { dialogId: string; method: string; title: string; options?: string[]; defaultValue?: string } | null>
  enginePinnedPrompt: Map<string, string>
  engineUsage: Map<string, { percent: number; tokens: number; cost: number }>
  conversationPanes: Map<string, ConversationPane>
  /**
   * Pending model-fallback notice per engine instance, keyed by the
   * compound `${tabId}:${instanceId}` key. Populated when the engine
   * emits a `model_fallback` NormalizedEvent — typically because a
   * dispatched agent requested an unconfigured tier alias and the
   * runloop swapped to the engine's configured `defaultModel`.
   *
   * This client's policy: display a small ⚠ glyph on the affected
   * EngineTabStrip pill with a tooltip naming the requested and
   * fallback models. Clear on the next `task_complete` for that
   * instance (no wall-clock timer — clients don't invent retention
   * rules per `docs/architecture/agent-state.md`).
   *
   * The engine event is workflow, not state — it fires once at the
   * swap site and is not retained in any snapshot. Persisting the
   * fact in renderer state turns it into a sticky-until-cleared UI
   * indicator. See CLAUDE.md § "The typed-event corollary".
   */
  engineModelFallbacks: Map<string, { requestedModel: string; fallbackModel: string; reason: string; at: number }>

  /**
   * Resource subsystem state (D-007). Resources keyed by kind — each entry
   * is the full item collection for that kind, replaced on snapshot and
   * incrementally updated by deltas from the engine resource broker.
   */
  resources: Record<string, ResourceItem[]>
  /** Active resource subscription IDs keyed by kind. Used for unsubscribe. */
  resourceSubscriptions: Record<string, string>
  /** IDs of resources the user has opened/viewed. Client-local read tracking. */
  readResourceIds: Set<string>

  tallViewTabId: string | null
  scrollToBottomCounter: number
  settingsOpen: boolean
  settingsInitialTab: string | null

  initStaticInfo: () => Promise<void>
  setPermissionMode: (mode: 'auto' | 'plan', source?: string) => void
  createTab: (useWorktree?: boolean) => Promise<string>
  createTabInDirectory: (dir: string, useWorktree?: boolean, skipDuplicateCheck?: boolean, pinToGroupId?: string) => Promise<string>
  selectTab: (tabId: string) => void
  closeTab: (tabId: string) => void
  reorderTabs: (reorderedTabs: TabState[]) => void
  renameTab: (tabId: string, customTitle: string | null) => void
  setTabModel: (tabId: string, model: string) => void
  setTabPillColor: (tabId: string, color: string | null) => void
  setTabPillIcon: (tabId: string, icon: string | null) => void
  clearTab: () => void
  toggleExpanded: () => void
  toggleTallView: (tabId: string) => void
  openSettings: (initialTab?: string) => void
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
  setBriefingGeometry: (geo: { x: number; y: number; w: number; h: number }) => void
  setAgentDetailGeometry: (geo: { x: number; y: number; w: number; h: number }) => void
  forkTab: (sourceTabId: string) => Promise<string | null>
  rewindToMessage: (tabId: string, messageId: string) => void
  forkFromMessage: (tabId: string, messageId: string) => Promise<string | null>
  resumeSession: (sessionId: string, title?: string, projectPath?: string, customTitle?: string | null, encodedDir?: string | null) => Promise<string>
  resumeSessionWithChain: (sessionId: string, historicalSessionIds: string[], title?: string, projectPath?: string, customTitle?: string | null, encodedDir?: string | null) => Promise<string>
  /** Load messages for a skeleton tab (messages: null) on demand. Called by selectTab. */
  loadSkeletonMessages: (tabId: string) => Promise<void>
  addSystemMessage: (content: string) => void
  startBashCommand: (command: string, execId: string) => { toolMsgId: string; tabId: string }
  completeBashCommand: (tabId: string, toolMsgId: string, command: string, stdout: string, stderr: string, exitCode: number | null) => void
  sendMessage: (prompt: string, projectPath?: string, extraAttachments?: Attachment[], appendSystemPrompt?: string, implementationPhase?: boolean) => void
  submitRemotePrompt: (tabId: string, prompt: string, imageAttachments?: ImageAttachmentPayload[]) => void
  submitRemoteBash: (tabId: string, command: string) => void
  respondPermission: (tabId: string, questionId: string, optionId: string) => void
  addDirectory: (dir: string) => void
  removeDirectory: (dir: string) => void
  setBaseDirectory: (dir: string) => void
  setupWorktree: (tabId: string, sourceBranch: string, setAsDefault: boolean) => Promise<void>
  convertToWorktree: (tabId: string) => Promise<void>
  cancelWorktreeSetup: (tabId: string) => void
  finishWorktreeTab: (tabId: string, strategyOverride?: 'merge-ff' | 'merge' | 'pr') => Promise<void>
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
  moveTabToGroupAndPin: (tabId: string, groupId: string) => void
  setTabGroupId: (tabId: string, groupId: string | null) => void
  toggleTabGroupPin: (tabId: string) => void
  setWorktreeUncommitted: (tabId: string, hasChanges: boolean) => void
  createEngineTab: (dir?: string, profileId?: string) => string
  handleEngineEvent: (key: string, event: any) => void
  submitEnginePrompt: (tabId: string, text: string, appendSystemPrompt?: string, imageAttachments?: ImageAttachmentPayload[], rawAttachments?: FileAttachment[], implementationPhase?: boolean) => void
  respondEngineDialog: (tabId: string, dialogId: string, value: any) => void
  addEngineInstance: (tabId: string) => string
  removeEngineInstance: (tabId: string, instanceId: string) => void
  /**
   * Reset an engine instance's conversation to a fresh state without
   * removing the instance itself. Wipes the per-instance message
   * buffer, status, agent-state, working message, notifications,
   * dialogs, usage, permission-denied, pinned prompt, and model-override
   * Maps. Seeds a fresh "Session started" divider into engineMessages.
   * Used by the iOS "Implement, clear context" flow for engine tabs —
   * the engine-instance equivalent of resetTabSession on the CLI plane.
   */
  resetEngineInstance: (tabId: string, instanceId: string) => void
  /**
   * Rewind an engine instance to a previous user message. Truncates messages
   * to before the target, tears down the running session, and pre-fills the
   * input bar with the target message's text. Prior conversation context is
   * injected as a system prompt on the next send (one-shot).
   */
  rewindEngineInstance: (tabId: string, instanceId: string, messageId: string, userTurnIndex?: number) => void
  selectEngineInstance: (tabId: string, instanceId: string) => void
  renameEngineInstance: (tabId: string, instanceId: string, label: string) => void
  reorderEngineInstances: (tabId: string, reordered: Array<ConversationRef & ConversationInstance>) => void
  moveEngineInstance: (sourceTabId: string, instanceId: string, targetTabId: string) => void
  setEngineModel: (tabId: string, modelId: string) => void
  addEngineSystemMessage: (key: string, content: string) => void
  setEngineDraftInput: (key: string, text: string) => void
  markResourceRead: (resourceId: string) => void
  deleteResource: (kind: string, resourceId: string) => void
}

export type StoreSet = (partial: State | Partial<State> | ((state: State) => State | Partial<State>), replace?: false) => void
export type StoreGet = () => State
