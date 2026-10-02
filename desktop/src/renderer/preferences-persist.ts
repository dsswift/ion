import type { QuickTool, RemotePairedDevice, EngineProfile, ThinkingEffort } from '@ion/shared/types'
import type { PreferencesState } from '@ion/server/preferences-types'
import { SETTINGS_DEFAULTS } from '@ion/server/preferences-types'
import { isThinkingEffort } from '@ion/shared/thinking-options'
import { isAiAssistWorkflowId, type AiAssistWorkflowId } from '@ion/shared/ai-assist-workflows'
import { rError, rInfo, rDebug, rWarn } from './rendererLogger'
import { host } from './host/host-instance'
import { mergeClientSettings, partitionByOwner, saveClientSettings } from './preferences-scope-transport'
import { withTargetEnvironment } from './studio/connection/tab-environment'
import { dropSealedSettings } from './settings-policy'
import type { ShellApi } from './host/shell-api'
import { sanitizeRecentDirectories } from '@ion/shared/recent-directories'
import { sanitizeWorkspaceFolders } from '@ion/shared/workspace-roots'
import { migrateProjectRegistry, sanitizeProjectRegistry } from '@ion/shared/project-registry'
import { sanitizeKeyboardShortcuts } from './preferences-shortcuts'
import { clampFontSize, clampUiZoom } from './typography'
import { DEFAULT_MONO_FONT } from './typography'

/**
 * Persist the preference document.
 *
 * Routed through `host.shell` rather than `window.ion` directly. The old
 * `window.ion?.saveSettings(...)` was an optional chain, so in a browser
 * Studio client -- where `window.ion` does not exist -- it evaluated to
 * `undefined` and the write vanished with no error, no warning, and nothing
 * in any log. That is what made a browser client forget every preference on
 * reload: the operator changed a setting, reloaded, and it came back.
 * `host.shell` bridges the call to the server's per-identity overlay.
 */
/**
 * The settings transport for this client: the host shell, which bridges both
 * verbs to the server's per-identity overlay on every host. `host-instance`
 * decides which host class answers on every access (not once, cached), so
 * reading it here at module-load time is safe even when a test installs its
 * `window.ion` after importing the preference funnel.
 */
function settingsTransport(): Partial<Pick<ShellApi, 'saveSettings' | 'loadSettings'>> {
  // `?? {}` covers a partial test double whose host has no `shell` at all.
  // A real client always has one; falling back to an empty object keeps the
  // missing-verb path (which warns) rather than throwing on a property read.
  return (host as { shell?: Partial<Pick<ShellApi, 'saveSettings' | 'loadSettings'>> }).shell ?? {}
}

/**
 * A transport that does not implement the method at all.
 *
 * This is the shape a partial test double has, not a real client: both real
 * transports implement both verbs. It returns undefined so the caller can
 * carry on with in-memory defaults, and it WARNS -- the whole point of this
 * change is that a preference write must never disappear without a trace.
 */
function missingTransport(verb: string): undefined {
  rWarn('preferences', 'settings transport does not implement this verb; preference not persisted', { verb })
  return undefined
}

/**
 * Which server a preference store saves to, keyed by that store's own `set`.
 *
 * The app-wide store is unbound and saves to the local server. Settings can
 * build a second store for another server (components/settings/
 * settings-target.ts); that store is bound here, once, when it is created.
 *
 * The binding is a property of the STORE, never of the call stack. An
 * earlier version aimed saves by wrapping each call in an ambient "explicit
 * target". A save made after an `await` had already left that scope, so it
 * went to the local server instead: opening Settings on another server's
 * conversation wrote that server's project list over this machine's.
 */
const storeTargets = new WeakMap<object, string>()

export function bindSettingsTarget(set: object, environmentId: string): void {
  storeTargets.set(set, environmentId)
}

/** The server a store's saves go to, or undefined for the local server. */
export function settingsTargetOf(set: object): string | undefined {
  return storeTargets.get(set)
}

/**
 * Save a patch. Client-owned keys stay on this client whatever the target
 * (preferences-scope-transport.ts). The rest goes to `environmentId`, or to
 * the local server when none is given. The target is applied around the one
 * synchronous call that sends the frame, which is where the bridge reads it.
 */
export function saveSettings(patch: Record<string, unknown>, environmentId?: string): void {
  // The last client-side gate: a sealed key reaches neither store.
  const s = dropSealedSettings(patch, environmentId)
  const { client, server } = partitionByOwner(s)
  if (Object.keys(client).length > 0) saveClientSettings(client)
  if (Object.keys(server).length === 0) return
  const save = settingsTransport().saveSettings
  if (typeof save !== 'function') { missingTransport('saveSettings'); return }
  const send = (): unknown => save(server)
  void Promise.resolve(environmentId ? withTargetEnvironment(environmentId, send) : send())
    .catch((err) => rError('preferences', 'saveSettings failed; user settings not persisted', { environment_id: environmentId ?? 'local', error: String(err) }))
}

/** Save for the store that owns `set`, to the server that store is bound to. */
/** `saveSettings` under a name the loader can shadow locally. */
const saveSettingsTo = saveSettings

export function saveSettingsFor(set: object, s: Record<string, unknown>): void {
  saveSettings(s, storeTargets.get(set))
}

/**
 * Update local state and persist ONLY the changed keys -- never the whole
 * settings snapshot.
 *
 * The server merges a save onto the caller's existing per-identity overlay
 * (`user-settings-store.ts`'s `readOverlay(subject)`/`{...readOverlay(subject), ...patch}`),
 * so every key in `patch` becomes a permanent override, whether or not the
 * user actually customized it. Sending `getAllSettings(get)` -- this
 * client's ENTIRE in-memory snapshot -- on every single setter call (the
 * pattern this replaces) means any unrelated toggle freezes the current
 * value of every OTHER field into the overlay too, including ones the user
 * never touched. A frozen field then silently blocks that field's
 * environment default from ever reaching this user again: confirmed live
 * on 2026-09-16, where an earlier unrelated save froze an empty
 * `projects: {}` and a stale `preferredModel` into a real user's overlay,
 * hiding a newly-registered Project and a shipped default-model fix until
 * the frozen keys were found and manually deleted from the overlay file.
 */
export function persist(set: (patch: Partial<PreferencesState>) => void, patch: Partial<PreferencesState>): void {
  // A setting the enterprise policy seals is not changed, in memory or on disk.
  const allowed = dropSealedSettings(patch, storeTargets.get(set))
  if (Object.keys(allowed).length === 0) return
  set(allowed)
  saveSettingsFor(set, allowed)
}

export function getAllSettings(get: () => PreferencesState): Record<string, unknown> {
  const s = get()
  return { selectedTheme: s.selectedTheme, soundEnabled: s.soundEnabled, defaultBaseDirectory: s.defaultBaseDirectory, recentBaseDirectories: s.recentBaseDirectories, directoryUsageCounts: s.directoryUsageCounts, defaultPermissionMode: s.defaultPermissionMode, browserPreviewNetworkShield: s.browserPreviewNetworkShield, studioPlaywrightEnabled: s.studioPlaywrightEnabled, studioSurfaceSwitchMode: s.studioSurfaceSwitchMode, bashCommandEntry: s.bashCommandEntry, gitPanelPaneProportions: s.gitPanelPaneProportions, gitPanelHeight: s.gitPanelHeight, fileExplorerHeight: s.fileExplorerHeight, gitPanelChangesOpen: s.gitPanelChangesOpen, gitPanelGraphOpen: s.gitPanelGraphOpen, expandToolResults: s.expandToolResults, terminalFontFamily: s.terminalFontFamily, terminalFontSize: s.terminalFontSize, showHiddenFiles: s.showHiddenFiles, openMarkdownInPreview: s.openMarkdownInPreview, editorWordWrap: s.editorWordWrap, editorFontSize: s.editorFontSize, dataViewFontSize: s.dataViewFontSize, gitOpsMode: s.gitOpsMode, worktreeCompletionStrategy: s.worktreeCompletionStrategy, worktreeBranchDefaults: s.worktreeBranchDefaults, worktreeSkipPrTitle: s.worktreeSkipPrTitle, allowSettingsEdits: s.allowSettingsEdits, pushConversationTitles: s.pushConversationTitles, enableClaudeCompat: s.enableClaudeCompat, enableEarlyStopContinuation: s.enableEarlyStopContinuation, showTodoList: s.showTodoList, agentPanelDefaultOpen: s.agentPanelDefaultOpen, unifiedTurnView: s.unifiedTurnView, aiGeneratedTitles: s.aiGeneratedTitles, commitCommand: s.commitCommand, aiAssistPromptOverrides: s.aiAssistPromptOverrides, gitChangesTreeView: s.gitChangesTreeView, quickTools: s.quickTools, uiZoom: s.uiZoom, relayUrl: s.relayUrl, relayApiKey: s.relayApiKey, pairedDevices: s.pairedDevices, streamThinkingToRemote: s.streamThinkingToRemote, defaultThinkingEffort: s.defaultThinkingEffort, remoteDisplay: s.remoteDisplay, engineDefaultModel: s.engineDefaultModel, defaultEngineProfileId: s.defaultEngineProfileId, engineProfiles: s.engineProfiles, preferredModel: s.preferredModel, tabRecoveryEnabled: s.tabRecoveryEnabled, tabRecoveryTimeoutSec: s.tabRecoveryTimeoutSec, planModelSplitEnabled: s.planModelSplitEnabled, planModeModel: s.planModeModel, implementModeModel: s.implementModeModel, showImplementClearContext: s.showImplementClearContext, gitWatcherIgnoredDirectories: s.gitWatcherIgnoredDirectories, workspaceFolders: s.workspaceFolders, gitPanelRepoSectionsCollapsed: s.gitPanelRepoSectionsCollapsed, inboxAutoSettleDays: s.inboxAutoSettleDays, inboxAutoSettleOnMerge: s.inboxAutoSettleOnMerge, projectSettingsVersion: s.projectSettingsVersion, projects: s.projects, excludedResourceKinds: s.excludedResourceKinds, keyboardShortcuts: s.keyboardShortcuts }
}

/** Returns effective tab groups: custom groups if any exist, otherwise built-in defaults */
/** Initial in-memory defaults; disk values fill in via async loadSettings */
export const INITIAL_SAVED = { ...SETTINGS_DEFAULTS }

/**
 * Hydrate the store from disk. Validates each field (the engine writes raw
 * JSON, so anything could be malformed). Calls back into setState + applyTheme
 * so the store identity is preserved across reloads.
 */
export function loadPersistedSettings(
  setState: (patch: Partial<PreferencesState>) => void,
  getState: () => PreferencesState,
  applyTheme: (themeId: string) => void,
  /** The server to load from and write clean-ups back to. Omitted: the local server. */
  environmentId?: string,
): Promise<void> {
  const load = settingsTransport().loadSettings
  // Clean-ups found while loading (a migrated project registry, pruned
  // recents) are written back to the SAME server the values came from. They
  // run after the await below, so the target is passed, never ambient.
  const saveSettings = (patch: Record<string, unknown>): void => saveSettingsTo(patch, environmentId)
  // `Record<string, any>`, as `ShellApi.loadSettings` returns: a parsed JSON
  // document every field of which is validated below before it is used.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const read = (): Promise<Record<string, any>> | Record<string, any> | undefined => (typeof load === 'function' ? load() : missingTransport('loadSettings'))
  return Promise.resolve(environmentId ? withTargetEnvironment(environmentId, read) : read()).then((serverDisk) => (serverDisk ? mergeClientSettings(serverDisk) : serverDisk)).then((disk) => {
    if (!disk) return
    const sound = typeof disk.soundEnabled === 'boolean' ? disk.soundEnabled : true
    const baseDir = typeof disk.defaultBaseDirectory === 'string' ? disk.defaultBaseDirectory : ''
    const persistedRecentDirs = Array.isArray(disk.recentBaseDirectories) ? disk.recentBaseDirectories.filter((d: unknown) => typeof d === 'string').slice(0, 12) : []
    const persistedDirUsageCounts = (disk.directoryUsageCounts && typeof disk.directoryUsageCounts === 'object' && !Array.isArray(disk.directoryUsageCounts)) ? Object.fromEntries(Object.entries(disk.directoryUsageCounts as Record<string, unknown>).filter(([k, v]) => typeof k === 'string' && typeof v === 'number')) as Record<string, number> : {}
    // Worktrees and benches are rebuildable Ion-managed workspace paths, not
    // user projects. Migrate legacy records during hydration, including their
    // usage counters, so a retired workspace cannot return after restart.
    const sanitizedRecents = sanitizeRecentDirectories(persistedRecentDirs, persistedDirUsageCounts)
    const recentDirs = sanitizedRecents.directories
    const dirUsageCounts = sanitizedRecents.usageCounts
    const studioSurfaceSwitchMode = disk.studioSurfaceSwitchMode === 'per-conversation' ? 'per-conversation' as const : 'preserve' as const
    const browserPreviewNetworkShield = typeof disk.browserPreviewNetworkShield === 'boolean' ? disk.browserPreviewNetworkShield : true
    // Malformed or absent falls back to ENABLED: the tools are on by default,
    // and a corrupt settings file must not silently take a feature away.
    const studioPlaywrightEnabled = typeof disk.studioPlaywrightEnabled === 'boolean' ? disk.studioPlaywrightEnabled : true
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
    const expandTools = typeof disk.expandToolResults === 'boolean' ? disk.expandToolResults : false
    // The old default was a macOS-only stack ("Menlo, Monaco, monospace"). It
    // was written to settings.json on every profile that ever saved a setting,
    // so correcting SETTINGS_DEFAULTS alone fixes nothing for an existing
    // install: the persisted value wins, and on Windows it resolves to a
    // proportional fallback that makes xterm measure a fraction of the real
    // columns.
    //
    // The exact legacy string migrates once to the current stack. A value the
    // operator actually chose is left alone, because it will not match this
    // string byte-for-byte.
    const LEGACY_MONO_FONT = 'Menlo, Monaco, monospace'
    const savedFont = typeof disk.terminalFontFamily === 'string' ? disk.terminalFontFamily : ''
    const termFont = !savedFont || savedFont === LEGACY_MONO_FONT ? DEFAULT_MONO_FONT : savedFont
    const migratedTerminalFont = savedFont === LEGACY_MONO_FONT
    const termSize = clampFontSize(typeof disk.terminalFontSize === 'number' ? disk.terminalFontSize : 13)
    const showHidden = typeof disk.showHiddenFiles === 'boolean' ? disk.showHiddenFiles : false
    const mdPreview = typeof disk.openMarkdownInPreview === 'boolean' ? disk.openMarkdownInPreview : true
    const wordWrap = typeof disk.editorWordWrap === 'boolean' ? disk.editorWordWrap : true
    const editorFontSize = clampFontSize(typeof disk.editorFontSize === 'number' ? disk.editorFontSize : 12, 12)
    // Legacy values migrate once. Conversation was the default shortcut target,
    // so it wins when old conversation and preview values disagree.
    const dataViewFontSize = clampFontSize(
      typeof disk.dataViewFontSize === 'number'
        ? disk.dataViewFontSize
        : typeof disk.dataViewFontSize === 'number'
          ? disk.dataViewFontSize
          : typeof disk.dataViewFontSize === 'number'
            ? disk.dataViewFontSize
            : 13,
    )
    const gitOpsMode = (disk.gitOpsMode === 'manual' || disk.gitOpsMode === 'worktree') ? disk.gitOpsMode : 'manual'
    const wtStrategy = (disk.worktreeCompletionStrategy === 'merge-ff' || disk.worktreeCompletionStrategy === 'merge' || disk.worktreeCompletionStrategy === 'pr') ? disk.worktreeCompletionStrategy : 'merge-ff'
    const wtDefaults = (disk.worktreeBranchDefaults && typeof disk.worktreeBranchDefaults === 'object' && !Array.isArray(disk.worktreeBranchDefaults)) ? disk.worktreeBranchDefaults as Record<string, string> : {}
    const wtSkipPr = typeof disk.worktreeSkipPrTitle === 'boolean' ? disk.worktreeSkipPrTitle : false
    const allowSettings = typeof disk.allowSettingsEdits === 'boolean' ? disk.allowSettingsEdits : false
    const pushTitles = typeof disk.pushConversationTitles === 'boolean' ? disk.pushConversationTitles : true
    const enableCompat = typeof disk.enableClaudeCompat === 'boolean' ? disk.enableClaudeCompat : false
    const enableEarlyStop = typeof disk.enableEarlyStopContinuation === 'boolean' ? disk.enableEarlyStopContinuation : false
    const showTodo = typeof disk.showTodoList === 'boolean' ? disk.showTodoList : true
    const agentPanelDefaultOpen = typeof disk.agentPanelDefaultOpen === 'boolean' ? disk.agentPanelDefaultOpen : true
    const unifiedTurnView = typeof disk.unifiedTurnView === 'boolean' ? disk.unifiedTurnView : true
    const aiTitles = typeof disk.aiGeneratedTitles === 'boolean' ? disk.aiGeneratedTitles : true
    const commitCommand = typeof disk.commitCommand === 'string' ? disk.commitCommand : ''
    const aiAssistPromptOverrides = (disk.aiAssistPromptOverrides && typeof disk.aiAssistPromptOverrides === 'object' && !Array.isArray(disk.aiAssistPromptOverrides))
      ? Object.fromEntries(Object.entries(disk.aiAssistPromptOverrides as Record<string, unknown>)
          .filter(([id, prompt]) => isAiAssistWorkflowId(id) && typeof prompt === 'string' && prompt.trim().length > 0)) as Partial<Record<AiAssistWorkflowId, string>>
      : {}
    const changesTreeView = typeof disk.gitChangesTreeView === 'boolean' ? disk.gitChangesTreeView : false
    const permMode = (disk.defaultPermissionMode === 'auto' || disk.defaultPermissionMode === 'plan') ? disk.defaultPermissionMode : 'plan'
    const quickTools = Array.isArray(disk.quickTools) ? (disk.quickTools as QuickTool[]).filter((t: any) => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.command === 'string') : []
    const uiZoom = clampUiZoom(typeof disk.uiZoom === 'number' ? disk.uiZoom : 1)
    const relayUrl = typeof disk.relayUrl === 'string' ? disk.relayUrl : ''
    const relayApiKey = typeof disk.relayApiKey === 'string' ? disk.relayApiKey : ''
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
    // 'adaptive' is deliberately excluded (matching `defaultThinkingEffortOf` in
    // server/src/conversation-preferences.ts): this preference seeds effort-based models, while
    // adaptive models derive their own default from capability metadata via
    // defaultEffortForMode. Default 'medium' — enough reasoning to matter,
    // without pinning every trivial turn to the model's deepest budget.
    const defaultThinkingEffort: ThinkingEffort =
      (isThinkingEffort(disk.defaultThinkingEffort) && disk.defaultThinkingEffort !== 'adaptive')
        ? disk.defaultThinkingEffort
        : 'medium'
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
    // Empty, not an invented model id -- see server's SETTINGS_DEFAULTS.preferredModel.
    const preferredModel = typeof disk.preferredModel === 'string' && disk.preferredModel ? disk.preferredModel : ''
    const engineProfiles: EngineProfile[] = Array.isArray(disk.engineProfiles) ? (disk.engineProfiles as any[]).filter((p: any) => p && typeof p.id === 'string' && typeof p.name === 'string') : []
    const tabRecoveryEnabled = typeof disk.tabRecoveryEnabled === 'boolean' ? disk.tabRecoveryEnabled : true
    const tabRecoveryTimeoutSec = typeof disk.tabRecoveryTimeoutSec === 'number' ? Math.max(30, Math.min(600, Math.round(disk.tabRecoveryTimeoutSec))) : 120
    const planModelSplitEnabled = typeof disk.planModelSplitEnabled === 'boolean' ? disk.planModelSplitEnabled : false
    const planModeModel = typeof disk.planModeModel === 'string' ? disk.planModeModel : ''
    const implementModeModel = typeof disk.implementModeModel === 'string' ? disk.implementModeModel : ''
    // gitWatcherIgnoredDirectories: paths where the git file watcher is
    // suppressed. An explicit empty array means "watch everywhere". Falls back
    // to the default ['~/.ion'] when the key is absent or not an array.
    // workspaceFolders: per-project record of extra roots. Malformed disk
    // values (wrong shape, relative paths, non-strings) sanitize to {}.
    const workspaceFolders = sanitizeWorkspaceFolders(disk.workspaceFolders, (entry) => rDebug('preferences', 'rejected non-absolute workspace folder entry on load', { entry }))
    const gitPanelRepoSectionsCollapsed: Record<string, boolean> = {}
    if (disk.gitPanelRepoSectionsCollapsed && typeof disk.gitPanelRepoSectionsCollapsed === 'object' && !Array.isArray(disk.gitPanelRepoSectionsCollapsed)) {
      for (const [k, v] of Object.entries(disk.gitPanelRepoSectionsCollapsed as Record<string, unknown>)) {
        if (typeof v === 'boolean') gitPanelRepoSectionsCollapsed[k] = v
      }
    }
    const inboxAutoSettleDays =
      typeof disk.inboxAutoSettleDays === 'number' && Number.isFinite(disk.inboxAutoSettleDays)
        ? Math.min(90, Math.max(0, Math.round(disk.inboxAutoSettleDays)))
        : SETTINGS_DEFAULTS.inboxAutoSettleDays
    const inboxAutoSettleOnMerge =
      typeof disk.inboxAutoSettleOnMerge === 'boolean'
        ? disk.inboxAutoSettleOnMerge
        : SETTINGS_DEFAULTS.inboxAutoSettleOnMerge
    const projectSettingsVersion = typeof disk.projectSettingsVersion === 'number' ? disk.projectSettingsVersion : 0
    const shouldMigrateProjectSettings = projectSettingsVersion < 1 && (disk.projects !== undefined || (typeof disk.defaultBaseDirectory === 'string' && disk.defaultBaseDirectory.length > 0))
    const projects = shouldMigrateProjectSettings
      ? migrateProjectRegistry(disk.projects, disk.defaultBaseDirectory)
      : sanitizeProjectRegistry(disk.projects, (entry) => rDebug('preferences', 'rejected non-absolute project entry on load', { entry }))
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
    // keyboardShortcuts are scoped by view. Flat legacy maps migrate to the
    // overlay so existing bindings keep their behavior after this upgrade.
    const keyboardShortcuts = sanitizeKeyboardShortcuts(disk.keyboardShortcuts)
    setState({ selectedTheme, soundEnabled: sound, defaultBaseDirectory: baseDir, recentBaseDirectories: recentDirs, directoryUsageCounts: dirUsageCounts, studioSurfaceSwitchMode, bashCommandEntry: bashCmd, gitPanelPaneProportions: paneProportions, gitPanelHeight, fileExplorerHeight, gitPanelChangesOpen: changesOpen, gitPanelGraphOpen: graphOpen, expandToolResults: expandTools, terminalFontFamily: termFont, terminalFontSize: termSize, editorFontSize, dataViewFontSize, showHiddenFiles: showHidden, openMarkdownInPreview: mdPreview, editorWordWrap: wordWrap, gitOpsMode, worktreeCompletionStrategy: wtStrategy, worktreeBranchDefaults: wtDefaults, worktreeSkipPrTitle: wtSkipPr, allowSettingsEdits: allowSettings, pushConversationTitles: pushTitles, enableClaudeCompat: enableCompat, enableEarlyStopContinuation: enableEarlyStop, showTodoList: showTodo, agentPanelDefaultOpen, unifiedTurnView, aiGeneratedTitles: aiTitles, commitCommand, aiAssistPromptOverrides, gitChangesTreeView: changesTreeView, defaultPermissionMode: permMode, browserPreviewNetworkShield, studioPlaywrightEnabled, quickTools, uiZoom, relayUrl, relayApiKey, pairedDevices, streamThinkingToRemote, defaultThinkingEffort, remoteDisplay, engineDefaultModel, defaultEngineProfileId, engineProfiles, preferredModel, tabRecoveryEnabled, tabRecoveryTimeoutSec, planModelSplitEnabled, planModeModel, implementModeModel, showImplementClearContext, gitWatcherIgnoredDirectories: gitWatcherIgnoredDirs, workspaceFolders, gitPanelRepoSectionsCollapsed, inboxAutoSettleDays, inboxAutoSettleOnMerge, projectSettingsVersion: 1, projects, excludedResourceKinds, keyboardShortcuts })
    // Persist the font migration, not just apply it in memory.
    //
    // Without this the corrected value lived only in the store: the terminal
    // rendered correctly, but settings.json still read the legacy macOS stack
    // until some unrelated setting happened to be saved. That made the fix
    // unverifiable from disk and looked like a failed migration -- which is
    // exactly how it was reported.
    if (migratedTerminalFont) {
      saveSettings({ terminalFontFamily: termFont })
      rInfo('preferences', 'migrated the legacy terminal font', { to: DEFAULT_MONO_FONT })
    }
    if (shouldMigrateProjectSettings) {
      saveSettings({ projects, projectSettingsVersion: 1 })
      rInfo('preferences', 'migrated controlled project settings', { project_count: Object.keys(projects).length })
    }
    if (sanitizedRecents.removed) {
      saveSettings({ recentBaseDirectories: recentDirs, directoryUsageCounts: dirUsageCounts })
      rInfo('preferences', 'removed ephemeral workspaces from persisted recent directories', {
        removed_directory_count: persistedRecentDirs.length - recentDirs.length,
      })
    }
    applyTheme(selectedTheme)

    // TypographySync applies root zoom in each renderer window after this
    // state patch. Applying it here would only update the loading renderer.

  })?.catch((err) => rError('preferences', 'loadSettings failed; using in-memory defaults', { error: String(err) }))
}
