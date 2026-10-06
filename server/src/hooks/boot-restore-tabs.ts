/**
 * boot-restore-tabs — restore persisted tabs into the store at server boot.
 *
 * Server-side port of the deleted desktop/src/renderer/hooks/
 * useTabRestoration.ts, a React `useEffect` that ran once when the Overlay
 * renderer mounted. That renderer (and the whole Overlay presentation) was
 * removed in spec 17, orphaning this file — its only caller was gone, but
 * nothing replaced its function: the server, which now owns `useSessionStore`
 * and `loadTabs()`, never actually restored persisted tabs on boot. This is
 * that replacement, called once from `main.ts` after the store exists.
 *
 * Per-tab restoration is in boot-restore-tab.ts (file-size cap); this module
 * owns the loop and everything that runs once before/after it: loading and
 * migrating the manifest, the eager session-start pass, history loading,
 * active-tab hydration, and restoring editor/geometry/expanded state.
 *
 * What's deliberately NOT ported (genuine capability gaps, not oversights):
 *   - `host.shell.fsReadDir` (worktree-exists probe) -> real Node `fs`
 *     access, since this runs in Node now, not behind an IPC bridge.
 *   - `usePreferencesStore` (the renderer's own zustand prefs store) ->
 *     `@ion/server/persistence/preferences`'s server-side stand-in, which
 *     reads the same settings.json keys.
 *   - `setSavedBuffer` (terminal scrollback restore) is NOT called: it
 *     requires a mounted xterm.js widget that only exists in an attaching
 *     CLIENT (see host-api-misc.ts's `setSavedBuffer` doc) -- a client
 *     re-populates its own scrollback via the terminal-attach protocol.
 *   - Splash-progress reporting (`reportStartup`) publishes each phase and
 *     each tab as a `studio_event` on the wire (store/startup-progress.ts);
 *     the desktop relays the LOCAL environment's reports to its splash.
 */
import type { PersistedTabState } from '@ion/shared/types-persistence'
import { persistedTabHasExtensions, isPersistedSettled } from '@ion/shared/tab-predicates'
import { useSessionStore } from '../store/sessionStore'
import { createTab } from '../store/host-api-engine'
import { loadTabs } from '../store/host-api-misc'
import { usePreferencesStore } from '../persistence/preferences'
import { isValidProjectPath } from '../ipc-validation'
import { benchForPath } from '../integration/bench-attribution-support'
import { restoreOneTab } from './boot-restore-tab'
import { restoreSettledHistoryRecord } from './tab-inbox-restore'
import {
  normalizeLegacyTabFields,
  resolveBootActiveTabId,
  hydrateBootActiveTab,
  hydrateBootWorkspace,
} from './useTabRestoration-helpers'
import type { RestoredTabId } from './boot-restore-types'
import {
  reportRestoreActiveConversation,
  reportRestoreHistoryLoading,
  reportRestoreLayout,
  reportRestoreWorkspaceState,
  startRestoredSessionsWithSplashProgress,
} from './useTabRestoration-progress'
import { restoreGlobalGeometry } from './useTabRestoration-geometry'
import { loadRestoredHistory } from './useTabRestoration-history'
import { registerInitialRestoredTab } from './useTabRestoration-initial-tab'
import { backfillLastActivity } from './useTabRestoration-activity'
import { reportStartup } from '../store/host-api'
import { currentServerConfig } from '../config/current'
import { log as _log, error as _error } from '../logger'
import type { FileEditorTab, FileEditorDirState } from '../store/session-store-types'

const TAG = 'boot-restore'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error(TAG, msg, fields)
}

/** `resolveBenchPath` for hydrateBootWorkspace: the real bench-attribution lookup, no IPC involved. */
async function resolveBenchPath(directory: string): Promise<{ workspace: { repoPath: string; sourceBranch: string } | null }> {
  if (!isValidProjectPath(directory)) return { workspace: null }
  const workspace = benchForPath(directory)
  return { workspace: workspace ? { repoPath: workspace.repoPath, sourceBranch: workspace.sourceBranch } : null }
}

/** Restore per-directory file-editor state from the persisted manifest. */
function restoreEditorStates(saved: PersistedTabState): void {
  if (!saved.editorStates) return
  const restored = new Map<string, FileEditorDirState>()
  for (const [dir, dirState] of Object.entries(saved.editorStates)) {
    if (!dirState?.files?.length) continue
    let fileIdCounter = 0
    const files: FileEditorTab[] = dirState.files.map((f) => ({
      id: `restored-${dir}-${fileIdCounter++}`,
      filePath: f.filePath ?? null,
      fileName: f.fileName ?? '',
      content: f.content || '',
      savedContent: f.savedContent || '',
      isDirty: f.isDirty || false,
      isReadOnly: f.isReadOnly || false,
      isPreview: f.isPreview || false,
    }))
    const savedIdx = typeof dirState.activeFileIndex === 'number' ? dirState.activeFileIndex : 0
    const activeIdx = savedIdx >= 0 && savedIdx < files.length ? savedIdx : 0
    const activeFileId = files.length > 0 ? files[activeIdx].id : null
    restored.set(dir, { activeFileId, files })
  }
  if (restored.size > 0) useSessionStore.setState({ fileEditorStates: restored })
}

/** Restore which directories had the file editor open (current field, or the deprecated per-index fallback). */
function restoreEditorOpenDirs(saved: PersistedTabState, restoredTabIds: RestoredTabId[]): void {
  if (saved.editorOpenDirs && saved.editorOpenDirs.length > 0) {
    useSessionStore.setState({ fileEditorOpenDirs: new Set(saved.editorOpenDirs) })
    return
  }
  if (!saved.editorOpenSessionIds?.length) return
  const openIndexSet = new Set(saved.editorOpenSessionIds)
  const dirs = new Set<string>()
  for (const r of restoredTabIds) {
    if (openIndexSet.has(r.index)) {
      const st = saved.tabs[r.index]
      if (st?.workingDirectory) dirs.add(st.workingDirectory)
    }
  }
  if (dirs.size > 0) useSessionStore.setState({ fileEditorOpenDirs: dirs })
}

/** The "no saved tabs" fallback: register the store constructor's initial blank tab in a real directory. */
async function restoreInitialBlankTab(homeDir: string): Promise<void> {
  const tab = useSessionStore.getState().tabs[0]
  if (!tab) return
  await registerInitialRestoredTab({
    homeDir,
    defaultBaseDirectory: usePreferencesStore.getState().defaultBaseDirectory || null,
    createTab: () => Promise.resolve(createTab()),
    update: (updater) => useSessionStore.setState((state) => ({ tabs: updater(state.tabs) })),
    finish: (tabId) => {
      useSessionStore.setState({ activeTabId: tabId, tabsReady: true, rehydrating: false, initProgress: null })
      reportStartup('Workspace ready', true)
    },
    fail: (err) => {
      useSessionStore.setState({ rehydrating: false, initProgress: null, startupError: err })
      error('could not create initial conversation tab', { error: err })
      reportStartup('Ion could not start', false, err)
    },
  })
}

/** Drops the store constructor's placeholder tab and declares the workspace ready with no conversations. */
function startWithoutTabs(): void {
  useSessionStore.setState({ tabs: [], conversationPanes: new Map(), activeTabId: '', tabsReady: true, rehydrating: false, initProgress: null })
  log('hosted home project configured: no boot conversation created; the signed-in person opens their own')
  reportStartup('Workspace ready', true)
}

/**
 * Restore every persisted tab, in order, then run the post-restore steps
 * (eager session start, history load, active-tab hydration, editor/geometry
 * state). Falls back to registering a single blank tab when nothing was
 * persisted (or the load failed).
 */
export async function bootRestoreTabs(): Promise<void> {
  await useSessionStore.getState().initStaticInfo()
  useSessionStore.setState({ initProgress: 'Loading saved tabs…' })
  reportStartup('Loading saved tabs…')
  const homeDir = useSessionStore.getState().staticInfo?.homePath || '~'

  const saved = await loadTabs().catch((err) => {
    // A failed tab load silently loses the user's restored session — log it.
    error('loadTabs failed; starting with no restored tabs', { error: String(err) })
    return null
  })

  if (!saved || !saved.tabs || saved.tabs.length === 0) {
    if (currentServerConfig().homeProject) {
      // A hosted personal instance has exactly one person, and nobody is
      // signed in at boot. A tab made now would belong to no one, and the
      // engine refuses an unowned conversation to the person who then signs
      // in. Their first conversation is created when they ask for it, owned
      // by them, in the home project.
      startWithoutTabs()
      return
    }
    await restoreInitialBlankTab(homeDir)
    return
  }

  // Normalize loaded tabs to the unified conversationPane shape in memory
  // (handles both the isEngine rename and the split→unified persisted shape;
  // idempotent for already-migrated files).
  saved.tabs = normalizeLegacyTabFields(saved.tabs)
  // Migration: the prior inbox kept settled tabs in the active workspace.
  // Close and Settle now share one cold history collection, so move every
  // persisted settled record out before any tab or engine restoration.
  const legacySettled = saved.tabs.filter(isPersistedSettled)
  saved.tabs = saved.tabs.filter((tab) => !isPersistedSettled(tab))
  saved.settledHistory = [...(saved.settledHistory ?? []), ...legacySettled]

  useSessionStore.setState({ initProgress: `Restoring ${saved.tabs.length} tabs…` })
  reportStartup(`Restoring ${saved.tabs.length} tabs…`)
  // Gate persistence during the restore loop. Each per-tab setState fires
  // the persist subscriber, producing ~N partial saves before all tabs are
  // loaded. rehydrating=true makes the subscriber early-return for the
  // whole restore window; cleared alongside tabsReady=true once it's done.
  useSessionStore.setState({
    rehydrating: true,
    settledHistory: (saved.settledHistory ?? []).map(restoreSettledHistoryRecord),
  })

  const restoredTabIds: RestoredTabId[] = []
  const worktreeAliveByIndex = new Map<number, boolean>()
  for (let i = 0; i < saved.tabs.length; i++) {
    useSessionStore.setState({ initProgress: `Restoring tab ${i + 1} of ${saved.tabs.length}…` })
    reportStartup(`Restoring tab ${i + 1} of ${saved.tabs.length}…`)
    await restoreOneTab(saved.tabs, i, saved.activeTabIndex, saved.activeSessionId, restoredTabIds, worktreeAliveByIndex)
  }

  // Eager durable session start for restored NORMAL (non-engine) tabs. The
  // active tab attaches first; the rest use bounded batches and report
  // exact progress.
  await startRestoredSessionsWithSplashProgress(
    restoredTabIds,
    saved.tabs,
    saved.activeTabIndex ?? -1,
    worktreeAliveByIndex,
    persistedTabHasExtensions,
  )

  reportRestoreHistoryLoading()
  await loadRestoredHistory(saved, restoredTabIds)

  // Staged attachments come back from disk without their base64 preview;
  // rebuild it from each file's permanent path. Fire-and-forget: the store
  // renders correctly by name/size before the thumbnails land.
  void useSessionStore.getState().rehydrateAttachmentPreviews()

  // Set active tab by index, then hydrate it. The boot-active tab is set
  // via raw setState — selectTab never runs for it, so its lazy-hydration
  // trigger never fires; hydrateBootActiveTab applies the same gate
  // explicitly.
  const bootActiveTabId = resolveBootActiveTabId(saved, restoredTabIds)
  if (bootActiveTabId) {
    reportRestoreActiveConversation()
    useSessionStore.setState({ activeTabId: bootActiveTabId })
    const store = useSessionStore.getState()
    await hydrateBootActiveTab(store, bootActiveTabId)
    const bootActiveTab = store.tabs.find((t) => t.id === bootActiveTabId)
    // `tabsReady` stays false until this finishes. A restored bench tab has
    // no worktree metadata, so exposing workspace views before this
    // resolves the owner makes the bench path look like a plain repo.
    reportRestoreWorkspaceState()
    await hydrateBootWorkspace(bootActiveTab, store.refreshWorkspaceViews, resolveBenchPath)
  }

  // Remove the initial blank tab created by the store constructor.
  const initialTabId = useSessionStore.getState().tabs[0]?.id
  const isInitialBlank = initialTabId && !restoredTabIds.some((r) => r.tabId === initialTabId)
  if (isInitialBlank) {
    useSessionStore.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== initialTabId) }))
  }

  reportRestoreLayout()
  restoreEditorStates(saved)
  restoreEditorOpenDirs(saved, restoredTabIds)
  restoreGlobalGeometry(saved)

  const restoredExpanded = typeof saved.isExpanded === 'boolean' ? saved.isExpanded : true
  useSessionStore.setState({ isExpanded: restoredExpanded, tabsReady: true, rehydrating: false, initProgress: null })
  // Honest-activity backfill AFTER restoration: max(persisted,
  // SessionMeta.lastTimestamp) per conversation chain — never Date.now().
  // Fire-and-forget; failures leave persisted values.
  void backfillLastActivity()
  log('tab restoration complete', { count: saved.tabs.length })
  // Terminal: replayed to any connection attaching after this, since the
  // desktop's reveal waits on it (startup-progress.ts).
  reportStartup('Workspace ready', true)
}
