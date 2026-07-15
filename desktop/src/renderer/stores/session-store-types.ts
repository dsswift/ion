import type { TabState, NormalizedEvent, EnrichedError, Attachment, FileAttachment, TerminalPaneState, ConversationPane, ImageAttachmentPayload } from '../../shared/types'
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
  /**
   * Whether the Status Drawer (right-side panel) is open. Toggled by the ⓘ
   * button in StatusBar's right cluster. When open alongside other panels
   * (git, file explorer) the Status Drawer renders at a higher z-index and
   * coexists — they are not mutually exclusive.
   */
  statusDrawerOpen: boolean
  /**
   * When set, the Status Drawer opens the AgentDetailPanel for this
   * dispatch ID on mount, reconstructing the breadcrumb stack by walking
   * dispatchParentId up through durable agentStates. Cleared when the
   * Status Drawer is closed or the panel navigates away.
   */
  statusDrawerDispatchId: string | null
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
  resourceViewerGeometry: { x: number; y: number; w: number; h: number }
  agentDetailGeometry: { x: number; y: number; w: number; h: number }
  tabsReady: boolean
  /** True while useTabRestoration's restore loop is running. The persist subscriber
   * skips saves during this window to avoid the ~25 GUARD rejections that occur when
   * each per-tab setState triggers a partial-state save before all tabs are loaded.
   * Cleared after tabsReady=true. */
  rehydrating: boolean
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
   * Pending model-fallback notice per engine tab, keyed by the bare tabId
   * (after session-key unification, #256 — one fallback slot per tab).
   * Populated when the engine emits a `model_fallback` NormalizedEvent —
   * typically because a dispatched agent requested an unconfigured tier alias
   * and the runloop swapped to the engine's configured `defaultModel`.
   *
   * This client's policy: display a small ⚠ glyph on the affected
   * tab pill (TabStripTabPill) with a tooltip naming the requested and
   * fallback models. Clear on the next `task_complete` for that
   * tab (no wall-clock timer — clients don't invent retention
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

  /**
   * Live dispatched-agent transcript, keyed by dispatchAgentId (NOT
   * conversationId). Folded incrementally from `dispatch_activity` push deltas
   * (the agent popup's real-time stream). Keyed by dispatchAgentId because a
   * re-dispatched agent reuses the same child conversationId while each dispatch
   * gets a unique dispatchAgentId — convId-keying causes the two dispatch
   * buffers to collide. The agent popup reconciles this with the file-backed
   * snapshot via reconcileActivity (agent-dispatch-activity.ts). Append-only per
   * dispatch while it runs; cleared lazily by the popup on a fresh reconcile.
   * See agent-dispatch-activity.ts for the fold/reconcile contract.
   */
  dispatchActivity: Record<string, import('../../shared/types').Message[]>

  tallViewTabId: string | null
  /**
   * When the terminal opens on a tab that was in conversation-tall mode, we
   * auto-suspend tall so the terminal panel mounts. This marker records which
   * tab triggered the suspend so we can restore tall when the terminal closes.
   * Cleared on manual toggleTallView, toggleTerminalTall, or tab close.
   */
  suspendedTallTabId: string | null
  scrollToBottomCounter: number
  settingsOpen: boolean
  settingsInitialTab: string | null
  /** Number of FloatingPanel instances currently mounted. Used by isPreviewZoomTarget(). */
  openFloatingPanelCount: number

  initStaticInfo: () => Promise<void>
  setPermissionMode: (mode: 'auto' | 'plan', source?: string) => void
  /**
   * The single plan-approval → implementation pipeline (implement-slice.ts):
   * optional unpin, denial-card dismissal, implement divider, per-tab mode
   * flip to 'auto', model split switch, in-progress auto-move, plan read,
   * prompt submit. Owner-executed everywhere — the ATV mirror forwards it.
   */
  implementPlan: (tabId: string, opts?: { clearContext?: boolean; unpin?: boolean }) => Promise<void>
  /**
   * Set the per-conversation extended-thinking effort for the active
   * conversation. Isolated per-tab (bare) and per-instance (engine subtab),
   * exactly like setPermissionMode. Applied live on the next prompt — no
   * session restart. 'off' clears thinking for the conversation.
   */
  setThinkingEffort: (effort: import('../../shared/types-session').ThinkingEffort) => void
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
  /** Increment the open floating panel count (call on FloatingPanel mount). */
  incOpenFloatingPanelCount: () => void
  /** Decrement the open floating panel count (call on FloatingPanel unmount). */
  decOpenFloatingPanelCount: () => void
  toggleGitPanel: () => void
  closeGitPanel: () => void
  /** Toggle the Status Drawer (the ⓘ right-side panel). */
  toggleStatusDrawer: () => void
  /** Close the Status Drawer and clear the pending dispatch deep-link. */
  closeStatusDrawer: () => void
  /**
   * Open the Status Drawer and pre-select a specific dispatch for deep-link
   * navigation. The drawer reconstructs the ancestor breadcrumb stack from
   * durable agentStates (dispatchParentId walk) before presenting the panel.
   */
  openDispatchPreview: (dispatchId: string) => void
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
  setResourceViewerGeometry: (geo: { x: number; y: number; w: number; h: number }) => void
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
  /**
   * Unified prompt submit for every conversation tab (plain or extension-backed).
   * The single send path — `submitEnginePrompt` is gone. An extension-backed tab
   * resolves a non-empty `extensions` list from its profile (which the main
   * pipeline routes on and which starts the engine session with those
   * extensions); a plain tab resolves none. Everything else is identical.
   */
  submit: (tabId: string, text: string, opts?: {
    projectPath?: string
    extraAttachments?: Attachment[]
    appendSystemPrompt?: string
    implementationPhase?: boolean
    imageAttachments?: ImageAttachmentPayload[]
    source?: 'remote'
    resolveSlash?: boolean
  }) => void
  submitRemotePrompt: (tabId: string, prompt: string, imageAttachments?: ImageAttachmentPayload[], resolveSlash?: boolean) => void
  /**
   * Move a tab to its planning/in-progress group on send, based on the tab's
   * AUTHORITATIVE permission mode (effectivePermissionMode — reads the active
   * instance for every tab type; tab-level permissionMode was removed in WI-002).
   * Shared by sendMessage, submitRemotePrompt, and
   * submit so all send paths (CLI + engine) move consistently.
   * No-op unless autoGroupMovement is on, tabGroupMode is 'manual', and the tab
   * is unpinned. Also cancels any pending done-move for the tab.
   */
  applySendAutoGroupMove: (tabId: string) => void
  /**
   * Unified interrupt for every conversation tab (plain or extension-backed).
   * Aborts the run, reaps the dispatched-agent subtree when there are running
   * children, cancels an in-flight user bash command when one is executing, and
   * arms a 5s force-recover fallback. All three actions are data-conditioned;
   * there is no engine-vs-plain abort fork. Replaces EngineView.handleAbort and
   * ConversationView's inline interrupt handler.
   */
  interrupt: (tabId: string) => void
  submitRemoteBash: (tabId: string, command: string) => void
  respondPermission: (tabId: string, questionId: string, optionId: string) => void
  respondElicitation: (tabId: string, requestId: string, response: Record<string, unknown> | undefined, cancelled: boolean) => void
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
  /**
   * Auto-recover a stalled tab WITHOUT user involvement: recreate the engine
   * session in-process (resetTabSession → next prompt re-StartSessions) and
   * resubmit the last user prompt, so a tab the user left running keeps
   * running. Bounded by autoRecoveryAttempts within a rolling window — once the
   * cap is hit it falls back to forceRecoverTab with an honest message. This is
   * the watchdog path; it is distinct from forceRecoverTab (the user-interrupt
   * fallback, which intentionally abandons the run because the user asked to
   * stop). Returns true if an auto-resume was attempted, false if it fell back.
   */
  autoRecoverStuckTab: (tabId: string) => boolean
  moveTabToGroup: (tabId: string, groupId: string) => void
  moveTabToGroupAndPin: (tabId: string, groupId: string) => void
  setTabGroupId: (tabId: string, groupId: string | null) => void
  toggleTabGroupPin: (tabId: string) => void
  setWorktreeUncommitted: (tabId: string, hasChanges: boolean) => void
  /**
   * Unified tab + engine-instance creation entry point (Phase 2, #256).
   * Both plain and engine tabs are created through this path. The extension
   * list (resolved from opts.profileId if absent) is the only variable:
   *   - non-empty extensions => engine tab (tabHasExtensions=true)
   *   - absent/empty          => plain tab (tabHasExtensions=false)
   * Returns the new tab id (async: obtains a real engine-backed id from main).
   */
  createConversationTab: (dir: string, opts?: import('./slices/engine-slice-create').CreateConversationTabOpts) => Promise<string>
  respondEngineDialog: (tabId: string, dialogId: string, value: any) => void
  /**
   * Create the single engine instance for a tab (single-instance-per-tab
   * model, conversation unification #256 phase 1). Returns the existing
   * instance id if one already exists (no-op guard).
   */
  addEngineInstance: (tabId: string) => string
  /**
   * Reset an engine instance's conversation to a fresh state without
   * removing the instance itself. Wipes the per-instance message
   * buffer, status, agent-state, working message, notifications,
   * dialogs, usage, permission-denied, pinned prompt, and model-override
   * Maps. Seeds a fresh "Session started" divider. Used by the iOS
   * "Implement, clear context" flow for engine tabs.
   */
  resetEngineInstance: (tabId: string, instanceId: string) => void
  /**
   * Rewind an engine instance to a previous user message. Truncates messages
   * to before the target, tears down the running session, and pre-fills the
   * input bar with the target message's text. Prior conversation context is
   * injected as a system prompt on the next send (one-shot).
   */
  rewindEngineInstance: (tabId: string, instanceId: string, messageId: string, userTurnIndex?: number) => void
  addEngineSystemMessage: (tabId: string, content: string, planFilePath?: string) => void
  /** Insert a user-role message into the active conversation instance for a
   *  remote-originated prompt that bypassed the renderer's submit() path. Used
   *  by the pipeline when an extension command succeeds synchronously (the
   *  extension's ctx.sendPrompt starts the run, but no renderer submit was
   *  ever called for the iOS prompt). Without this the desktop store has the
   *  assistant response but no user bubble, and iOS history reads (which pull
   *  from the renderer store) also miss it. */
  insertRemoteUserMessage: (tabId: string, content: string, slashCommand?: string, slashArgs?: string) => void
  setEngineDraftInput: (tabId: string, text: string) => void
  /**
   * Compute the conversation tail fingerprint for a tab using the canonical
   * TS implementation in `shared/conversation-fingerprint.ts`. Exposed on the
   * store so snapshot.ts's `executeJavaScript` can call it via
   * `store.getState().computeConvFingerprint(tabId)` instead of inlining the
   * algorithm as a string-interpolated IIFE. Eliminates the inline-JS copy in
   * snapshot.ts; the canonical function in shared/ remains the single TS
   * source of truth. Returns '' when the tab has no messages.
   */
  computeConvFingerprint: (tabId: string) => string
  markResourceRead: (resourceId: string) => void
  markAllResourcesRead: (items: ResourceItem[]) => void
  deleteResource: (kind: string, resourceId: string) => void
}

export type StoreSet = (partial: State | Partial<State> | ((state: State) => State | Partial<State>), replace?: false) => void
export type StoreGet = () => State
