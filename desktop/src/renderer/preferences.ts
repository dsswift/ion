import { useSyncExternalStore } from 'react'
import { create, type StateCreator } from 'zustand'
import { applyTheme, getThemeRegistryVersion, onThemeRegistryChanged, resolveColors, type ColorPalette } from './theme-tokens'
import type { PreferencesState } from '@ion/server/preferences-types'
import { saveSettings, saveSettingsFor, settingsTargetOf, persist, INITIAL_SAVED } from './preferences-persist'
import { dropSealedSettings } from './settings-policy'
import { resolveSettingMutability } from '@ion/shared/enterprise-settings-policy'
import { bootstrapPreferences } from './preferences-bootstrap'
import { createKeyboardShortcutActions } from './preferences-shortcuts'
import { resolveEffectiveThemeId } from '@ion/shared/enterprise-theme-policy'
import { normalizePreferencesModels } from './preferences-model-normalization'
import { rInfo, rWarn } from './rendererLogger'
import { isEphemeralWorkspaceDirectory } from '@ion/shared/recent-directories'
import { clampFontSize, clampUiZoom } from './typography'
import { createWorkspaceFolderActions, createInboxPreferenceActions, createProjectRegistryActions } from './preferences-workspace'
export type { PreferencesState } from '@ion/server/preferences-types'

const saved = INITIAL_SAVED
const _savedThemeId = localStorage.getItem('ion_selectedTheme') ?? 'ion-dark'

/**
 * Trailing-edge save for the panel-height setters. usePanelVerticalResize
 * commits on every mousemove frame so the edge tracks the cursor; writing
 * ~/.ion/settings.json per frame would turn one drag into hundreds of
 * atomic file writes. The store updates synchronously above; the disk write
 * fires once, shortly after the drag goes quiet.
 *
 * Accumulates the patch across the debounce window (both height setters
 * share one timer) and sends only those fields -- never the full snapshot,
 * which would freeze every other in-memory field into this identity's
 * overlay too. See persist()'s doc comment.
 */
let panelHeightSaveTimer: ReturnType<typeof setTimeout> | null = null
let pendingPanelHeightPatch: Partial<PreferencesState> = {}
function schedulePanelHeightSave(patch: Partial<PreferencesState>): void {
  pendingPanelHeightPatch = { ...pendingPanelHeightPatch, ...patch }
  if (panelHeightSaveTimer !== null) clearTimeout(panelHeightSaveTimer)
  panelHeightSaveTimer = setTimeout(() => {
    panelHeightSaveTimer = null
    const toSave = pendingPanelHeightPatch
    pendingPanelHeightPatch = {}
    saveSettings(toSave)
  }, 400)
}

/**
 * The preference store's state and actions. Exported so Settings can build a
 * second instance bound to another server (components/settings/
 * settings-target.ts); the app-wide instance is `usePreferencesStore` below.
 */
export const createPreferencesState: StateCreator<PreferencesState> = (set, get) => ({
  selectedTheme: _savedThemeId,
  soundEnabled: saved.soundEnabled,
  defaultBaseDirectory: saved.defaultBaseDirectory,
  recentBaseDirectories: saved.recentBaseDirectories,
  directoryUsageCounts: saved.directoryUsageCounts,
  defaultPermissionMode: saved.defaultPermissionMode,
  browserPreviewNetworkShield: saved.browserPreviewNetworkShield,
  openAtLogin: saved.openAtLogin,
  studioPlaywrightEnabled: saved.studioPlaywrightEnabled,
  studioSurfaceSwitchMode: saved.studioSurfaceSwitchMode,
  bashCommandEntry: saved.bashCommandEntry,
  gitPanelPaneProportions: saved.gitPanelPaneProportions,
  gitPanelHeight: saved.gitPanelHeight,
  fileExplorerHeight: saved.fileExplorerHeight,
  gitPanelChangesOpen: saved.gitPanelChangesOpen,
  gitPanelGraphOpen: saved.gitPanelGraphOpen,
  expandToolResults: saved.expandToolResults,
  terminalFontFamily: saved.terminalFontFamily,
  terminalFontSize: saved.terminalFontSize,
  showHiddenFiles: saved.showHiddenFiles,
  openMarkdownInPreview: saved.openMarkdownInPreview,
  editorWordWrap: saved.editorWordWrap,
  editorFontSize: saved.editorFontSize,
  dataViewFontSize: saved.dataViewFontSize,
  gitOpsMode: saved.gitOpsMode,
  worktreeCompletionStrategy: saved.worktreeCompletionStrategy,
  worktreeBranchDefaults: saved.worktreeBranchDefaults,
  worktreeSkipPrTitle: saved.worktreeSkipPrTitle,
  allowSettingsEdits: saved.allowSettingsEdits,
  pushConversationTitles: saved.pushConversationTitles,
  enableClaudeCompat: saved.enableClaudeCompat ?? false,
  enableEarlyStopContinuation: saved.enableEarlyStopContinuation ?? false,
  showTodoList: saved.showTodoList,
  agentPanelDefaultOpen: saved.agentPanelDefaultOpen,
  unifiedTurnView: saved.unifiedTurnView,
  aiGeneratedTitles: saved.aiGeneratedTitles,
  commitCommand: saved.commitCommand,
  aiAssistPromptOverrides: saved.aiAssistPromptOverrides,
  gitChangesTreeView: saved.gitChangesTreeView,
  quickTools: saved.quickTools,
  uiZoom: saved.uiZoom,
    relayUrl: saved.relayUrl,
  relayApiKey: saved.relayApiKey,
    pairedDevices: saved.pairedDevices,
  streamThinkingToRemote: saved.streamThinkingToRemote,
  defaultThinkingEffort: saved.defaultThinkingEffort,
  remoteDisplay: saved.remoteDisplay,
  engineDefaultModel: saved.engineDefaultModel,
  engineProfiles: saved.engineProfiles,
  preferredModel: saved.preferredModel,
  defaultEngineProfileId: saved.defaultEngineProfileId,
  // Enterprise policy: starts null, loaded from engine at startup.
  enterpriseNewConversationDefaults: null,
  enterprisePolicy: null,
  tabRecoveryEnabled: saved.tabRecoveryEnabled,
  tabRecoveryTimeoutSec: saved.tabRecoveryTimeoutSec,
  planModelSplitEnabled: saved.planModelSplitEnabled,
  planModeModel: saved.planModeModel,
  implementModeModel: saved.implementModeModel,
  showImplementClearContext: saved.showImplementClearContext,
  gitWatcherIgnoredDirectories: saved.gitWatcherIgnoredDirectories,
  workspaceFolders: saved.workspaceFolders,
  gitPanelRepoSectionsCollapsed: saved.gitPanelRepoSectionsCollapsed,
  inboxAutoSettleDays: saved.inboxAutoSettleDays,
  usageLimitAutoResume: saved.usageLimitAutoResume,
  usageLimitResumePrompt: saved.usageLimitResumePrompt,
  quotaExpiryAlertHours: saved.quotaExpiryAlertHours,
  quotaExpiryUnusedPercent: saved.quotaExpiryUnusedPercent,
  projectSettingsVersion: saved.projectSettingsVersion,
  projects: saved.projects,
  excludedResourceKinds: saved.excludedResourceKinds,
  keyboardShortcuts: saved.keyboardShortcuts,
  setTabRecoveryEnabled: (enabled) => persist(set, { tabRecoveryEnabled: enabled }),
  setTabRecoveryTimeoutSec: (sec) => {
    const clamped = Math.max(30, Math.min(600, Math.round(sec)))
    persist(set, { tabRecoveryTimeoutSec: clamped })
  },
  // Theme selection is the single control: every built-in theme declares
  // its own color scheme, so picking a theme fully determines the look.
  // Enterprise lock: a locked themePolicy makes theme selection read-only
  // (the Settings theme picker is disabled; this guard is the
  // belt-and-suspenders for programmatic callers and iOS-originated
  // settings pushes, mirroring the main-process write-funnel strip).
  setSelectedTheme: (id) => {
    const mutability = resolveSettingMutability(get().enterprisePolicy, 'selectedTheme')
    if (mutability.class === 'sealed' && !(mutability.hasValue && id === mutability.value)) {
      rWarn('preferences', 'setSelectedTheme rejected by enterprise lock', {
        attempted: id,
        enforced: mutability.hasValue ? String(mutability.value) : null,
      })
      return
    }
    localStorage.setItem('ion_selectedTheme', id)
    persist(set, { selectedTheme: id })
    applyTheme(id)
  },
  setSoundEnabled: (enabled) => persist(set, { soundEnabled: enabled }),
  setDefaultBaseDirectory: (dir) => persist(set, { defaultBaseDirectory: dir }),
  addRecentBaseDirectory: (dir) => {
    if (isEphemeralWorkspaceDirectory(dir)) {
      rInfo('preferences', 'ephemeral workspace excluded from recent directories', { directory: dir })
      return
    }
    const current = get().recentBaseDirectories.filter((d) => d !== dir)
    const updated = [dir, ...current].slice(0, 12)
    const counts = { ...get().directoryUsageCounts, [dir]: (get().directoryUsageCounts[dir] || 0) + 1 }
    persist(set, { recentBaseDirectories: updated, directoryUsageCounts: counts })
  },
  removeRecentBaseDirectory: (dir) => {
    const updated = get().recentBaseDirectories.filter((d) => d !== dir)
    const counts = { ...get().directoryUsageCounts }
    delete counts[dir]
    persist(set, { recentBaseDirectories: updated, directoryUsageCounts: counts })
  },
  setDefaultPermissionMode: (mode) => persist(set, { defaultPermissionMode: mode }),
  setBrowserPreviewNetworkShield: (enabled) => persist(set, { browserPreviewNetworkShield: enabled }),
  setOpenAtLogin: (enabled) => persist(set, { openAtLogin: enabled }),
  setStudioPlaywrightEnabled: (enabled) => persist(set, { studioPlaywrightEnabled: enabled }),
  setStudioSurfaceSwitchMode: (mode) => persist(set, { studioSurfaceSwitchMode: mode }),
  setBashCommandEntry: (enabled) => persist(set, { bashCommandEntry: enabled }),
  setGitPanelPaneProportions: (proportions) => persist(set, { gitPanelPaneProportions: proportions }),
  // Panel heights commit on every drag frame (usePanelVerticalResize), so the
  // disk write must not ride every call — the store updates live and the
  // save is deferred to the trailing edge of the drag.
  setGitPanelHeight: (height) => {
    set({ gitPanelHeight: height })
    schedulePanelHeightSave({ gitPanelHeight: height })
  },
  setFileExplorerHeight: (height) => {
    set({ fileExplorerHeight: height })
    schedulePanelHeightSave({ fileExplorerHeight: height })
  },
  setGitPanelChangesOpen: (open) => persist(set, { gitPanelChangesOpen: open }),
  setGitPanelGraphOpen: (open) => {
    set({ gitPanelGraphOpen: open })
  },

  setExpandToolResults: (enabled) => persist(set, { expandToolResults: enabled }),
  setTerminalFontFamily: (font) => persist(set, { terminalFontFamily: font }),
  setTerminalFontSize: (size) => persist(set, { terminalFontSize: clampFontSize(size) }),
  setShowHiddenFiles: (show) => persist(set, { showHiddenFiles: show }),
  setOpenMarkdownInPreview: (enabled) => persist(set, { openMarkdownInPreview: enabled }),
  setEditorWordWrap: (enabled) => persist(set, { editorWordWrap: enabled }),
  setEditorFontSize: (size) => persist(set, { editorFontSize: clampFontSize(size, 12) }),
  setDataViewFontSize: (size) => persist(set, { dataViewFontSize: clampFontSize(size) }),
  setGitOpsMode: (mode) => persist(set, { gitOpsMode: mode }),
  setWorktreeCompletionStrategy: (strategy) => persist(set, { worktreeCompletionStrategy: strategy }),
  setWorktreeBranchDefault: (repoPath, branch) => {
    const current = get().worktreeBranchDefaults
    persist(set, { worktreeBranchDefaults: { ...current, [repoPath]: branch } })
  },
  removeWorktreeBranchDefault: (repoPath) => {
    const current = { ...get().worktreeBranchDefaults }
    delete current[repoPath]
    persist(set, { worktreeBranchDefaults: current })
  },
  setWorktreeSkipPrTitle: (skip) => persist(set, { worktreeSkipPrTitle: skip }),
  setAllowSettingsEdits: (enabled) => persist(set, { allowSettingsEdits: enabled }),
  setPushConversationTitles: (enabled) => persist(set, { pushConversationTitles: enabled }),
  setEnableClaudeCompat: (enabled) => persist(set, { enableClaudeCompat: enabled }),
  setEnableEarlyStopContinuation: (enabled) => persist(set, { enableEarlyStopContinuation: enabled }),
  setShowTodoList: (enabled) => persist(set, { showTodoList: enabled }),
  setAgentPanelDefaultOpen: (enabled) => persist(set, { agentPanelDefaultOpen: enabled }),
  setUnifiedTurnView: (enabled) => persist(set, { unifiedTurnView: enabled }),
  setAiGeneratedTitles: (enabled) => persist(set, { aiGeneratedTitles: enabled }),
  setCommitCommand: (cmd) => persist(set, { commitCommand: cmd }),
  setAiAssistPromptOverride: (workflowId, prompt) => {
    const next = { ...get().aiAssistPromptOverrides }
    const normalized = prompt?.trim()
    if (normalized) next[workflowId] = prompt!
    else delete next[workflowId]
    persist(set, { aiAssistPromptOverrides: next })
  },
  setGitChangesTreeView: (enabled) => persist(set, { gitChangesTreeView: enabled }),
  setQuickTools: (tools) => persist(set, { quickTools: tools }),
  addQuickTool: (tool) => persist(set, { quickTools: [...get().quickTools, tool] }),
  removeQuickTool: (toolId) => persist(set, { quickTools: get().quickTools.filter((t) => t.id !== toolId) }),
  updateQuickTool: (toolId, updates) => {
    persist(set, { quickTools: get().quickTools.map((t) => t.id === toolId ? { ...t, ...updates } : t) })
  },
  setUiZoom: (zoom) => persist(set, { uiZoom: clampUiZoom(zoom) }),
  zoomIn: () => {
    get().setUiZoom(get().uiZoom + 0.1)
  },
  zoomOut: () => {
    get().setUiZoom(get().uiZoom - 0.1)
  },
  setRelayUrl: (url) => persist(set, { relayUrl: url }),
  setRelayApiKey: (key) => persist(set, { relayApiKey: key }),
  setStreamThinkingToRemote: (enabled) => persist(set, { streamThinkingToRemote: enabled }),
  setDefaultThinkingEffort: (effort) => persist(set, { defaultThinkingEffort: effort }),
  addPairedDevice: (device) => {
    const current = get().pairedDevices.filter((d) => d.id !== device.id && d.name !== device.name)
    persist(set, { pairedDevices: [...current, device] })
  },
  removePairedDevice: (deviceId) => {
    persist(set, { pairedDevices: get().pairedDevices.filter((d) => d.id !== deviceId) })
  },
  setRemoteDisplay: (customName, customIcon) => {
    // Optimistically update the store; the main process is the source of
    // truth and will broadcast the canonical value back via the
    // 'ion:remote-display-changed' event listener.
    const updatedAt = Date.now()
    const next = { customName, customIcon, updatedAt }
    persist(set, { remoteDisplay: next })
  },
  setEngineDefaultModel: (model) => persist(set, { engineDefaultModel: model }),
  setPreferredModel: (model) => persist(set, { preferredModel: model }),
  setDefaultEngineProfileId: (profileId) => persist(set, { defaultEngineProfileId: profileId }),
  setEnterpriseNewConversationDefaults: (policy) => {
    // Not persisted: enterprise policy is always fetched from the engine.
    set({ enterpriseNewConversationDefaults: policy })
  },
  setEnterprisePolicy: (policy) => {
    // Not persisted: the full enterprise blob (D-004) is always fetched from
    // the engine — a runtime constraint, never a user setting.
    set({ enterprisePolicy: policy })
  },
  addEngineProfile: (profile) => persist(set, { engineProfiles: [...get().engineProfiles, profile] }),
  updateEngineProfile: (id, updates) => {
    persist(set, { engineProfiles: get().engineProfiles.map((p) => p.id === id ? { ...p, ...updates } : p) })
  },
  removeEngineProfile: (id) => persist(set, { engineProfiles: get().engineProfiles.filter((p) => p.id !== id) }),
  setPlanModelSplitEnabled: (enabled) => persist(set, { planModelSplitEnabled: enabled }),
  setPlanModeModel: (model) => persist(set, { planModeModel: model }),
  setImplementModeModel: (model) => persist(set, { implementModeModel: model }),
  normalizeModelPreferences: (models) => normalizePreferencesModels(set, get, models),
  ...createWorkspaceFolderActions(set, get),
  ...createInboxPreferenceActions(set, get),
  ...createProjectRegistryActions(set, get),
  setExcludedResourceKinds: (kinds) => persist(set, { excludedResourceKinds: kinds }),
  setShowImplementClearContext: (enabled) => persist(set, { showImplementClearContext: enabled }),
  ...createKeyboardShortcutActions((patch) => set(dropSealedSettings(patch, settingsTargetOf(set))), get, (patch) => saveSettingsFor(set, patch)),
  applyPreset: (preset) => persist(set, preset),
})

export const usePreferencesStore = create<PreferencesState>(createPreferencesState)

// Startup side effects (theme CSS seed, persisted-settings hydration,
// enterprise policy fetches, main-process settings-push listener) live in
// preferences-bootstrap.ts — extracted at the 600-line cap split.
bootstrapPreferences(usePreferencesStore, _savedThemeId)

/** The theme id that renders: the enforced id under a locked enterprise
 * themePolicy, otherwise the user's saved `selectedTheme` (left untouched). */
export function selectEffectiveThemeId(s: PreferencesState): string {
  return resolveEffectiveThemeId(s.enterprisePolicy, s.selectedTheme)
}

/** Reactive hook — returns the theme id that renders. */
export function useEffectiveThemeId(): string {
  return usePreferencesStore(selectEffectiveThemeId)
}

/** Reactive hook — returns the active color palette. Re-resolves when the
 * effective theme id changes or the custom-theme registry is replaced. */
export function useColors(): ColorPalette {
  const themeId = useEffectiveThemeId()
  useSyncExternalStore(onThemeRegistryChanged, getThemeRegistryVersion)
  return resolveColors(themeId)
}

/** Non-reactive getter — use outside React components */
export function getColors(): ColorPalette {
  return resolveColors(selectEffectiveThemeId(usePreferencesStore.getState()))
}
