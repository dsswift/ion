import type { GitOpsMode, WorktreeCompletionStrategy, TabGroupMode, TabGroup, QuickTool, RemotePairedDevice, EngineProfile } from '../shared/types'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface PreferencesState {
  isDark: boolean
  themeMode: ThemeMode
  /** Selected theme ID from the theme registry. Persisted in localStorage. */
  selectedTheme: string
  soundEnabled: boolean
  expandedUI: boolean
  ultraWide: boolean
  defaultBaseDirectory: string
  recentBaseDirectories: string[]
  directoryUsageCounts: Record<string, number>
  preferredOpenWith: 'cli' | 'vscode'
  defaultPermissionMode: 'auto' | 'plan'
  expandOnTabSwitch: boolean
  bashCommandEntry: boolean
  gitPanelSplitRatio: number
  gitPanelChangesOpen: boolean
  gitPanelGraphOpen: boolean
  expandToolResults: boolean
  terminalFontFamily: string
  terminalFontSize: number
  closeExplorerOnFileOpen: boolean
  openMarkdownInPreview: boolean
  editorWordWrap: boolean
  /** Font size for the file editor in pixels */
  editorFontSize: number
  /** Font size in px for conversation message body text. 8–24. */
  conversationFontSize: number
  /** Git operations mode: manual (no automation) or worktree (managed per-tab worktrees) */
  gitOpsMode: GitOpsMode
  /** How to complete worktree work: merge --no-ff or push + PR */
  worktreeCompletionStrategy: WorktreeCompletionStrategy
  /** Map of repo path -> default source branch for worktree creation */
  worktreeBranchDefaults: Record<string, string>
  /** Skip the PR title dialog and always use auto-generated branch name */
  worktreeSkipPrTitle: boolean
  /** Show approval card instead of hard failure when agent edits its own settings */
  allowSettingsEdits: boolean
  /** Load commands and skills from .claude/ directories */
  enableClaudeCompat: boolean
  /**
   * Reply to the engine's wire-protocol before_early_stop_decision request
   * with a Claude-Code-style "Stopped at X% of token target… Keep working"
   * continuation prompt when the engine's tentative WouldContinue verdict
   * is true. Disable to never nudge the model regardless of the engine's
   * verdict. Read by desktop/src/main/early-stop-policy.ts on every event,
   * so a flip takes effect on the next decision. Default true.
   */
  enableEarlyStopContinuation: boolean
  /** Show the todo/task list panel at the bottom of the conversation */
  showTodoList: boolean
  /** Automatically expand the agent panel when agents are dispatched */
  agentPanelDefaultOpen: boolean
  /** Open agent details in a floating panel instead of expanding inline */
  agentDetailPopup: boolean
  /** Group tool calls and assistant text into unified turn blocks */
  unifiedTurnView: boolean
  /** Use AI to generate descriptive tab titles from the first message */
  aiGeneratedTitles: boolean
  /** Hide Ion overlay when launching external apps (Finder, Terminal, VS Code, etc.) */
  hideOnExternalLaunch: boolean
  /** Keep explorer open when conversation is minimized */
  keepExplorerOnCollapse: boolean
  /** Keep terminal open when conversation is minimized */
  keepTerminalOnCollapse: boolean
  /** Keep git panel open when conversation is minimized */
  keepGitPanelOnCollapse: boolean
  /** Tab grouping mode: off (flat), auto (by directory), manual (user-defined groups) */
  tabGroupMode: TabGroupMode
  /** Manual/auto tab group definitions */
  tabGroups: TabGroup[]
  /** Persisted ordering for auto-mode groups (directory paths in order) */
  autoGroupOrder: string[]
  /** Stashed manual group definitions for roundtrip restoration */
  stashedManualGroups: TabGroup[]
  /** Stashed tab-to-group assignments (tabId → groupId) for roundtrip restoration */
  stashedManualTabAssignments: Record<string, string>
  /** Group ID that tabs auto-move into when implementation starts (null = disabled) */
  inProgressGroupId: string | null
  /** Group ID that tabs move into after committing (null = disabled) */
  doneGroupId: string | null
  /** Group ID that tabs in plan mode auto-move to (null = disabled) */
  planningGroupId: string | null
  /** Automatically move tabs between groups based on mode changes */
  autoGroupMovement: boolean
  /** Custom bash command to run instead of prompting the LLM for commits */
  commitCommand: string
  /** Show changed files grouped by directory in tree view */
  gitChangesTreeView: boolean
  /** User-configured quick tool buttons */
  quickTools: QuickTool[]
  /** UI zoom level (CSS zoom on :root, 0.5--2.0) */
  uiZoom: number
  /** Remote control: master toggle */
  remoteEnabled: boolean
  /** Remote control: relay server URL (empty = no relay) */
  relayUrl: string
  /** Remote control: relay API key */
  relayApiKey: string
  /** Remote control: LAN server port */
  lanServerPort: number
  /** Remote control: paired iOS devices */
  pairedDevices: RemotePairedDevice[]
  /**
   * Per-desktop display override that is broadcast to all paired iOS devices.
   * `null` means "use the OS hostname + default icon". `updatedAt` is used
   * for last-write-wins reconciliation between iOS edits and desktop edits.
   */
  remoteDisplay: { customName: string | null; customIcon: string | null; updatedAt: number } | null
  /** Engine: default model override (empty = use default) */
  engineDefaultModel: string
  /** Preferred model for new conversations (persisted across restarts) */
  preferredModel: string
  /** Named engine profiles for tab creation */
  engineProfiles: EngineProfile[]
  /** Default tall mode per tab type */
  defaultTallConversation: boolean
  defaultTallTerminal: boolean
  defaultTallEngine: boolean
  /** Auto-recover tabs that appear stuck (no engine events for a period) */
  tabRecoveryEnabled: boolean
  /** Idle threshold in seconds before a stuck tab is force-recovered */
  tabRecoveryTimeoutSec: number
  /** Automatically switch models at the plan→implement boundary */
  planModelSplitEnabled: boolean
  /** Model to use when entering plan mode (empty = use preferredModel) */
  planModeModel: string
  /** Model to use when implementing a plan (empty = use preferredModel) */
  implementModeModel: string
  /** Bash commands allowed to execute without approval in plan mode */
  planModeAllowedBashCommands: string[]
  /**
   * When true, reveals a second action on the plan-approval card:
   * **"Implement, clear context"**. Clicking that button destroys the
   * current engine session and starts a fresh conversation for the
   * implement phase (the historical behavior). The regular **Implement**
   * button always stays in the same conversation — the model retains
   * everything it learned during planning, the plan-mode system prompt
   * is dropped, and the EnterPlanMode sentinel tool is suppressed (via
   * ClientCommand.ImplementationPhase) so it can't be re-proposed.
   *
   * Granularity is per-plan: the user decides at click-time whether
   * they want a fresh conversation for this particular plan. There is
   * no global "always clear context" toggle — that would force the
   * behavior across every plan, every tab.
   *
   * Users can also manually clear context with `/clear` regardless of
   * this preference.
   *
   * Engine-tab support: the opt-in reset path is not yet wired for
   * engine tabs (no `engineResetSession` IPC exists). When the user
   * clicks "Implement, clear context" on an engine tab, the renderer
   * logs a warning and falls back to the no-reset path. CLI tabs and
   * iOS-driven CLI tabs honor the action fully.
   */
  showImplementClearContext: boolean
  /** OS-reported dark mode -- used when themeMode is 'system' */
  _systemIsDark: boolean
  setDefaultTallConversation: (enabled: boolean) => void
  setDefaultTallTerminal: (enabled: boolean) => void
  setDefaultTallEngine: (enabled: boolean) => void
  setTabRecoveryEnabled: (enabled: boolean) => void
  setTabRecoveryTimeoutSec: (sec: number) => void
  setIsDark: (isDark: boolean) => void
  setThemeMode: (mode: ThemeMode) => void
  setSelectedTheme: (id: string) => void
  setSoundEnabled: (enabled: boolean) => void
  setExpandedUI: (expanded: boolean) => void
  setUltraWide: (enabled: boolean) => void
  setDefaultBaseDirectory: (dir: string) => void
  addRecentBaseDirectory: (dir: string) => void
  removeRecentBaseDirectory: (dir: string) => void
  incrementDirectoryUsage: (dir: string) => void
  setPreferredOpenWith: (app: 'cli' | 'vscode') => void
  setDefaultPermissionMode: (mode: 'auto' | 'plan') => void
  setExpandOnTabSwitch: (enabled: boolean) => void
  setBashCommandEntry: (enabled: boolean) => void
  setGitPanelSplitRatio: (ratio: number) => void
  setGitPanelChangesOpen: (open: boolean) => void
  setGitPanelGraphOpen: (open: boolean) => void
  setExpandToolResults: (enabled: boolean) => void
  setTerminalFontFamily: (font: string) => void
  setTerminalFontSize: (size: number) => void
  setCloseExplorerOnFileOpen: (enabled: boolean) => void
  setOpenMarkdownInPreview: (enabled: boolean) => void
  setEditorWordWrap: (enabled: boolean) => void
  setEditorFontSize: (size: number) => void
  setConversationFontSize: (size: number) => void
  setGitOpsMode: (mode: GitOpsMode) => void
  setWorktreeCompletionStrategy: (strategy: WorktreeCompletionStrategy) => void
  setWorktreeBranchDefault: (repoPath: string, branch: string) => void
  removeWorktreeBranchDefault: (repoPath: string) => void
  setWorktreeSkipPrTitle: (skip: boolean) => void
  setAllowSettingsEdits: (enabled: boolean) => void
  setEnableClaudeCompat: (enabled: boolean) => void
  setEnableEarlyStopContinuation: (enabled: boolean) => void
  setShowTodoList: (enabled: boolean) => void
  setAgentPanelDefaultOpen: (enabled: boolean) => void
  setAgentDetailPopup: (enabled: boolean) => void
  setUnifiedTurnView: (enabled: boolean) => void
  setAiGeneratedTitles: (enabled: boolean) => void
  setHideOnExternalLaunch: (enabled: boolean) => void
  setKeepExplorerOnCollapse: (enabled: boolean) => void
  setKeepTerminalOnCollapse: (enabled: boolean) => void
  setKeepGitPanelOnCollapse: (enabled: boolean) => void
  setTabGroupMode: (mode: TabGroupMode) => void
  setTabGroups: (groups: TabGroup[]) => void
  createTabGroup: (label: string) => string
  deleteTabGroup: (groupId: string) => void
  renameTabGroup: (groupId: string, label: string) => void
  setDefaultTabGroup: (groupId: string) => void
  reorderTabGroups: (reorderedGroups: TabGroup[]) => void
  setAutoGroupOrder: (order: string[]) => void
  setStashedManualGroups: (groups: TabGroup[], assignments: Record<string, string>) => void
  setInProgressGroupId: (groupId: string | null) => void
  setDoneGroupId: (groupId: string | null) => void
  setPlanningGroupId: (groupId: string | null) => void
  setAutoGroupMovement: (enabled: boolean) => void
  setCommitCommand: (cmd: string) => void
  setGitChangesTreeView: (enabled: boolean) => void
  setQuickTools: (tools: QuickTool[]) => void
  addQuickTool: (tool: QuickTool) => void
  removeQuickTool: (toolId: string) => void
  updateQuickTool: (toolId: string, updates: Partial<QuickTool>) => void
  setUiZoom: (zoom: number) => void
  zoomIn: () => void
  zoomOut: () => void
  setRemoteEnabled: (enabled: boolean) => void
  setRelayUrl: (url: string) => void
  setRelayApiKey: (key: string) => void
  setLanServerPort: (port: number) => void
  addPairedDevice: (device: RemotePairedDevice) => void
  removePairedDevice: (deviceId: string) => void
  /**
   * Update the desktop's display override. Pass `null` for either field to
   * clear it. Bumps `updatedAt = Date.now()` and persists via the renderer's
   * standard saveSettings path. Does NOT call the main-process broadcast
   * helper directly — the renderer calls `window.ion.remoteSetDisplay(...)`
   * which funnels through `setRemoteDisplay()` in main.
   */
  setRemoteDisplay: (customName: string | null, customIcon: string | null) => void
  setEngineDefaultModel: (model: string) => void
  setPreferredModel: (model: string) => void
  addEngineProfile: (profile: EngineProfile) => void
  updateEngineProfile: (id: string, updates: Partial<EngineProfile>) => void
  removeEngineProfile: (id: string) => void
  setPlanModelSplitEnabled: (enabled: boolean) => void
  setPlanModeModel: (model: string) => void
  setImplementModeModel: (model: string) => void
  setPlanModeAllowedBashCommands: (cmds: string[]) => void
  setShowImplementClearContext: (enabled: boolean) => void
  /** Called by OS theme change listener -- updates system value */
  setSystemTheme: (isDark: boolean) => void
  /** Apply a settings preset (batch-set multiple fields at once) */
  applyPreset: (preset: Record<string, unknown>) => void
}

export const SETTINGS_DEFAULTS = { themeMode: 'dark' as ThemeMode, selectedTheme: 'ion-dark', soundEnabled: true, expandedUI: false, ultraWide: false, defaultBaseDirectory: '', recentBaseDirectories: [] as string[], directoryUsageCounts: {} as Record<string, number>, preferredOpenWith: 'cli' as 'cli' | 'vscode', defaultPermissionMode: 'plan' as 'auto' | 'plan', expandOnTabSwitch: true, bashCommandEntry: false, gitPanelSplitRatio: 0.4, gitPanelChangesOpen: true, gitPanelGraphOpen: true, expandToolResults: false, terminalFontFamily: 'Menlo, Monaco, monospace', terminalFontSize: 13, closeExplorerOnFileOpen: true, openMarkdownInPreview: true, editorWordWrap: true, editorFontSize: 12, conversationFontSize: 13, gitOpsMode: 'manual' as GitOpsMode, worktreeCompletionStrategy: 'merge-ff' as WorktreeCompletionStrategy, worktreeBranchDefaults: {} as Record<string, string>, worktreeSkipPrTitle: false, allowSettingsEdits: false, enableClaudeCompat: true, enableEarlyStopContinuation: false, showTodoList: true, agentPanelDefaultOpen: true, agentDetailPopup: true, unifiedTurnView: true, aiGeneratedTitles: true, hideOnExternalLaunch: true, keepExplorerOnCollapse: false, keepTerminalOnCollapse: false, keepGitPanelOnCollapse: false, tabGroupMode: 'off' as TabGroupMode, tabGroups: [] as TabGroup[], autoGroupOrder: [] as string[], stashedManualGroups: [] as TabGroup[], stashedManualTabAssignments: {} as Record<string, string>, inProgressGroupId: null as string | null, doneGroupId: null as string | null, planningGroupId: null as string | null, autoGroupMovement: false, commitCommand: '', gitChangesTreeView: false, quickTools: [] as QuickTool[], uiZoom: 1, remoteEnabled: false, relayUrl: '', relayApiKey: '', lanServerPort: 19837, pairedDevices: [] as RemotePairedDevice[], remoteDisplay: null as { customName: string | null; customIcon: string | null; updatedAt: number } | null, engineDefaultModel: '', engineProfiles: [] as EngineProfile[], preferredModel: 'claude-opus-4-6', defaultTallConversation: false, defaultTallTerminal: false, defaultTallEngine: false, tabRecoveryEnabled: true, tabRecoveryTimeoutSec: 120, planModelSplitEnabled: false, planModeModel: '', implementModeModel: '', showImplementClearContext: false, planModeAllowedBashCommands: ['gh'] as string[] }
