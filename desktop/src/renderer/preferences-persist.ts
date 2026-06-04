import type { TabGroup, TabGroupMode, QuickTool, RemotePairedDevice, EngineProfile } from '../shared/types'
import { DEFAULT_TAB_GROUP_LABELS } from '../shared/types'
import type { PreferencesState, ThemeMode } from './preferences-types'
import { SETTINGS_DEFAULTS } from './preferences-types'

export function saveSettings(s: Record<string, unknown>): void {
  window.ion?.saveSettings(s)
}

export function getAllSettings(get: () => PreferencesState): Record<string, unknown> {
  const s = get()
  return { themeMode: s.themeMode, selectedTheme: s.selectedTheme, soundEnabled: s.soundEnabled, expandedUI: s.expandedUI, ultraWide: s.ultraWide, defaultBaseDirectory: s.defaultBaseDirectory, recentBaseDirectories: s.recentBaseDirectories, directoryUsageCounts: s.directoryUsageCounts, preferredOpenWith: s.preferredOpenWith, defaultPermissionMode: s.defaultPermissionMode, expandOnTabSwitch: s.expandOnTabSwitch, bashCommandEntry: s.bashCommandEntry, gitPanelSplitRatio: s.gitPanelSplitRatio, gitPanelChangesOpen: s.gitPanelChangesOpen, gitPanelGraphOpen: s.gitPanelGraphOpen, expandToolResults: s.expandToolResults, terminalFontFamily: s.terminalFontFamily, terminalFontSize: s.terminalFontSize, closeExplorerOnFileOpen: s.closeExplorerOnFileOpen, openMarkdownInPreview: s.openMarkdownInPreview, editorWordWrap: s.editorWordWrap, editorFontSize: s.editorFontSize, gitOpsMode: s.gitOpsMode, worktreeCompletionStrategy: s.worktreeCompletionStrategy, worktreeBranchDefaults: s.worktreeBranchDefaults, worktreeSkipPrTitle: s.worktreeSkipPrTitle, allowSettingsEdits: s.allowSettingsEdits, enableClaudeCompat: s.enableClaudeCompat, enableEarlyStopContinuation: s.enableEarlyStopContinuation, showTodoList: s.showTodoList, agentPanelDefaultOpen: s.agentPanelDefaultOpen, agentDetailPopup: s.agentDetailPopup, unifiedTurnView: s.unifiedTurnView, aiGeneratedTitles: s.aiGeneratedTitles, hideOnExternalLaunch: s.hideOnExternalLaunch, keepExplorerOnCollapse: s.keepExplorerOnCollapse, keepTerminalOnCollapse: s.keepTerminalOnCollapse, keepGitPanelOnCollapse: s.keepGitPanelOnCollapse, tabGroupMode: s.tabGroupMode, tabGroups: s.tabGroups, autoGroupOrder: s.autoGroupOrder, stashedManualGroups: s.stashedManualGroups, stashedManualTabAssignments: s.stashedManualTabAssignments, inProgressGroupId: s.inProgressGroupId, doneGroupId: s.doneGroupId, planningGroupId: s.planningGroupId, autoGroupMovement: s.autoGroupMovement, commitCommand: s.commitCommand, gitChangesTreeView: s.gitChangesTreeView, quickTools: s.quickTools, uiZoom: s.uiZoom, remoteEnabled: s.remoteEnabled, relayUrl: s.relayUrl, relayApiKey: s.relayApiKey, lanServerPort: s.lanServerPort, pairedDevices: s.pairedDevices, remoteDisplay: s.remoteDisplay, engineDefaultModel: s.engineDefaultModel, engineProfiles: s.engineProfiles, preferredModel: s.preferredModel, defaultTallConversation: s.defaultTallConversation, defaultTallTerminal: s.defaultTallTerminal, defaultTallEngine: s.defaultTallEngine, tabRecoveryEnabled: s.tabRecoveryEnabled, tabRecoveryTimeoutSec: s.tabRecoveryTimeoutSec, planModelSplitEnabled: s.planModelSplitEnabled, planModeModel: s.planModeModel, implementModeModel: s.implementModeModel, planModeAllowedBashCommands: s.planModeAllowedBashCommands, showImplementClearContext: s.showImplementClearContext }
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
    const editorFontSize = typeof disk.editorFontSize === 'number' ? Math.max(8, Math.min(24, Math.round(disk.editorFontSize))) : 12
    const gitOpsMode = (disk.gitOpsMode === 'manual' || disk.gitOpsMode === 'worktree') ? disk.gitOpsMode : 'manual'
    const wtStrategy = (disk.worktreeCompletionStrategy === 'merge-ff' || disk.worktreeCompletionStrategy === 'merge' || disk.worktreeCompletionStrategy === 'pr') ? disk.worktreeCompletionStrategy : 'merge-ff'
    const wtDefaults = (disk.worktreeBranchDefaults && typeof disk.worktreeBranchDefaults === 'object' && !Array.isArray(disk.worktreeBranchDefaults)) ? disk.worktreeBranchDefaults as Record<string, string> : {}
    const wtSkipPr = typeof disk.worktreeSkipPrTitle === 'boolean' ? disk.worktreeSkipPrTitle : false
    const allowSettings = typeof disk.allowSettingsEdits === 'boolean' ? disk.allowSettingsEdits : false
    const enableCompat = typeof disk.enableClaudeCompat === 'boolean' ? disk.enableClaudeCompat : true
    const enableEarlyStop = typeof disk.enableEarlyStopContinuation === 'boolean' ? disk.enableEarlyStopContinuation : false
    const showTodo = typeof disk.showTodoList === 'boolean' ? disk.showTodoList : true
    const agentPanelDefaultOpen = typeof disk.agentPanelDefaultOpen === 'boolean' ? disk.agentPanelDefaultOpen : true
    const agentDetailPopup = typeof disk.agentDetailPopup === 'boolean' ? disk.agentDetailPopup : true
    const unifiedTurnView = typeof disk.unifiedTurnView === 'boolean' ? disk.unifiedTurnView : true
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
    const remoteDisplay = (disk.remoteDisplay && typeof disk.remoteDisplay === 'object' && !Array.isArray(disk.remoteDisplay))
      ? {
          customName: typeof (disk.remoteDisplay as any).customName === 'string' && (disk.remoteDisplay as any).customName.trim().length > 0
            ? (disk.remoteDisplay as any).customName.trim()
            : null,
          customIcon: typeof (disk.remoteDisplay as any).customIcon === 'string'
            ? (disk.remoteDisplay as any).customIcon
            : null,
          updatedAt: typeof (disk.remoteDisplay as any).updatedAt === 'number'
            ? (disk.remoteDisplay as any).updatedAt
            : 0,
        }
      : null
    const engineDefaultModel = typeof disk.engineDefaultModel === 'string' ? disk.engineDefaultModel : ''
    const preferredModel = typeof disk.preferredModel === 'string' && disk.preferredModel ? disk.preferredModel : 'claude-opus-4-6'
    const engineProfiles: EngineProfile[] = Array.isArray(disk.engineProfiles) ? (disk.engineProfiles as any[]).filter((p: any) => p && typeof p.id === 'string' && typeof p.name === 'string') : []
    const defaultTallConversation = typeof disk.defaultTallConversation === 'boolean' ? disk.defaultTallConversation : false
    const defaultTallTerminal = typeof disk.defaultTallTerminal === 'boolean' ? disk.defaultTallTerminal : false
    const defaultTallEngine = typeof disk.defaultTallEngine === 'boolean' ? disk.defaultTallEngine : false
    const tabRecoveryEnabled = typeof disk.tabRecoveryEnabled === 'boolean' ? disk.tabRecoveryEnabled : true
    const tabRecoveryTimeoutSec = typeof disk.tabRecoveryTimeoutSec === 'number' ? Math.max(30, Math.min(600, Math.round(disk.tabRecoveryTimeoutSec))) : 120
    const planModelSplitEnabled = typeof disk.planModelSplitEnabled === 'boolean' ? disk.planModelSplitEnabled : false
    const planModeModel = typeof disk.planModeModel === 'string' ? disk.planModeModel : ''
    const implementModeModel = typeof disk.implementModeModel === 'string' ? disk.implementModeModel : ''
    // planModeAllowedBashCommands: list of command prefixes the engine
    // gates Bash against during plan mode. Token-based matching (see
    // engine runloop_tools.go). Default ['gh'] so the common case (plan
    // a PR review) works out of the box; users add 'git log', 'git diff',
    // etc. via the BashAllowlistEditor.
    const planBashCmds = Array.isArray(disk.planModeAllowedBashCommands)
      ? (disk.planModeAllowedBashCommands as unknown[]).filter((c): c is string => typeof c === 'string')
      : ['gh']
    // selectedTheme: theme-registry id (Persisted in disk JSON). Falls
    // back to the default ion-dark theme when the saved id is unknown
    // or malformed; theme registry handles unknown-id graceful render.
    const selectedTheme = typeof disk.selectedTheme === 'string' && disk.selectedTheme ? disk.selectedTheme : 'ion-dark'
    // showImplementClearContext: reveals a "Implement, clear context"
    // button on the plan-approval card. Default false — the regular
    // Implement button preserves the conversation; users opt into the
    // extra clear-context action per-plan. The reset behavior is not a
    // global toggle.
    const showImplementClearContext = typeof disk.showImplementClearContext === 'boolean' ? disk.showImplementClearContext : false
    setState({ themeMode: mode, selectedTheme, isDark: resolved, soundEnabled: sound, expandedUI: expanded, ultraWide, defaultBaseDirectory: baseDir, recentBaseDirectories: recentDirs, directoryUsageCounts: dirUsageCounts, preferredOpenWith: openWith, expandOnTabSwitch: expandTabSwitch, bashCommandEntry: bashCmd, gitPanelSplitRatio: splitRatio, gitPanelChangesOpen: changesOpen, gitPanelGraphOpen: graphOpen, expandToolResults: expandTools, terminalFontFamily: termFont, terminalFontSize: termSize, editorFontSize, closeExplorerOnFileOpen: closeExplorer, openMarkdownInPreview: mdPreview, editorWordWrap: wordWrap, gitOpsMode, worktreeCompletionStrategy: wtStrategy, worktreeBranchDefaults: wtDefaults, worktreeSkipPrTitle: wtSkipPr, allowSettingsEdits: allowSettings, enableClaudeCompat: enableCompat, enableEarlyStopContinuation: enableEarlyStop, showTodoList: showTodo, agentPanelDefaultOpen, agentDetailPopup, unifiedTurnView, aiGeneratedTitles: aiTitles, hideOnExternalLaunch: hideExternal, tabGroupMode: tabGroupMode as TabGroupMode, tabGroups, autoGroupOrder, stashedManualGroups, stashedManualTabAssignments, inProgressGroupId, doneGroupId, planningGroupId, autoGroupMovement, commitCommand, gitChangesTreeView: changesTreeView, keepExplorerOnCollapse: keepExplorer, keepTerminalOnCollapse: keepTerminal, keepGitPanelOnCollapse: keepGitPanel, defaultPermissionMode: permMode, quickTools, uiZoom, remoteEnabled, relayUrl, relayApiKey, lanServerPort, pairedDevices, remoteDisplay, engineDefaultModel, engineProfiles, preferredModel, defaultTallConversation, defaultTallTerminal, defaultTallEngine, tabRecoveryEnabled, tabRecoveryTimeoutSec, planModelSplitEnabled, planModeModel, implementModeModel, planModeAllowedBashCommands: planBashCmds, showImplementClearContext })
    applyTheme(resolved)
    if (uiZoom !== 1) document.documentElement.style.zoom = String(uiZoom)
  })
}
