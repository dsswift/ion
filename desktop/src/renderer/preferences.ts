import { create } from 'zustand'
import type { TabGroup } from '../shared/types'
import { applyTheme, syncTokensToCss, darkColors, lightColors, type ColorPalette } from './theme-tokens'
import type { PreferencesState, ThemeMode } from './preferences-types'
import { saveSettings, getAllSettings, getEffectiveTabGroups, INITIAL_SAVED, loadPersistedSettings } from './preferences-persist'

export type { ThemeMode, PreferencesState } from './preferences-types'
export { getEffectiveTabGroups } from './preferences-persist'

const saved = INITIAL_SAVED

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  isDark: saved.themeMode === 'dark' ? true : saved.themeMode === 'light' ? false : true,
  themeMode: saved.themeMode,
  soundEnabled: saved.soundEnabled,
  expandedUI: saved.expandedUI,
  ultraWide: saved.ultraWide,
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
  aiGeneratedTitles: saved.aiGeneratedTitles,
  hideOnExternalLaunch: saved.hideOnExternalLaunch,
  keepExplorerOnCollapse: saved.keepExplorerOnCollapse,
  keepTerminalOnCollapse: saved.keepTerminalOnCollapse,
  keepGitPanelOnCollapse: saved.keepGitPanelOnCollapse,
  tabGroupMode: saved.tabGroupMode,
  tabGroups: saved.tabGroups,
  autoGroupOrder: saved.autoGroupOrder,
  stashedManualGroups: saved.stashedManualGroups,
  stashedManualTabAssignments: saved.stashedManualTabAssignments,
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
  engineDefaultModel: saved.engineDefaultModel,
  engineProfiles: saved.engineProfiles,
  preferredModel: saved.preferredModel,
  defaultTallConversation: saved.defaultTallConversation,
  defaultTallTerminal: saved.defaultTallTerminal,
  defaultTallEngine: saved.defaultTallEngine,
  _systemIsDark: true,
  setDefaultTallConversation: (enabled) => {
    set({ defaultTallConversation: enabled })
    saveSettings(getAllSettings(get))
  },
  setDefaultTallTerminal: (enabled) => {
    set({ defaultTallTerminal: enabled })
    saveSettings(getAllSettings(get))
  },
  setDefaultTallEngine: (enabled) => {
    set({ defaultTallEngine: enabled })
    saveSettings(getAllSettings(get))
  },
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
  setAiGeneratedTitles: (enabled) => {
    set({ aiGeneratedTitles: enabled })
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
  setStashedManualGroups: (groups, assignments) => {
    set({ stashedManualGroups: groups, stashedManualTabAssignments: assignments })
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
loadPersistedSettings(
  (patch) => usePreferencesStore.setState(patch),
  () => usePreferencesStore.getState(),
  applyTheme,
)

/** Reactive hook — returns the active color palette */
export function useColors(): ColorPalette {
  const isDark = usePreferencesStore((s) => s.isDark)
  return isDark ? darkColors : lightColors
}

/** Non-reactive getter — use outside React components */
export function getColors(isDark: boolean): ColorPalette {
  return isDark ? darkColors : lightColors
}
