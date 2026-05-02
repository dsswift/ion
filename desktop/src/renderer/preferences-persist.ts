import type { TabGroup, TabGroupMode, QuickTool, RemotePairedDevice, EngineProfile } from '../shared/types'
import { DEFAULT_TAB_GROUP_LABELS } from '../shared/types'
import type { PreferencesState, ThemeMode } from './preferences-types'
import { SETTINGS_DEFAULTS } from './preferences-types'

export function saveSettings(s: Record<string, unknown>): void {
  window.ion?.saveSettings(s)
}

export function getAllSettings(get: () => PreferencesState): Record<string, unknown> {
  const s = get()
  return { themeMode: s.themeMode, soundEnabled: s.soundEnabled, expandedUI: s.expandedUI, ultraWide: s.ultraWide, defaultBaseDirectory: s.defaultBaseDirectory, recentBaseDirectories: s.recentBaseDirectories, directoryUsageCounts: s.directoryUsageCounts, preferredOpenWith: s.preferredOpenWith, showImplementClearContext: s.showImplementClearContext, defaultPermissionMode: s.defaultPermissionMode, expandOnTabSwitch: s.expandOnTabSwitch, bashCommandEntry: s.bashCommandEntry, gitPanelSplitRatio: s.gitPanelSplitRatio, gitPanelChangesOpen: s.gitPanelChangesOpen, gitPanelGraphOpen: s.gitPanelGraphOpen, expandToolResults: s.expandToolResults, terminalFontFamily: s.terminalFontFamily, terminalFontSize: s.terminalFontSize, gitOpsMode: s.gitOpsMode, worktreeCompletionStrategy: s.worktreeCompletionStrategy, worktreeBranchDefaults: s.worktreeBranchDefaults, worktreeSkipPrTitle: s.worktreeSkipPrTitle, allowSettingsEdits: s.allowSettingsEdits, enableClaudeCompat: s.enableClaudeCompat, showTodoList: s.showTodoList, aiGeneratedTitles: s.aiGeneratedTitles, hideOnExternalLaunch: s.hideOnExternalLaunch, keepExplorerOnCollapse: s.keepExplorerOnCollapse, keepTerminalOnCollapse: s.keepTerminalOnCollapse, keepGitPanelOnCollapse: s.keepGitPanelOnCollapse, tabGroupMode: s.tabGroupMode, tabGroups: s.tabGroups, autoGroupOrder: s.autoGroupOrder, stashedManualGroups: s.stashedManualGroups, stashedManualTabAssignments: s.stashedManualTabAssignments, inProgressGroupId: s.inProgressGroupId, doneGroupId: s.doneGroupId, planningGroupId: s.planningGroupId, autoGroupMovement: s.autoGroupMovement, commitCommand: s.commitCommand, gitChangesTreeView: s.gitChangesTreeView, quickTools: s.quickTools, uiZoom: s.uiZoom, remoteEnabled: s.remoteEnabled, relayUrl: s.relayUrl, relayApiKey: s.relayApiKey, lanServerPort: s.lanServerPort, pairedDevices: s.pairedDevices, engineDefaultModel: s.engineDefaultModel, engineProfiles: s.engineProfiles, preferredModel: s.preferredModel, defaultTallConversation: s.defaultTallConversation, defaultTallTerminal: s.defaultTallTerminal, defaultTallEngine: s.defaultTallEngine, tabRecoveryEnabled: s.tabRecoveryEnabled, tabRecoveryTimeoutSec: s.tabRecoveryTimeoutSec }
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

/** Initial in-memory defaults; disk values fill in via async loadSettings */
export const INITIAL_SAVED = { ...SETTINGS_DEFAULTS, expandedUI: false }

/**
 * Hydrate the store from disk. Validates each field (the engine writes raw
 * JSON, so anything could be malformed). Calls back into setState + applyTheme
 * so the store identity is preserved across reloads.
 */
export function loadPersistedSettings(
  setState: (patch: Partial<PreferencesState>) => void,
  getState: () => PreferencesState,
  applyTheme: (isDark: boolean) => void,
): void {
  window.ion?.loadSettings().then((disk) => {
    if (!disk) return
    const store = getState()
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
    const enableCompat = typeof disk.enableClaudeCompat === 'boolean' ? disk.enableClaudeCompat : true
    const showTodo = typeof disk.showTodoList === 'boolean' ? disk.showTodoList : true
    const aiTitles = typeof disk.aiGeneratedTitles === 'boolean' ? disk.aiGeneratedTitles : true
    const hideExternal = typeof disk.hideOnExternalLaunch === 'boolean' ? disk.hideOnExternalLaunch : true
    const tabGroupMode = (disk.tabGroupMode === 'off' || disk.tabGroupMode === 'auto' || disk.tabGroupMode === 'manual') ? disk.tabGroupMode : 'off'
    const tabGroups = Array.isArray(disk.tabGroups) ? (disk.tabGroups as TabGroup[]).filter((g: any) => g && typeof g.id === 'string' && typeof g.label === 'string') : []
    const autoGroupOrder = Array.isArray(disk.autoGroupOrder) ? (disk.autoGroupOrder as string[]).filter((d: unknown) => typeof d === 'string') : []
    const stashedManualGroups = Array.isArray(disk.stashedManualGroups) ? (disk.stashedManualGroups as TabGroup[]).filter((g: any) => g && typeof g.id === 'string' && typeof g.label === 'string') : []
    const stashedManualTabAssignments = (disk.stashedManualTabAssignments && typeof disk.stashedManualTabAssignments === 'object' && !Array.isArray(disk.stashedManualTabAssignments)) ? Object.fromEntries(Object.entries(disk.stashedManualTabAssignments as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {}
    const inProgressGroupId = typeof disk.inProgressGroupId === 'string' ? disk.inProgressGroupId : null
    const doneGroupId = typeof disk.doneGroupId === 'string' ? disk.doneGroupId : null
    const planningGroupId = typeof disk.planningGroupId === 'string' ? disk.planningGroupId : null
    const autoGroupMovement = typeof disk.autoGroupMovement === 'boolean' ? disk.autoGroupMovement : false
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
    const engineDefaultModel = typeof disk.engineDefaultModel === 'string' ? disk.engineDefaultModel : ''
    const preferredModel = typeof disk.preferredModel === 'string' && disk.preferredModel ? disk.preferredModel : 'claude-opus-4-6'
    const engineProfiles: EngineProfile[] = Array.isArray(disk.engineProfiles) ? (disk.engineProfiles as any[]).filter((p: any) => p && typeof p.id === 'string' && typeof p.name === 'string') : []
    const defaultTallConversation = typeof disk.defaultTallConversation === 'boolean' ? disk.defaultTallConversation : false
    const defaultTallTerminal = typeof disk.defaultTallTerminal === 'boolean' ? disk.defaultTallTerminal : false
    const defaultTallEngine = typeof disk.defaultTallEngine === 'boolean' ? disk.defaultTallEngine : false
    const tabRecoveryEnabled = typeof disk.tabRecoveryEnabled === 'boolean' ? disk.tabRecoveryEnabled : true
    const tabRecoveryTimeoutSec = typeof disk.tabRecoveryTimeoutSec === 'number' ? Math.max(30, Math.min(600, Math.round(disk.tabRecoveryTimeoutSec))) : 120
    setState({ themeMode: mode, isDark: resolved, soundEnabled: sound, expandedUI: expanded, ultraWide, defaultBaseDirectory: baseDir, recentBaseDirectories: recentDirs, directoryUsageCounts: dirUsageCounts, preferredOpenWith: openWith, showImplementClearContext: implClearCtx, expandOnTabSwitch: expandTabSwitch, bashCommandEntry: bashCmd, gitPanelSplitRatio: splitRatio, gitPanelChangesOpen: changesOpen, gitPanelGraphOpen: graphOpen, expandToolResults: expandTools, terminalFontFamily: termFont, terminalFontSize: termSize, closeExplorerOnFileOpen: closeExplorer, openMarkdownInPreview: mdPreview, editorWordWrap: wordWrap, gitOpsMode, worktreeCompletionStrategy: wtStrategy, worktreeBranchDefaults: wtDefaults, worktreeSkipPrTitle: wtSkipPr, allowSettingsEdits: allowSettings, enableClaudeCompat: enableCompat, showTodoList: showTodo, aiGeneratedTitles: aiTitles, hideOnExternalLaunch: hideExternal, tabGroupMode: tabGroupMode as TabGroupMode, tabGroups, autoGroupOrder, stashedManualGroups, stashedManualTabAssignments, inProgressGroupId, doneGroupId, planningGroupId, autoGroupMovement, commitCommand, gitChangesTreeView: changesTreeView, keepExplorerOnCollapse: keepExplorer, keepTerminalOnCollapse: keepTerminal, keepGitPanelOnCollapse: keepGitPanel, defaultPermissionMode: permMode, quickTools, uiZoom, remoteEnabled, relayUrl, relayApiKey, lanServerPort, pairedDevices, engineDefaultModel, engineProfiles, preferredModel, defaultTallConversation, defaultTallTerminal, defaultTallEngine, tabRecoveryEnabled, tabRecoveryTimeoutSec })
    applyTheme(resolved)
    if (uiZoom !== 1) document.documentElement.style.zoom = String(uiZoom)
  })
}
