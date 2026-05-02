import type { GitOpsMode, WorktreeCompletionStrategy, TabGroupMode, TabGroup, QuickTool, RemotePairedDevice, EngineProfile } from '../shared/types'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface PreferencesState {
  isDark: boolean
  themeMode: ThemeMode
  soundEnabled: boolean
  expandedUI: boolean
  ultraWide: boolean
  defaultBaseDirectory: string
  recentBaseDirectories: string[]
  directoryUsageCounts: Record<string, number>
  preferredOpenWith: 'cli' | 'vscode'
  showImplementClearContext: boolean
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
  /** Show the todo/task list panel at the bottom of the conversation */
  showTodoList: boolean
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
  /** OS-reported dark mode -- used when themeMode is 'system' */
  _systemIsDark: boolean
  setDefaultTallConversation: (enabled: boolean) => void
  setDefaultTallTerminal: (enabled: boolean) => void
  setDefaultTallEngine: (enabled: boolean) => void
  setTabRecoveryEnabled: (enabled: boolean) => void
  setTabRecoveryTimeoutSec: (sec: number) => void
  setIsDark: (isDark: boolean) => void
  setThemeMode: (mode: ThemeMode) => void
  setSoundEnabled: (enabled: boolean) => void
  setExpandedUI: (expanded: boolean) => void
  setUltraWide: (enabled: boolean) => void
  setDefaultBaseDirectory: (dir: string) => void
  addRecentBaseDirectory: (dir: string) => void
  removeRecentBaseDirectory: (dir: string) => void
  incrementDirectoryUsage: (dir: string) => void
  setPreferredOpenWith: (app: 'cli' | 'vscode') => void
  setShowImplementClearContext: (show: boolean) => void
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
  setGitOpsMode: (mode: GitOpsMode) => void
  setWorktreeCompletionStrategy: (strategy: WorktreeCompletionStrategy) => void
  setWorktreeBranchDefault: (repoPath: string, branch: string) => void
  removeWorktreeBranchDefault: (repoPath: string) => void
  setWorktreeSkipPrTitle: (skip: boolean) => void
  setAllowSettingsEdits: (enabled: boolean) => void
  setEnableClaudeCompat: (enabled: boolean) => void
  setShowTodoList: (enabled: boolean) => void
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
  setEngineDefaultModel: (model: string) => void
  setPreferredModel: (model: string) => void
  addEngineProfile: (profile: EngineProfile) => void
  updateEngineProfile: (id: string, updates: Partial<EngineProfile>) => void
  removeEngineProfile: (id: string) => void
  /** Called by OS theme change listener -- updates system value */
  setSystemTheme: (isDark: boolean) => void
  /** Apply a settings preset (batch-set multiple fields at once) */
  applyPreset: (preset: Record<string, unknown>) => void
}

export const SETTINGS_DEFAULTS = { themeMode: 'dark' as ThemeMode, soundEnabled: true, expandedUI: false, ultraWide: false, defaultBaseDirectory: '', recentBaseDirectories: [] as string[], directoryUsageCounts: {} as Record<string, number>, preferredOpenWith: 'cli' as 'cli' | 'vscode', showImplementClearContext: false, defaultPermissionMode: 'plan' as 'auto' | 'plan', expandOnTabSwitch: true, bashCommandEntry: false, gitPanelSplitRatio: 0.4, gitPanelChangesOpen: true, gitPanelGraphOpen: true, expandToolResults: false, terminalFontFamily: 'Menlo, Monaco, monospace', terminalFontSize: 13, closeExplorerOnFileOpen: true, openMarkdownInPreview: true, editorWordWrap: true, gitOpsMode: 'manual' as GitOpsMode, worktreeCompletionStrategy: 'merge' as WorktreeCompletionStrategy, worktreeBranchDefaults: {} as Record<string, string>, worktreeSkipPrTitle: false, allowSettingsEdits: false, enableClaudeCompat: true, showTodoList: true, aiGeneratedTitles: true, hideOnExternalLaunch: true, keepExplorerOnCollapse: false, keepTerminalOnCollapse: false, keepGitPanelOnCollapse: false, tabGroupMode: 'off' as TabGroupMode, tabGroups: [] as TabGroup[], autoGroupOrder: [] as string[], stashedManualGroups: [] as TabGroup[], stashedManualTabAssignments: {} as Record<string, string>, inProgressGroupId: null as string | null, doneGroupId: null as string | null, commitCommand: '', gitChangesTreeView: false, quickTools: [] as QuickTool[], uiZoom: 1, remoteEnabled: false, relayUrl: '', relayApiKey: '', lanServerPort: 19837, pairedDevices: [] as RemotePairedDevice[], engineDefaultModel: '', engineProfiles: [] as EngineProfile[], preferredModel: 'claude-opus-4-6', defaultTallConversation: false, defaultTallTerminal: false, defaultTallEngine: false, tabRecoveryEnabled: true, tabRecoveryTimeoutSec: 120 }
