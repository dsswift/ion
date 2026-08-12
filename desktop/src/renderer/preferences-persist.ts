import type { TabGroup, TabGroupMode, QuickTool, RemotePairedDevice, EngineProfile, ThinkingEffort } from '../shared/types'
import { DEFAULT_TAB_GROUP_LABELS } from '../shared/types'
import type { PreferencesState } from './preferences-types'
import { SETTINGS_DEFAULTS } from './preferences-types'
import { isThinkingEffort } from '../shared/thinking-options'
import { isAiAssistWorkflowId, type AiAssistWorkflowId } from '../shared/ai-assist-workflows'
import { rError, rInfo } from './rendererLogger'
import { sanitizeRecentDirectories } from '../shared/recent-directories'

export function saveSettings(s: Record<string, unknown>): void {
  window.ion?.saveSettings(s)?.catch((err) => rError('preferences', 'saveSettings failed; user settings not persisted', { error: String(err) }))
}

export function getAllSettings(get: () => PreferencesState): Record<string, unknown> {
  const s = get()
  return { selectedTheme: s.selectedTheme, soundEnabled: s.soundEnabled, expandedUI: s.expandedUI, ultraWide: s.ultraWide, defaultBaseDirectory: s.defaultBaseDirectory, recentBaseDirectories: s.recentBaseDirectories, directoryUsageCounts: s.directoryUsageCounts, defaultPermissionMode: s.defaultPermissionMode, expandOnTabSwitch: s.expandOnTabSwitch, bashCommandEntry: s.bashCommandEntry, gitPanelPaneProportions: s.gitPanelPaneProportions, gitPanelHeight: s.gitPanelHeight, fileExplorerHeight: s.fileExplorerHeight, gitPanelChangesOpen: s.gitPanelChangesOpen, gitPanelGraphOpen: s.gitPanelGraphOpen, gitPanelWorktreesOpen: s.gitPanelWorktreesOpen, expandToolResults: s.expandToolResults, terminalFontFamily: s.terminalFontFamily, terminalFontSize: s.terminalFontSize, closeExplorerOnFileOpen: s.closeExplorerOnFileOpen, openMarkdownInPreview: s.openMarkdownInPreview, editorWordWrap: s.editorWordWrap, editorFontSize: s.editorFontSize, conversationFontSize: s.conversationFontSize, previewFontSize: s.previewFontSize, gitOpsMode: s.gitOpsMode, worktreeCompletionStrategy: s.worktreeCompletionStrategy, worktreeBranchDefaults: s.worktreeBranchDefaults, worktreeSkipPrTitle: s.worktreeSkipPrTitle, allowSettingsEdits: s.allowSettingsEdits, enableClaudeCompat: s.enableClaudeCompat, enableEarlyStopContinuation: s.enableEarlyStopContinuation, showTodoList: s.showTodoList, agentPanelDefaultOpen: s.agentPanelDefaultOpen, unifiedTurnView: s.unifiedTurnView, aiGeneratedTitles: s.aiGeneratedTitles, hideOnExternalLaunch: s.hideOnExternalLaunch, keepExplorerOnCollapse: s.keepExplorerOnCollapse, keepTerminalOnCollapse: s.keepTerminalOnCollapse, keepGitPanelOnCollapse: s.keepGitPanelOnCollapse, keepStatusDrawerOnCollapse: s.keepStatusDrawerOnCollapse, tabGroupMode: s.tabGroupMode, tabGroups: s.tabGroups, autoGroupOrder: s.autoGroupOrder, stashedManualGroups: s.stashedManualGroups, stashedManualTabAssignments: s.stashedManualTabAssignments, inProgressGroupId: s.inProgressGroupId, doneGroupId: s.doneGroupId, planningGroupId: s.planningGroupId, autoGroupMovement: s.autoGroupMovement, commitCommand: s.commitCommand, aiAssistPromptOverrides: s.aiAssistPromptOverrides, gitChangesTreeView: s.gitChangesTreeView, quickTools: s.quickTools, uiZoom: s.uiZoom, remoteEnabled: s.remoteEnabled, relayUrl: s.relayUrl, relayApiKey: s.relayApiKey, lanServerPort: s.lanServerPort, pairedDevices: s.pairedDevices, streamThinkingToRemote: s.streamThinkingToRemote, defaultThinkingEffort: s.defaultThinkingEffort, remoteDisplay: s.remoteDisplay, engineDefaultModel: s.engineDefaultModel, defaultEngineProfileId: s.defaultEngineProfileId, engineProfiles: s.engineProfiles, preferredModel: s.preferredModel, defaultTallConversation: s.defaultTallConversation, defaultTallTerminal: s.defaultTallTerminal, tabRecoveryEnabled: s.tabRecoveryEnabled, tabRecoveryTimeoutSec: s.tabRecoveryTimeoutSec, planModelSplitEnabled: s.planModelSplitEnabled, planModeModel: s.planModeModel, implementModeModel: s.implementModeModel, showImplementClearContext: s.showImplementClearContext, gitWatcherIgnoredDirectories: s.gitWatcherIgnoredDirectories, excludedResourceKinds: s.excludedResourceKinds, keyboardShortcuts: s.keyboardShortcuts }
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
  applyTheme: (themeId: string) => void,
): void {
  window.ion?.loadSettings().then((disk) => {
    if (!disk) return
    const sound = typeof disk.soundEnabled === 'boolean' ? disk.soundEnabled : true
    const expanded = typeof disk.expandedUI === 'boolean' ? disk.expandedUI : false
    const ultraWide = typeof disk.ultraWide === 'boolean' ? disk.ultraWide : false
    const baseDir = typeof disk.defaultBaseDirectory === 'string' ? disk.defaultBaseDirectory : ''
    const persistedRecentDirs = Array.isArray(disk.recentBaseDirectories) ? disk.recentBaseDirectories.filter((d: unknown) => typeof d === 'string').slice(0, 12) : []
    const persistedDirUsageCounts = (disk.directoryUsageCounts && typeof disk.directoryUsageCounts === 'object' && !Array.isArray(disk.directoryUsageCounts)) ? Object.fromEntries(Object.entries(disk.directoryUsageCounts as Record<string, unknown>).filter(([k, v]) => typeof k === 'string' && typeof v === 'number')) as Record<string, number> : {}
    // Worktrees and benches are rebuildable Ion-managed workspace paths, not
    // user projects. Migrate legacy records during hydration, including their
    // usage counters, so a retired workspace cannot return after restart.
    const sanitizedRecents = sanitizeRecentDirectories(persistedRecentDirs, persistedDirUsageCounts)
    const recentDirs = sanitizedRecents.directories
    const dirUsageCounts = sanitizedRecents.usageCounts
    const expandTabSwitch = typeof disk.expandOnTabSwitch === 'boolean' ? disk.expandOnTabSwitch : true
    const bashCmd = typeof disk.bashCommandEntry === 'boolean' ? disk.bashCommandEntry : false
    // Pane proportions replaced the single Changes-vs-Graph ratio. A disk value
    // written by an older build carries only that scalar, which describes a
    // two-pane split that no longer exists — so it is not migrated: an empty
    // map means "equal shares", which is the right starting point for four
    // panes. Anything non-object (including the legacy number) is discarded.
    const paneProportions = (disk.gitPanelPaneProportions && typeof disk.gitPanelPaneProportions === 'object' && !Array.isArray(disk.gitPanelPaneProportions))
      ? disk.gitPanelPaneProportions as Record<string, number>
      : {}
    // Panel heights: a positive finite number or null (use the default). The
    // render path re-clamps against the live window height, so no ceiling is
    // enforced here — a height saved on a larger display degrades gracefully.
    const gitPanelHeight = (typeof disk.gitPanelHeight === 'number' && Number.isFinite(disk.gitPanelHeight) && disk.gitPanelHeight > 0) ? disk.gitPanelHeight : null
    const fileExplorerHeight = (typeof disk.fileExplorerHeight === 'number' && Number.isFinite(disk.fileExplorerHeight) && disk.fileExplorerHeight > 0) ? disk.fileExplorerHeight : null
    const changesOpen = typeof disk.gitPanelChangesOpen === 'boolean' ? disk.gitPanelChangesOpen : true
    const graphOpen = typeof disk.gitPanelGraphOpen === 'boolean' ? disk.gitPanelGraphOpen : true
    // Default OPEN: the section's whole purpose is discoverability, and an
    // operator who does not know it exists cannot open it.
    const worktreesOpen = typeof disk.gitPanelWorktreesOpen === 'boolean' ? disk.gitPanelWorktreesOpen : true
    const expandTools = typeof disk.expandToolResults === 'boolean' ? disk.expandToolResults : false
    const termFont = typeof disk.terminalFontFamily === 'string' ? disk.terminalFontFamily : 'Menlo, Monaco, monospace'
    const termSize = typeof disk.terminalFontSize === 'number' ? disk.terminalFontSize : 13
    const closeExplorer = typeof disk.closeExplorerOnFileOpen === 'boolean' ? disk.closeExplorerOnFileOpen : true
    const mdPreview = typeof disk.openMarkdownInPreview === 'boolean' ? disk.openMarkdownInPreview : true
    const wordWrap = typeof disk.editorWordWrap === 'boolean' ? disk.editorWordWrap : true
    const editorFontSize = typeof disk.editorFontSize === 'number' ? Math.max(8, Math.min(24, Math.round(disk.editorFontSize))) : 12
    const conversationFontSize = typeof disk.conversationFontSize === 'number' ? Math.max(8, Math.min(24, Math.round(disk.conversationFontSize))) : 13
    const previewFontSize = typeof disk.previewFontSize === 'number' ? Math.max(8, Math.min(24, Math.round(disk.previewFontSize))) : 13
    const gitOpsMode = (disk.gitOpsMode === 'manual' || disk.gitOpsMode === 'worktree') ? disk.gitOpsMode : 'manual'
    const wtStrategy = (disk.worktreeCompletionStrategy === 'merge-ff' || disk.worktreeCompletionStrategy === 'merge' || disk.worktreeCompletionStrategy === 'pr') ? disk.worktreeCompletionStrategy : 'merge-ff'
    const wtDefaults = (disk.worktreeBranchDefaults && typeof disk.worktreeBranchDefaults === 'object' && !Array.isArray(disk.worktreeBranchDefaults)) ? disk.worktreeBranchDefaults as Record<string, string> : {}
    const wtSkipPr = typeof disk.worktreeSkipPrTitle === 'boolean' ? disk.worktreeSkipPrTitle : false
    const allowSettings = typeof disk.allowSettingsEdits === 'boolean' ? disk.allowSettingsEdits : false
    const enableCompat = typeof disk.enableClaudeCompat === 'boolean' ? disk.enableClaudeCompat : false
    const enableEarlyStop = typeof disk.enableEarlyStopContinuation === 'boolean' ? disk.enableEarlyStopContinuation : false
    const showTodo = typeof disk.showTodoList === 'boolean' ? disk.showTodoList : true
    const agentPanelDefaultOpen = typeof disk.agentPanelDefaultOpen === 'boolean' ? disk.agentPanelDefaultOpen : true
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
    const aiAssistPromptOverrides = (disk.aiAssistPromptOverrides && typeof disk.aiAssistPromptOverrides === 'object' && !Array.isArray(disk.aiAssistPromptOverrides))
      ? Object.fromEntries(Object.entries(disk.aiAssistPromptOverrides as Record<string, unknown>)
          .filter(([id, prompt]) => isAiAssistWorkflowId(id) && typeof prompt === 'string' && prompt.trim().length > 0)) as Partial<Record<AiAssistWorkflowId, string>>
      : {}
    const changesTreeView = typeof disk.gitChangesTreeView === 'boolean' ? disk.gitChangesTreeView : false
    const keepExplorer = typeof disk.keepExplorerOnCollapse === 'boolean' ? disk.keepExplorerOnCollapse : false
    const keepTerminal = typeof disk.keepTerminalOnCollapse === 'boolean' ? disk.keepTerminalOnCollapse : false
    const keepGitPanel = typeof disk.keepGitPanelOnCollapse === 'boolean' ? disk.keepGitPanelOnCollapse : false
    const keepStatusDrawer = typeof disk.keepStatusDrawerOnCollapse === 'boolean' ? disk.keepStatusDrawerOnCollapse : false
    const permMode = (disk.defaultPermissionMode === 'auto' || disk.defaultPermissionMode === 'plan') ? disk.defaultPermissionMode : 'plan'
    const quickTools = Array.isArray(disk.quickTools) ? (disk.quickTools as QuickTool[]).filter((t: any) => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.command === 'string') : []
    const uiZoom = typeof disk.uiZoom === 'number' ? Math.round(Math.max(0.5, Math.min(2.0, disk.uiZoom)) * 10) / 10 : 1
    const remoteEnabled = typeof disk.remoteEnabled === 'boolean' ? disk.remoteEnabled : false
    const relayUrl = typeof disk.relayUrl === 'string' ? disk.relayUrl : ''
    const relayApiKey = typeof disk.relayApiKey === 'string' ? disk.relayApiKey : ''
    const lanServerPort = typeof disk.lanServerPort === 'number' ? disk.lanServerPort : 19837
    const pairedDevices = Array.isArray(disk.pairedDevices) ? (disk.pairedDevices as RemotePairedDevice[]).filter((d: any) => d && typeof d.id === 'string' && typeof d.name === 'string') : []
    // streamThinkingToRemote: when on, the desktop forwards the engine's
    // per-token thinking_delta stream to remote clients (iOS); when off,
    // only the block boundaries are forwarded (low-bandwidth projection).
    // Default true.
    const streamThinkingToRemote = typeof disk.streamThinkingToRemote === 'boolean' ? disk.streamThinkingToRemote : true
    // defaultThinkingEffort: level a NEW conversation's thinking control starts
    // at. Validated through the SHARED ladder guard rather than an inline list,
    // so this validator cannot fall behind the ThinkingEffort union when a rung
    // is added — an inline list here silently rewrote a saved 'xhigh'/'max' to
    // 'high' on the next launch, and the following save wrote that back to disk.
    // 'adaptive' is deliberately excluded (matching readDefaultThinkingEffort in
    // main/settings-store.ts): this preference seeds effort-based models, while
    // adaptive models derive their own default from capability metadata via
    // defaultEffortForMode. Default 'high'.
    const defaultThinkingEffort: ThinkingEffort =
      (isThinkingEffort(disk.defaultThinkingEffort) && disk.defaultThinkingEffort !== 'adaptive')
        ? disk.defaultThinkingEffort
        : 'high'
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
    const defaultEngineProfileId = typeof disk.defaultEngineProfileId === 'string' ? disk.defaultEngineProfileId : ''
    const preferredModel = typeof disk.preferredModel === 'string' && disk.preferredModel ? disk.preferredModel : 'claude-opus-4-6'
    const engineProfiles: EngineProfile[] = Array.isArray(disk.engineProfiles) ? (disk.engineProfiles as any[]).filter((p: any) => p && typeof p.id === 'string' && typeof p.name === 'string') : []
    // Migration: the engine-specific tall default was collapsed into the single
    // defaultTallConversation (every conversation tab — plain or extension-backed
    // — shares one tall default). Carry a legacy disk.defaultTallEngine=true
    // forward by OR-ing it in, so a user who had engine-tall on keeps tall.
    const legacyDefaultTallEngine = typeof disk.defaultTallEngine === 'boolean' ? disk.defaultTallEngine : false
    const defaultTallConversation = (typeof disk.defaultTallConversation === 'boolean' ? disk.defaultTallConversation : false) || legacyDefaultTallEngine
    const defaultTallTerminal = typeof disk.defaultTallTerminal === 'boolean' ? disk.defaultTallTerminal : false
    const tabRecoveryEnabled = typeof disk.tabRecoveryEnabled === 'boolean' ? disk.tabRecoveryEnabled : true
    const tabRecoveryTimeoutSec = typeof disk.tabRecoveryTimeoutSec === 'number' ? Math.max(30, Math.min(600, Math.round(disk.tabRecoveryTimeoutSec))) : 120
    const planModelSplitEnabled = typeof disk.planModelSplitEnabled === 'boolean' ? disk.planModelSplitEnabled : false
    const planModeModel = typeof disk.planModeModel === 'string' ? disk.planModeModel : ''
    const implementModeModel = typeof disk.implementModeModel === 'string' ? disk.implementModeModel : ''
    // gitWatcherIgnoredDirectories: paths where the git file watcher is
    // suppressed. An explicit empty array means "watch everywhere". Falls back
    // to the default ['~/.ion'] when the key is absent or not an array.
    const gitWatcherIgnoredDirs = Array.isArray(disk.gitWatcherIgnoredDirectories)
      ? (disk.gitWatcherIgnoredDirectories as unknown[]).filter((v): v is string => typeof v === 'string')
      : ['~/.ion']
    // excludedResourceKinds: kinds the user hid from the global notification
    // tray. Blocklist — an absent key or non-array means "exclude nothing"
    // (default []), so every kind shows. Conversation-scoped resources are
    // unaffected; they always render in the attachments panel.
    const excludedResourceKinds = Array.isArray(disk.excludedResourceKinds)
      ? (disk.excludedResourceKinds as unknown[]).filter((v): v is string => typeof v === 'string')
      : []
    // selectedTheme: theme-registry id (Persisted in disk JSON). Falls
    // back to the default ion-dark theme when the saved id is unknown
    // or malformed; theme registry handles unknown-id graceful render.
    // selectedTheme is the single theme control. Legacy saves (pre theme-
    // picker-only UX) may lack it but carry the retired themeMode toggle
    // value — honor a saved light mode by migrating to ion-light once.
    const selectedTheme = typeof disk.selectedTheme === 'string' && disk.selectedTheme
      ? disk.selectedTheme
      : disk.themeMode === 'light' ? 'ion-light' : 'ion-dark'
    // showImplementClearContext: reveals a "Implement, clear context"
    // button on the plan-approval card. Default false — the regular
    // Implement button preserves the conversation; users opt into the
    // extra clear-context action per-plan. The reset behavior is not a
    // global toggle.
    const showImplementClearContext = typeof disk.showImplementClearContext === 'boolean' ? disk.showImplementClearContext : false
    // keyboardShortcuts: user overrides (command id -> chord string).
    // Only non-default entries are stored. On load: must be an object
    // of string->string; drop any malformed entries; ignore unknown ids
    // (tolerant load — a stale or forward config doesn't crash).
    const keyboardShortcuts = (disk.keyboardShortcuts && typeof disk.keyboardShortcuts === 'object' && !Array.isArray(disk.keyboardShortcuts))
      ? Object.fromEntries(Object.entries(disk.keyboardShortcuts as Record<string, unknown>).filter(([k, v]) => typeof k === 'string' && typeof v === 'string')) as Record<string, string>
      : {}
    setState({ selectedTheme, soundEnabled: sound, expandedUI: expanded, ultraWide, defaultBaseDirectory: baseDir, recentBaseDirectories: recentDirs, directoryUsageCounts: dirUsageCounts, expandOnTabSwitch: expandTabSwitch, bashCommandEntry: bashCmd, gitPanelPaneProportions: paneProportions, gitPanelHeight, fileExplorerHeight, gitPanelChangesOpen: changesOpen, gitPanelGraphOpen: graphOpen, gitPanelWorktreesOpen: worktreesOpen, expandToolResults: expandTools, terminalFontFamily: termFont, terminalFontSize: termSize, editorFontSize, conversationFontSize, previewFontSize, closeExplorerOnFileOpen: closeExplorer, openMarkdownInPreview: mdPreview, editorWordWrap: wordWrap, gitOpsMode, worktreeCompletionStrategy: wtStrategy, worktreeBranchDefaults: wtDefaults, worktreeSkipPrTitle: wtSkipPr, allowSettingsEdits: allowSettings, enableClaudeCompat: enableCompat, enableEarlyStopContinuation: enableEarlyStop, showTodoList: showTodo, agentPanelDefaultOpen, unifiedTurnView, aiGeneratedTitles: aiTitles, hideOnExternalLaunch: hideExternal, tabGroupMode: tabGroupMode as TabGroupMode, tabGroups, autoGroupOrder, stashedManualGroups, stashedManualTabAssignments, inProgressGroupId, doneGroupId, planningGroupId, autoGroupMovement, commitCommand, aiAssistPromptOverrides, gitChangesTreeView: changesTreeView, keepExplorerOnCollapse: keepExplorer, keepTerminalOnCollapse: keepTerminal, keepGitPanelOnCollapse: keepGitPanel, keepStatusDrawerOnCollapse: keepStatusDrawer, defaultPermissionMode: permMode, quickTools, uiZoom, remoteEnabled, relayUrl, relayApiKey, lanServerPort, pairedDevices, streamThinkingToRemote, defaultThinkingEffort, remoteDisplay, engineDefaultModel, defaultEngineProfileId, engineProfiles, preferredModel, defaultTallConversation, defaultTallTerminal, tabRecoveryEnabled, tabRecoveryTimeoutSec, planModelSplitEnabled, planModeModel, implementModeModel, showImplementClearContext, gitWatcherIgnoredDirectories: gitWatcherIgnoredDirs, excludedResourceKinds, keyboardShortcuts })
    if (sanitizedRecents.removed) {
      saveSettings(getAllSettings(getState))
      rInfo('preferences', 'removed ephemeral workspaces from persisted recent directories', {
        removed_directory_count: persistedRecentDirs.length - recentDirs.length,
      })
    }
    applyTheme(selectedTheme)
    if (uiZoom !== 1) document.documentElement.style.zoom = String(uiZoom)
  })?.catch((err) => rError('preferences', 'loadSettings failed; using in-memory defaults', { error: String(err) }))
}
