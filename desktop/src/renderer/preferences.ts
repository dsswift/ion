import { create } from 'zustand'
import type { GitOpsMode, WorktreeCompletionStrategy, TabGroupMode, TabGroup, QuickTool, RemotePairedDevice, EngineProfile } from '../shared/types'
import { DEFAULT_TAB_GROUP_LABELS } from '../shared/types'
import { applyTheme, syncTokensToCss, darkColors, lightColors, type ColorPalette } from './theme'

export type ThemeMode = 'system' | 'light' | 'dark'

interface PreferencesState {
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
  /** Engine: path to pi binary (empty = auto-detect) */
  enginePiBinaryPath: string
  /** Engine: path to extension file */
  engineExtensionPath: string
  /** Engine: default model override (empty = use default) */
  engineDefaultModel: string
  /** Preferred model for new conversations (persisted across restarts) */
  preferredModel: string
  /** Named engine profiles for tab creation */
  engineProfiles: EngineProfile[]
  /** OS-reported dark mode -- used when themeMode is 'system' */
  _systemIsDark: boolean
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
  setEnginePiBinaryPath: (path: string) => void
  setEngineExtensionPath: (path: string) => void
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

const SETTINGS_DEFAULTS = { themeMode: 'dark' as ThemeMode, soundEnabled: true, expandedUI: false, ultraWide: false, defaultBaseDirectory: '', recentBaseDirectories: [] as string[], directoryUsageCounts: {} as Record<string, number>, preferredOpenWith: 'cli' as 'cli' | 'vscode', showImplementClearContext: false, defaultPermissionMode: 'plan' as 'auto' | 'plan', expandOnTabSwitch: true, bashCommandEntry: false, gitPanelSplitRatio: 0.4, gitPanelChangesOpen: true, gitPanelGraphOpen: true, expandToolResults: false, terminalFontFamily: 'Menlo, Monaco, monospace', terminalFontSize: 13, closeExplorerOnFileOpen: true, openMarkdownInPreview: true, editorWordWrap: true, gitOpsMode: 'manual' as GitOpsMode, worktreeCompletionStrategy: 'merge' as WorktreeCompletionStrategy, worktreeBranchDefaults: {} as Record<string, string>, worktreeSkipPrTitle: false, allowSettingsEdits: false, showTodoList: true, hideOnExternalLaunch: true, keepExplorerOnCollapse: false, keepTerminalOnCollapse: false, keepGitPanelOnCollapse: false, tabGroupMode: 'off' as TabGroupMode, tabGroups: [] as TabGroup[], autoGroupOrder: [] as string[], inProgressGroupId: null as string | null, doneGroupId: null as string | null, commitCommand: '', gitChangesTreeView: false, quickTools: [] as QuickTool[], uiZoom: 1, remoteEnabled: false, relayUrl: '', relayApiKey: '', lanServerPort: 19837, pairedDevices: [] as RemotePairedDevice[], enginePiBinaryPath: '', engineExtensionPath: '~/.pi/extensions/chief-of-staff.ts', engineDefaultModel: '', engineProfiles: [] as EngineProfile[], preferredModel: 'claude-opus-4-6' }

function saveSettings(s: Record<string, unknown>): void {
  window.ion?.saveSettings(s)
}

function getAllSettings(get: () => PreferencesState): Record<string, unknown> {
  const s = get()
  return { themeMode: s.themeMode, soundEnabled: s.soundEnabled, expandedUI: s.expandedUI, ultraWide: s.ultraWide, defaultBaseDirectory: s.defaultBaseDirectory, recentBaseDirectories: s.recentBaseDirectories, directoryUsageCounts: s.directoryUsageCounts, preferredOpenWith: s.preferredOpenWith, showImplementClearContext: s.showImplementClearContext, defaultPermissionMode: s.defaultPermissionMode, expandOnTabSwitch: s.expandOnTabSwitch, bashCommandEntry: s.bashCommandEntry, gitPanelSplitRatio: s.gitPanelSplitRatio, gitPanelChangesOpen: s.gitPanelChangesOpen, gitPanelGraphOpen: s.gitPanelGraphOpen, expandToolResults: s.expandToolResults, terminalFontFamily: s.terminalFontFamily, terminalFontSize: s.terminalFontSize, gitOpsMode: s.gitOpsMode, worktreeCompletionStrategy: s.worktreeCompletionStrategy, worktreeBranchDefaults: s.worktreeBranchDefaults, worktreeSkipPrTitle: s.worktreeSkipPrTitle, allowSettingsEdits: s.allowSettingsEdits, showTodoList: s.showTodoList, hideOnExternalLaunch: s.hideOnExternalLaunch, keepExplorerOnCollapse: s.keepExplorerOnCollapse, keepTerminalOnCollapse: s.keepTerminalOnCollapse, keepGitPanelOnCollapse: s.keepGitPanelOnCollapse, tabGroupMode: s.tabGroupMode, tabGroups: s.tabGroups, autoGroupOrder: s.autoGroupOrder, inProgressGroupId: s.inProgressGroupId, doneGroupId: s.doneGroupId, commitCommand: s.commitCommand, gitChangesTreeView: s.gitChangesTreeView, quickTools: s.quickTools, uiZoom: s.uiZoom, remoteEnabled: s.remoteEnabled, relayUrl: s.relayUrl, relayApiKey: s.relayApiKey, lanServerPort: s.lanServerPort, pairedDevices: s.pairedDevices, enginePiBinaryPath: s.enginePiBinaryPath, engineExtensionPath: s.engineExtensionPath, engineDefaultModel: s.engineDefaultModel, engineProfiles: s.engineProfiles, preferredModel: s.preferredModel }
}

/** Returns effective tab groups: custom groups if any exist, otherwise built-in defaults */
export function getEffectiveTabGroups(tabGroups: TabGroup[]): TabGroup[] {
  if (tabGroups.length > 0) return tabGroups
  return DEFAULT_TAB_GROUP_LABELS.map((label, i) => ({
    id: `default-${label.toLowerCase().replace(/\s+/g, '-')}`,
    label,
    isDefault: i === 0,
    order: i,
    collapsed: true,
  }))
}

// Start with defaults; async load from disk will update immediately after mount.
const saved = { ...SETTINGS_DEFAULTS, expandedUI: false }

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  isDark: saved.themeMode === 'dark' ? true : saved.themeMode === 'light' ? false : true,
  themeMode: saved.themeMode,
  soundEnabled: saved.soundEnabled,
  expandedUI: saved.expandedUI,
  defaultBaseDirectory: saved.defaultBaseDirectory,
  recentBaseDirectories: saved.recentBaseDirectories,
  directoryUsageCounts: saved.directoryUsageCounts,
  preferredOpenWith: saved.preferredOpenWith,
  showImplementClearContext: saved.showImplementClearContext,
  defaultPermissionMode: saved.defaultPermissionMode,
  expandOnTabSwitch: saved.expandOnTabSwitch,
  bashCommandEntry: saved.bashCommandEntry,
  gitPanelSplitRatio: saved.gitPanelSplitRatio,
  gitPanelChangesOpen: saved.gitPanelChangesOpen,
  gitPanelGraphOpen: saved.gitPanelGraphOpen,
  expandToolResults: saved.expandToolResults,
  terminalFontFamily: saved.terminalFontFamily,
  terminalFontSize: saved.terminalFontSize,
  closeExplorerOnFileOpen: saved.closeExplorerOnFileOpen,
  openMarkdownInPreview: saved.openMarkdownInPreview,
  editorWordWrap: saved.editorWordWrap,
  gitOpsMode: saved.gitOpsMode,
  worktreeCompletionStrategy: saved.worktreeCompletionStrategy,
  worktreeBranchDefaults: saved.worktreeBranchDefaults,
  worktreeSkipPrTitle: saved.worktreeSkipPrTitle,
  allowSettingsEdits: saved.allowSettingsEdits,
  enableClaudeCompat: saved.enableClaudeCompat ?? true,
  showTodoList: saved.showTodoList,
  hideOnExternalLaunch: saved.hideOnExternalLaunch,
  keepExplorerOnCollapse: saved.keepExplorerOnCollapse,
  keepTerminalOnCollapse: saved.keepTerminalOnCollapse,
  keepGitPanelOnCollapse: saved.keepGitPanelOnCollapse,
  tabGroupMode: saved.tabGroupMode,
  tabGroups: saved.tabGroups,
  autoGroupOrder: saved.autoGroupOrder,
  inProgressGroupId: saved.inProgressGroupId,
  doneGroupId: saved.doneGroupId,
  commitCommand: saved.commitCommand,
  gitChangesTreeView: saved.gitChangesTreeView,
  quickTools: saved.quickTools,
  uiZoom: saved.uiZoom,
  remoteEnabled: saved.remoteEnabled,
  relayUrl: saved.relayUrl,
  relayApiKey: saved.relayApiKey,
  lanServerPort: saved.lanServerPort,
  pairedDevices: saved.pairedDevices,
  enginePiBinaryPath: saved.enginePiBinaryPath,
  engineExtensionPath: saved.engineExtensionPath,
  engineDefaultModel: saved.engineDefaultModel,
  engineProfiles: saved.engineProfiles,
  preferredModel: saved.preferredModel,
  _systemIsDark: true,
  setIsDark: (isDark) => {
    set({ isDark })
    applyTheme(isDark)
  },
  setThemeMode: (mode) => {
    const resolved = mode === 'system' ? get()._systemIsDark : mode === 'dark'
    set({ themeMode: mode, isDark: resolved })
    applyTheme(resolved)
    saveSettings(getAllSettings(get))
  },
  setSoundEnabled: (enabled) => {
    set({ soundEnabled: enabled })
    saveSettings(getAllSettings(get))
  },
  setExpandedUI: (expanded) => {
    set({ expandedUI: expanded })
    saveSettings(getAllSettings(get))
  },
  setUltraWide: (enabled) => {
    set({ ultraWide: enabled })
    saveSettings(getAllSettings(get))
  },
  setDefaultBaseDirectory: (dir) => {
    set({ defaultBaseDirectory: dir })
    saveSettings(getAllSettings(get))
  },
  addRecentBaseDirectory: (dir) => {
    const current = get().recentBaseDirectories.filter((d) => d !== dir)
    const updated = [dir, ...current].slice(0, 12)
    set({ recentBaseDirectories: updated })
    saveSettings(getAllSettings(get))
  },
  removeRecentBaseDirectory: (dir) => {
    const updated = get().recentBaseDirectories.filter((d) => d !== dir)
    const counts = { ...get().directoryUsageCounts }
    delete counts[dir]
    set({ recentBaseDirectories: updated, directoryUsageCounts: counts })
    saveSettings(getAllSettings(get))
  },
  incrementDirectoryUsage: (dir) => {
    const counts = { ...get().directoryUsageCounts }
    counts[dir] = (counts[dir] || 0) + 1
    set({ directoryUsageCounts: counts })
    saveSettings(getAllSettings(get))
  },
  setPreferredOpenWith: (app) => {
    set({ preferredOpenWith: app })
    saveSettings(getAllSettings(get))
  },
  setShowImplementClearContext: (show) => {
    set({ showImplementClearContext: show })
    saveSettings(getAllSettings(get))
  },
  setDefaultPermissionMode: (mode) => {
    set({ defaultPermissionMode: mode })
    saveSettings(getAllSettings(get))
  },
  setExpandOnTabSwitch: (enabled) => {
    set({ expandOnTabSwitch: enabled })
    saveSettings(getAllSettings(get))
  },
  setBashCommandEntry: (enabled) => {
    set({ bashCommandEntry: enabled })
    saveSettings(getAllSettings(get))
  },
  setGitPanelSplitRatio: (ratio) => {
    set({ gitPanelSplitRatio: ratio })
    saveSettings(getAllSettings(get))
  },
  setGitPanelChangesOpen: (open) => {
    set({ gitPanelChangesOpen: open })
    saveSettings(getAllSettings(get))
  },
  setGitPanelGraphOpen: (open) => {
    set({ gitPanelGraphOpen: open })
    saveSettings(getAllSettings(get))
  },
  setExpandToolResults: (enabled) => {
    set({ expandToolResults: enabled })
    saveSettings(getAllSettings(get))
  },
  setTerminalFontFamily: (font) => {
    set({ terminalFontFamily: font })
    saveSettings(getAllSettings(get))
  },
  setTerminalFontSize: (size) => {
    set({ terminalFontSize: size })
    saveSettings(getAllSettings(get))
  },
  setCloseExplorerOnFileOpen: (enabled) => {
    set({ closeExplorerOnFileOpen: enabled })
    saveSettings(getAllSettings(get))
  },
  setOpenMarkdownInPreview: (enabled) => {
    set({ openMarkdownInPreview: enabled })
    saveSettings(getAllSettings(get))
  },
  setEditorWordWrap: (enabled) => {
    set({ editorWordWrap: enabled })
    saveSettings(getAllSettings(get))
  },
  setGitOpsMode: (mode) => {
    set({ gitOpsMode: mode })
    saveSettings(getAllSettings(get))
  },
  setWorktreeCompletionStrategy: (strategy) => {
    set({ worktreeCompletionStrategy: strategy })
    saveSettings(getAllSettings(get))
  },
  setWorktreeBranchDefault: (repoPath, branch) => {
    const current = get().worktreeBranchDefaults
    set({ worktreeBranchDefaults: { ...current, [repoPath]: branch } })
    saveSettings(getAllSettings(get))
  },
  removeWorktreeBranchDefault: (repoPath) => {
    const current = { ...get().worktreeBranchDefaults }
    delete current[repoPath]
    set({ worktreeBranchDefaults: current })
    saveSettings(getAllSettings(get))
  },
  setWorktreeSkipPrTitle: (skip) => {
    set({ worktreeSkipPrTitle: skip })
    saveSettings(getAllSettings(get))
  },
  setAllowSettingsEdits: (enabled) => {
    set({ allowSettingsEdits: enabled })
    saveSettings(getAllSettings(get))
  },
  setEnableClaudeCompat: (enabled) => {
    set({ enableClaudeCompat: enabled })
    saveSettings(getAllSettings(get))
  },
  setShowTodoList: (enabled) => {
    set({ showTodoList: enabled })
    saveSettings(getAllSettings(get))
  },
  setHideOnExternalLaunch: (enabled) => {
    set({ hideOnExternalLaunch: enabled })
    saveSettings(getAllSettings(get))
  },
  setKeepExplorerOnCollapse: (enabled) => {
    set({ keepExplorerOnCollapse: enabled })
    saveSettings(getAllSettings(get))
  },
  setKeepTerminalOnCollapse: (enabled) => {
    set({ keepTerminalOnCollapse: enabled })
    saveSettings(getAllSettings(get))
  },
  setKeepGitPanelOnCollapse: (enabled) => {
    set({ keepGitPanelOnCollapse: enabled })
    saveSettings(getAllSettings(get))
  },
  setTabGroupMode: (mode) => {
    set({ tabGroupMode: mode })
    saveSettings(getAllSettings(get))
  },
  setTabGroups: (groups) => {
    set({ tabGroups: groups })
    saveSettings(getAllSettings(get))
  },
  createTabGroup: (label) => {
    const id = crypto.randomUUID()
    const current = get().tabGroups
    const isFirst = current.length === 0
    const group: TabGroup = { id, label, isDefault: isFirst, order: current.length, collapsed: true }
    set({ tabGroups: [...current, group] })
    saveSettings(getAllSettings(get))
    return id
  },
  deleteTabGroup: (groupId) => {
    const current = get().tabGroups
    const removing = current.find((g) => g.id === groupId)
    let updated = current.filter((g) => g.id !== groupId)
    // If we removed the default, assign default to first remaining
    if (removing?.isDefault && updated.length > 0) {
      updated = updated.map((g, i) => i === 0 ? { ...g, isDefault: true } : g)
    }
    // Reindex order
    updated = updated.map((g, i) => ({ ...g, order: i }))
    // Clear in-progress designation if this group was it
    const patch: Partial<PreferencesState> = { tabGroups: updated }
    if (get().inProgressGroupId === groupId) patch.inProgressGroupId = null
    if (get().doneGroupId === groupId) patch.doneGroupId = null
    set(patch)
    saveSettings(getAllSettings(get))
  },
  renameTabGroup: (groupId, label) => {
    set({ tabGroups: get().tabGroups.map((g) => g.id === groupId ? { ...g, label } : g) })
    saveSettings(getAllSettings(get))
  },
  setDefaultTabGroup: (groupId) => {
    set({ tabGroups: get().tabGroups.map((g) => ({ ...g, isDefault: g.id === groupId })) })
    saveSettings(getAllSettings(get))
  },
  reorderTabGroups: (reorderedGroups) => {
    const updated = reorderedGroups.map((g, i) => ({ ...g, order: i }))
    set({ tabGroups: updated })
    saveSettings(getAllSettings(get))
  },
  setAutoGroupOrder: (order) => {
    set({ autoGroupOrder: order })
    saveSettings(getAllSettings(get))
  },
  setInProgressGroupId: (groupId) => {
    set({ inProgressGroupId: groupId })
    saveSettings(getAllSettings(get))
  },
  setDoneGroupId: (groupId) => {
    set({ doneGroupId: groupId })
    saveSettings(getAllSettings(get))
  },
  setCommitCommand: (cmd) => {
    set({ commitCommand: cmd })
    saveSettings(getAllSettings(get))
  },
  setGitChangesTreeView: (enabled) => {
    set({ gitChangesTreeView: enabled })
    saveSettings(getAllSettings(get))
  },
  setQuickTools: (tools) => {
    set({ quickTools: tools })
    saveSettings(getAllSettings(get))
  },
  addQuickTool: (tool) => {
    set({ quickTools: [...get().quickTools, tool] })
    saveSettings(getAllSettings(get))
  },
  removeQuickTool: (toolId) => {
    set({ quickTools: get().quickTools.filter((t) => t.id !== toolId) })
    saveSettings(getAllSettings(get))
  },
  updateQuickTool: (toolId, updates) => {
    set({ quickTools: get().quickTools.map((t) => t.id === toolId ? { ...t, ...updates } : t) })
    saveSettings(getAllSettings(get))
  },
  setUiZoom: (zoom) => {
    const clamped = Math.round(Math.max(0.5, Math.min(2.0, zoom)) * 10) / 10
    document.documentElement.style.zoom = String(clamped)
    set({ uiZoom: clamped })
    saveSettings(getAllSettings(get))
  },
  zoomIn: () => {
    get().setUiZoom(get().uiZoom + 0.1)
  },
  zoomOut: () => {
    get().setUiZoom(get().uiZoom - 0.1)
  },
  setRemoteEnabled: (enabled) => {
    set({ remoteEnabled: enabled })
    saveSettings(getAllSettings(get))
  },
  setRelayUrl: (url) => {
    set({ relayUrl: url })
    saveSettings(getAllSettings(get))
  },
  setRelayApiKey: (key) => {
    set({ relayApiKey: key })
    saveSettings(getAllSettings(get))
  },
  setLanServerPort: (port) => {
    set({ lanServerPort: port })
    saveSettings(getAllSettings(get))
  },
  addPairedDevice: (device) => {
    const current = get().pairedDevices.filter((d) => d.id !== device.id && d.name !== device.name)
    set({ pairedDevices: [...current, device] })
    saveSettings(getAllSettings(get))
  },
  removePairedDevice: (deviceId) => {
    set({ pairedDevices: get().pairedDevices.filter((d) => d.id !== deviceId) })
    saveSettings(getAllSettings(get))
  },
  setEnginePiBinaryPath: (path) => {
    set({ enginePiBinaryPath: path })
    saveSettings(getAllSettings(get))
  },
  setEngineExtensionPath: (path) => {
    set({ engineExtensionPath: path })
    saveSettings(getAllSettings(get))
  },
  setEngineDefaultModel: (model) => {
    set({ engineDefaultModel: model })
    saveSettings(getAllSettings(get))
  },
  setPreferredModel: (model) => {
    set({ preferredModel: model })
    saveSettings(getAllSettings(get))
  },
  addEngineProfile: (profile) => {
    set({ engineProfiles: [...get().engineProfiles, profile] })
    saveSettings(getAllSettings(get))
  },
  updateEngineProfile: (id, updates) => {
    set({ engineProfiles: get().engineProfiles.map((p) => p.id === id ? { ...p, ...updates } : p) })
    saveSettings(getAllSettings(get))
  },
  removeEngineProfile: (id) => {
    set({ engineProfiles: get().engineProfiles.filter((p) => p.id !== id) })
    saveSettings(getAllSettings(get))
  },
  setSystemTheme: (isDark) => {
    set({ _systemIsDark: isDark })
    // Only apply if following system
    if (get().themeMode === 'system') {
      set({ isDark })
      applyTheme(isDark)
    }
  },
  applyPreset: (preset) => {
    set(preset)
    saveSettings(getAllSettings(get))
  },
}))

// Initialize CSS vars with saved theme
syncTokensToCss(saved.themeMode === 'light' ? lightColors : darkColors)

// Load persisted settings from disk (async, fires once on startup)
window.ion?.loadSettings().then((disk) => {
  if (!disk) return
  const store = usePreferencesStore.getState()
  const mode = (['light', 'dark'].includes(disk.themeMode) ? disk.themeMode : 'dark') as ThemeMode
  const resolved = mode === 'system' ? store._systemIsDark : mode === 'dark'
  const sound = typeof disk.soundEnabled === 'boolean' ? disk.soundEnabled : true
  const expanded = typeof disk.expandedUI === 'boolean' ? disk.expandedUI : false
  const ultraWide = typeof disk.ultraWide === 'boolean' ? disk.ultraWide : false
  const baseDir = typeof disk.defaultBaseDirectory === 'string' ? disk.defaultBaseDirectory : ''
  const recentDirs = Array.isArray(disk.recentBaseDirectories) ? disk.recentBaseDirectories.filter((d: unknown) => typeof d === 'string').slice(0, 12) : []
  const dirUsageCounts = (disk.directoryUsageCounts && typeof disk.directoryUsageCounts === 'object' && !Array.isArray(disk.directoryUsageCounts)) ? Object.fromEntries(Object.entries(disk.directoryUsageCounts as Record<string, unknown>).filter(([k, v]) => typeof k === 'string' && typeof v === 'number')) as Record<string, number> : {}
  const openWith = (disk.preferredOpenWith === 'cli' || disk.preferredOpenWith === 'vscode') ? disk.preferredOpenWith : 'cli'
  const implClearCtx = typeof disk.showImplementClearContext === 'boolean' ? disk.showImplementClearContext : false
  const expandTabSwitch = typeof disk.expandOnTabSwitch === 'boolean' ? disk.expandOnTabSwitch : true
  const bashCmd = typeof disk.bashCommandEntry === 'boolean' ? disk.bashCommandEntry : false
  const splitRatio = typeof disk.gitPanelSplitRatio === 'number' ? disk.gitPanelSplitRatio : 0.4
  const changesOpen = typeof disk.gitPanelChangesOpen === 'boolean' ? disk.gitPanelChangesOpen : true
  const graphOpen = typeof disk.gitPanelGraphOpen === 'boolean' ? disk.gitPanelGraphOpen : true
  const expandTools = typeof disk.expandToolResults === 'boolean' ? disk.expandToolResults : false
  const termFont = typeof disk.terminalFontFamily === 'string' ? disk.terminalFontFamily : 'Menlo, Monaco, monospace'
  const termSize = typeof disk.terminalFontSize === 'number' ? disk.terminalFontSize : 13
  const closeExplorer = typeof disk.closeExplorerOnFileOpen === 'boolean' ? disk.closeExplorerOnFileOpen : true
  const mdPreview = typeof disk.openMarkdownInPreview === 'boolean' ? disk.openMarkdownInPreview : true
  const wordWrap = typeof disk.editorWordWrap === 'boolean' ? disk.editorWordWrap : true
  const gitOpsMode = (disk.gitOpsMode === 'manual' || disk.gitOpsMode === 'worktree') ? disk.gitOpsMode : 'manual'
  const wtStrategy = (disk.worktreeCompletionStrategy === 'merge' || disk.worktreeCompletionStrategy === 'pr') ? disk.worktreeCompletionStrategy : 'merge'
  const wtDefaults = (disk.worktreeBranchDefaults && typeof disk.worktreeBranchDefaults === 'object' && !Array.isArray(disk.worktreeBranchDefaults)) ? disk.worktreeBranchDefaults as Record<string, string> : {}
  const wtSkipPr = typeof disk.worktreeSkipPrTitle === 'boolean' ? disk.worktreeSkipPrTitle : false
  const allowSettings = typeof disk.allowSettingsEdits === 'boolean' ? disk.allowSettingsEdits : false
  const showTodo = typeof disk.showTodoList === 'boolean' ? disk.showTodoList : true
  const hideExternal = typeof disk.hideOnExternalLaunch === 'boolean' ? disk.hideOnExternalLaunch : true
  const tabGroupMode = (disk.tabGroupMode === 'off' || disk.tabGroupMode === 'auto' || disk.tabGroupMode === 'manual') ? disk.tabGroupMode : 'off'
  const tabGroups = Array.isArray(disk.tabGroups) ? (disk.tabGroups as TabGroup[]).filter((g: any) => g && typeof g.id === 'string' && typeof g.label === 'string') : []
  const autoGroupOrder = Array.isArray(disk.autoGroupOrder) ? (disk.autoGroupOrder as string[]).filter((d: unknown) => typeof d === 'string') : []
  const inProgressGroupId = typeof disk.inProgressGroupId === 'string' ? disk.inProgressGroupId : null
  const doneGroupId = typeof disk.doneGroupId === 'string' ? disk.doneGroupId : null
  const commitCommand = typeof disk.commitCommand === 'string' ? disk.commitCommand : ''
  const changesTreeView = typeof disk.gitChangesTreeView === 'boolean' ? disk.gitChangesTreeView : false
  const keepExplorer = typeof disk.keepExplorerOnCollapse === 'boolean' ? disk.keepExplorerOnCollapse : false
  const keepTerminal = typeof disk.keepTerminalOnCollapse === 'boolean' ? disk.keepTerminalOnCollapse : false
  const keepGitPanel = typeof disk.keepGitPanelOnCollapse === 'boolean' ? disk.keepGitPanelOnCollapse : false
  const permMode = (disk.defaultPermissionMode === 'auto' || disk.defaultPermissionMode === 'plan') ? disk.defaultPermissionMode : 'plan'
  const quickTools = Array.isArray(disk.quickTools) ? (disk.quickTools as QuickTool[]).filter((t: any) => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.command === 'string') : []
  const uiZoom = typeof disk.uiZoom === 'number' ? Math.round(Math.max(0.5, Math.min(2.0, disk.uiZoom)) * 10) / 10 : 1
  const remoteEnabled = typeof disk.remoteEnabled === 'boolean' ? disk.remoteEnabled : false
  const relayUrl = typeof disk.relayUrl === 'string' ? disk.relayUrl : ''
  const relayApiKey = typeof disk.relayApiKey === 'string' ? disk.relayApiKey : ''
  const lanServerPort = typeof disk.lanServerPort === 'number' ? disk.lanServerPort : 19837
  const pairedDevices = Array.isArray(disk.pairedDevices) ? (disk.pairedDevices as RemotePairedDevice[]).filter((d: any) => d && typeof d.id === 'string' && typeof d.name === 'string') : []
  const enginePiBinaryPath = typeof disk.enginePiBinaryPath === 'string' ? disk.enginePiBinaryPath : ''
  const engineExtensionPath = typeof disk.engineExtensionPath === 'string' ? disk.engineExtensionPath : ''
  const engineDefaultModel = typeof disk.engineDefaultModel === 'string' ? disk.engineDefaultModel : ''
  const preferredModel = typeof disk.preferredModel === 'string' && disk.preferredModel ? disk.preferredModel : 'claude-opus-4-6'
  const engineProfilesRaw = Array.isArray(disk.engineProfiles) ? (disk.engineProfiles as any[]).filter((p: any) => p && typeof p.id === 'string' && typeof p.name === 'string') : []
  // Migrate old { args } profiles to new structured format
  const engineProfiles: EngineProfile[] = engineProfilesRaw.map((p: any) => {
    if ('args' in p && !('extensionDir' in p)) {
      const extensionMatch = p.args?.match(/-e\s+([^\s]+)/)
      return {
        id: p.id,
        name: p.name,
        extensionDir: extensionMatch ? extensionMatch[1].replace(/\/[^/]+$/, '') : '',
      }
    }
    // Migrate old named fields to options bag
    const migrated = { ...p }
    const opts: Record<string, any> = { ...(migrated.options || {}) }
    for (const key of ['agentsRoot', 'defaultTeam', 'damageControlRules', 'universalStandards']) {
      if (key in migrated && !(key in opts)) {
        opts[key] = (migrated as any)[key]
        delete (migrated as any)[key]
      }
    }
    if (Object.keys(opts).length > 0) migrated.options = opts
    return migrated as EngineProfile
  })
  usePreferencesStore.setState({ themeMode: mode, isDark: resolved, soundEnabled: sound, expandedUI: expanded, ultraWide, defaultBaseDirectory: baseDir, recentBaseDirectories: recentDirs, directoryUsageCounts: dirUsageCounts, preferredOpenWith: openWith, showImplementClearContext: implClearCtx, expandOnTabSwitch: expandTabSwitch, bashCommandEntry: bashCmd, gitPanelSplitRatio: splitRatio, gitPanelChangesOpen: changesOpen, gitPanelGraphOpen: graphOpen, expandToolResults: expandTools, terminalFontFamily: termFont, terminalFontSize: termSize, closeExplorerOnFileOpen: closeExplorer, openMarkdownInPreview: mdPreview, editorWordWrap: wordWrap, gitOpsMode, worktreeCompletionStrategy: wtStrategy, worktreeBranchDefaults: wtDefaults, worktreeSkipPrTitle: wtSkipPr, allowSettingsEdits: allowSettings, showTodoList: showTodo, hideOnExternalLaunch: hideExternal, tabGroupMode: tabGroupMode as TabGroupMode, tabGroups, autoGroupOrder, inProgressGroupId, doneGroupId, commitCommand, gitChangesTreeView: changesTreeView, keepExplorerOnCollapse: keepExplorer, keepTerminalOnCollapse: keepTerminal, keepGitPanelOnCollapse: keepGitPanel, defaultPermissionMode: permMode, quickTools, uiZoom, remoteEnabled, relayUrl, relayApiKey, lanServerPort, pairedDevices, enginePiBinaryPath, engineExtensionPath, engineDefaultModel, engineProfiles, preferredModel })
  applyTheme(resolved)
  if (uiZoom !== 1) document.documentElement.style.zoom = String(uiZoom)

  // Migrate legacy engine fields to profile
  if (engineProfiles.length === 0 && engineExtensionPath) {
    const extensionDir = engineExtensionPath.replace(/\/[^/]+$/, '')
    const fileName = engineExtensionPath.split('/').pop()?.replace('.ts', '') || 'engine'
    const migrated: EngineProfile = {
      id: crypto.randomUUID().slice(0, 8),
      name: fileName,
      extensionDir,
      ...(engineDefaultModel ? { model: engineDefaultModel } : {}),
    }
    usePreferencesStore.getState().addEngineProfile(migrated)
  }
})

/** Reactive hook — returns the active color palette */
export function useColors(): ColorPalette {
  const isDark = usePreferencesStore((s) => s.isDark)
  return isDark ? darkColors : lightColors
}

/** Non-reactive getter — use outside React components */
export function getColors(isDark: boolean): ColorPalette {
  return isDark ? darkColors : lightColors
}
