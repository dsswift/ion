import { create } from 'zustand'
import { useSessionStore } from '../../stores/sessionStore'
import type { ResourceItem } from '../../../shared/types-engine'
import {
  browserTabId,
  DISPATCH_SURFACE_ID,
  isBrowserTab,
  terminalTabId,
  NOTIFICATION_SURFACE_ID,
  QUESTIONS_SURFACE_ID,
  type NotificationTab,
  type LegacySurfacePersisted,
  type PinnableSingletonId,
  type ScratchProject,
  type ScratchTab,
  type SingletonId,
  type SurfaceConversationPersisted,
  type SurfaceTab,
} from '../../../shared/studio-surface-types'
import type { BrowserEmulationState, StudioBrowserTabInfo } from '../../../shared/studio-browser-types'
import { bindAgentBrowserActions, pointerAfterOpen } from './surface-agent-browser'
import { openFileTabIn, openPreviewTabIn } from './surface-file-tabs'
import { applyConversationSelection, configureConversationSelection } from './surface-selection'
import { configureSurfacePersist, flushSurfacePersist, scheduleSurfacePersist } from './surface-persist'

export { flushSurfacePersist }

/** Queue a debounced write of the surface state. */
function schedulePersist(get: () => SurfaceState): void {
  scheduleSurfacePersist(get)
}
import { createQuestionsSurfaceActions } from './surface-questions-actions'
import {
  closeOthersTargets,
  closeToRightTargets,
  composeTabs,
  nextActiveAfterClose,
  nextTerminalTitle,
  normalizeTabs,
} from '../../../shared/studio-surface-ordering'
import {
  emptySurfacePersisted,
  normalizePinnedTabs,
  parseSurfacePersisted,
} from '../../../shared/studio-surface-persistence'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'
import { unregisterRuntimePanel } from './runtime-panel-registry'
import { scratchProjectKey, scratchTabsForProject } from './surface-scratch'
import { createScratchSurfaceActions } from './surface-scratch-actions'
import { materializeConversation, materializeFileBuffer, teardownSurfaceTab } from './surface-tab-lifecycle'
import { globalSurfaceTabIds, visibleSurfaceTabs } from './surface-tab-composition'


type ConversationMap = Record<string, SurfaceConversationPersisted>

export interface SurfaceState {
  /** Composed global pins and active conversation descriptors. */
  tabs: SurfaceTab[]
  activeTabId: string | null
  pinnedTabs: PinnableSingletonId[]
  /** Workspace-scoped notification kept open across every conversation. */
  notification: NotificationTab | null
  /** Unsaved documents shared by conversations with the same source-project key. */
  scratchProjects: Record<string, ScratchProject>
  conversations: ConversationMap
  currentConversationId: string | null
  /** Dirty Scratch Document waiting for an explicit discard decision. */
  pendingScratchCloseId: string | null
  /** Current window state. It can intentionally differ from the saved conversation state. */
  visible: boolean
  hydrated: boolean
  diffReveal: { filePath: string; staged: boolean; nonce: number } | null
  /**
   * Conversation tab ids whose ACTIVE conversation currently has an open
   * guided-questions workflow. The synchronizer (questions-surface-sync)
   * writes this; composition inserts the transient Questions tab for the
   * current conversation when its id is present. Never persisted.
   */
  questionsConversations: Set<string>
  /**
   * When Questions forced focus, the previously active Canvas tab id per
   * conversation, restored on workflow completion when still valid.
   */
  questionsPriorActive: Record<string, string | null>

  hydrate(): Promise<void>
  selectConversation(tabId: string | null): void
  setVisible(visible: boolean): void
  toggleVisible(): void
  openSingleton(id: SingletonId): void
  openFileTab(dir: string, tabId: string, filePath: string): void
  openPreviewTab(filePath: string, dataUrl?: string): void
  openResourceTab(item: ResourceItem): void
  openDispatchTab(agentName: string, dispatchId: string, title: string): void
  openRuntimePanel(id: string, title: string): void
  updateRuntimePanelTitle(id: string, title: string): void
  removeRuntimePanel(id: string): void
  createScratch(): void
  updateScratch(projectKey: string, documentId: string, content: string): void
  toggleScratchPreview(projectKey: string, documentId: string): void
  toggleScratchWordWrap(projectKey: string, documentId: string): void
  setScratchSaveError(projectKey: string, documentId: string, error: string | undefined): void
  deleteScratch(projectKey: string, documentId: string): void
  requestScratchClose(projectKey: string, documentId: string): void
  cancelScratchClose(): void
  confirmScratchClose(): void
  promoteScratch(projectKey: string, documentId: string, filePath: string, conversationId: string): void
  openBrowserTab(url: string, mode: 'preview' | 'browse', sessionMode?: 'isolated' | 'shared'): void
  /** Move this conversation's agent browser link to an existing browser tab. */
  linkAgentBrowser(instanceId: string): void
  /**
   * Return a conversation's agent-linked browser tab, creating one when absent.
   *
   * The conversation is always named by the caller and, in the tool path, comes
   * from the engine session key rather than from anything an agent supplies. A
   * background conversation is served exactly like the visible one.
   */
  ensureAgentBrowser(conversationId: string, url?: string): StudioBrowserTabInfo | null
  /** Read a conversation's agent-linked browser tab without creating one. */
  agentBrowser(conversationId: string): StudioBrowserTabInfo | null
  /** Store (or clear with null) a browser tab's device emulation state. */
  setBrowserEmulation(conversationId: string, instanceId: string, emulation: BrowserEmulationState | null): void
  openTerminalTab(cwd: string): void
  activateTab(id: string): void
  closeTab(id: string): void
  closeOthers(id: string): void
  closeToRight(id: string): void
  pinTab(id: PinnableSingletonId): void
  unpinTab(id: PinnableSingletonId): void
  updateBrowserTab(id: string, patch: Partial<{ url: string; title: string; mode: 'preview' | 'browse'; sessionMode: 'isolated' | 'shared' }>): void
  renameTerminalTab(id: string, title: string): void
  revealDiffFile(target: { filePath: string; staged: boolean }): void
  /** Synchronizer entry: a conversation gained an open guided workflow. */
  showQuestionsSurface(tabId: string): void
  /** Synchronizer entry: a conversation's guided workflows all closed. */
  retireQuestionsSurface(tabId: string): void
}

let hydrationPromise: Promise<void> | null = null

export function resetSurfaceHydrationForTests(): void {
  hydrationPromise = null
  useSurfaceStore.setState({ hydrated: false })
}

function emptyConversation(): SurfaceConversationPersisted {
  return { tabs: [], activeTabId: null, visible: false, agentBrowserInstanceId: null }
}

function projectKeyForConversation(conversationId: string | null): string | null {
  const tab = useSessionStore.getState().tabs.find((item) => item.id === conversationId)
  return scratchProjectKey(tab)
}

function normalizeConversation(
  pinnedTabs: readonly PinnableSingletonId[],
  notification: NotificationTab | null,
  conversation: SurfaceConversationPersisted,
  scratchTabs: readonly ScratchTab[] = [],
  hasQuestions = false,
): SurfaceConversationPersisted {
  const tabs = normalizeTabs(
    conversation.tabs.filter((tab) => !(tab.kind === 'singleton' && pinnedTabs.includes(tab.id as PinnableSingletonId))),
    conversation.agentBrowserInstanceId,
  )
  // A pointer whose tab is gone is dropped here rather than carried as a
  // dangling id: the strip would otherwise claim a link that nothing renders.
  // Dropping is safe because closing the linked tab is exactly the case where
  // the next agent call is supposed to create a fresh one.
  const agentBrowserInstanceId = conversation.agentBrowserInstanceId && tabs.some((tab) => isBrowserTab(tab) && tab.instanceId === conversation.agentBrowserInstanceId)
    ? conversation.agentBrowserInstanceId
    : null
  const composed = visibleSurfaceTabs(pinnedTabs, notification, { ...conversation, tabs, agentBrowserInstanceId }, scratchTabs, hasQuestions)
  return {
    tabs,
    visible: conversation.visible,
    agentBrowserInstanceId,
    activeTabId: conversation.activeTabId && composed.some((tab) => tab.id === conversation.activeTabId)
      ? conversation.activeTabId
      : (composed[0]?.id ?? null),
  }
}

function project(state: Pick<SurfaceState, 'pinnedTabs' | 'notification' | 'scratchProjects' | 'conversations' | 'currentConversationId' | 'visible'> & { questionsConversations?: Set<string> }): Pick<SurfaceState, 'tabs' | 'activeTabId' | 'conversations' | 'visible'> {
  if (!state.currentConversationId) return { tabs: [], activeTabId: null, conversations: state.conversations, visible: state.visible }
  const hasQuestions = state.questionsConversations?.has(state.currentConversationId) ?? false
  const scratchTabs = scratchTabsForProject(state.scratchProjects, projectKeyForConversation(state.currentConversationId))
  const current = normalizeConversation(state.pinnedTabs, state.notification, state.conversations[state.currentConversationId] ?? emptyConversation(), scratchTabs, hasQuestions)
  const conversations = { ...state.conversations, [state.currentConversationId]: current }
  return { tabs: visibleSurfaceTabs(state.pinnedTabs, state.notification, current, scratchTabs, hasQuestions), activeTabId: current.activeTabId, conversations, visible: state.visible }
}

/**
 * Apply an update to a NAMED conversation, on screen or not.
 *
 * An agent acting in a background conversation must be able to open and drive
 * its own browser tab without the operator switching to it. Writing only to
 * the visible conversation would either refuse that work or, worse, apply it
 * to whichever conversation the operator happens to be looking at.
 *
 * `project()` re-derives the visible strip, so an update to a background
 * conversation changes its stored descriptors and leaves the rendered tab list
 * untouched.
 */
export function updateConversationById(
  set: (partial: Partial<SurfaceState>) => void,
  get: () => SurfaceState,
  conversationId: string,
  update: (current: SurfaceConversationPersisted) => SurfaceConversationPersisted,
): void {
  const state = get()
  const current = state.conversations[conversationId] ?? emptyConversation()
  const scratchTabs = scratchTabsForProject(state.scratchProjects, projectKeyForConversation(conversationId))
  const conversations = { ...state.conversations, [conversationId]: normalizeConversation(state.pinnedTabs, state.notification, update(current), scratchTabs) }
  set({ ...project({ ...state, conversations }), conversations })
  schedulePersist(get)
}

function updateCurrent(set: (partial: Partial<SurfaceState>) => void, get: () => SurfaceState, update: (current: SurfaceConversationPersisted) => SurfaceConversationPersisted): void {
  const state = get()
  // Content routes can fire before the Studio sync subscription has observed
  // its first owner tab push. Resolve the live session target here so the
  // route never loses a deliberate open during that short boot interval.
  const id = state.currentConversationId ?? useSessionStore.getState().activeTabId
  if (!id) return
  const current = state.conversations[id] ?? emptyConversation()
  const scratchTabs = scratchTabsForProject(state.scratchProjects, projectKeyForConversation(id))
  const conversations = { ...state.conversations, [id]: normalizeConversation(state.pinnedTabs, state.notification, update(current), scratchTabs) }
  set({ ...project({ ...state, conversations, currentConversationId: id }), currentConversationId: id })
  schedulePersist(get)
}

// Selection lives in its own module (size cap); it composes over these two.
// The flush needs the live store, which does not exist until create() runs.
configureSurfacePersist(() => useSurfaceStore.getState())

configureConversationSelection({
  project: (state) => project(state as never) as never,
  emptyConversation,
})

export const useSurfaceStore = create<SurfaceState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  pinnedTabs: [],
  notification: null,
  scratchProjects: {},
  conversations: {},
  currentConversationId: null,
  pendingScratchCloseId: null,
  visible: false,
  hydrated: false,
  diffReveal: null,
  questionsConversations: new Set<string>(),
  questionsPriorActive: {},

  hydrate: async () => {
    if (hydrationPromise) return hydrationPromise
    hydrationPromise = (async () => {
      try {
        const settings = await window.ion.studioGetSettings()
        const parsed = parseSurfacePersisted(settings?.studioSurface)
        const currentConversationId = useSessionStore.getState().activeTabId
        // The restore side was entirely unlogged, so a tab that came back
        // missing gave no way to tell whether it failed to persist, failed to
        // parse, or was stored under a key this session never looks up.
        const stored = parsed && 'conversations' in parsed ? parsed.conversations : {}
        const mine = stored[currentConversationId ?? '']
        rInfo('studio.surface', 'hydrating surface state', {
          conversation_id: currentConversationId ?? 'none',
          parsed: parsed !== null,
          stored_conversations: Object.keys(stored).length,
          my_record: mine ? `${mine.tabs.length} tabs${mine.visible ? ' +open' : ''}` : 'ABSENT',
          my_tab_kinds: mine ? mine.tabs.map((tab: { kind: string }) => tab.kind).join(',') : '',
        })
        if (!parsed) {
          const empty = emptySurfacePersisted()
          set({ ...project({ pinnedTabs: empty.pinnedTabs, notification: empty.notification, scratchProjects: empty.scratchProjects, conversations: {}, currentConversationId, visible: false }), pinnedTabs: empty.pinnedTabs, notification: empty.notification, scratchProjects: empty.scratchProjects, currentConversationId, hydrated: true })
          rDebug('studio.surface', 'no persisted surface, starting with default pins')
          return
        }
        if (parsed.version === 1) {
          const legacy = parsed as LegacySurfacePersisted
          const legacyVisible = settings?.studioLayout && typeof settings.studioLayout === 'object' && (settings.studioLayout as { surfaceVisible?: unknown }).surfaceVisible === true
          const conversations: Record<string, SurfaceConversationPersisted> = currentConversationId
            ? { [currentConversationId]: { tabs: legacy.tabs, activeTabId: legacy.activeTabId, visible: legacyVisible, agentBrowserInstanceId: null } }
            : {}
          const pinnedTabs: PinnableSingletonId[] = ['plan']
          const local = currentConversationId ? conversations[currentConversationId]! : emptyConversation()
          for (const pin of pinnedTabs) local.tabs = local.tabs.filter((tab: SurfaceTab) => tab.id !== pin)
          if (currentConversationId) conversations[currentConversationId] = local
          const state = { pinnedTabs, notification: null, scratchProjects: {}, conversations, currentConversationId, visible: legacyVisible }
          set({ ...project(state), pinnedTabs, currentConversationId, hydrated: true })
          rInfo('studio.surface', 'legacy surface migrated to conversation state', { tab_id: currentConversationId ?? '', tab_count: legacy.tabs.length })
          schedulePersist(get)
          return
        }
        const conversations = Object.fromEntries(Object.entries(parsed.conversations).map(([id, conversation]) => [id, materializeConversation(conversation)]))
        const initial = { pinnedTabs: parsed.pinnedTabs, notification: parsed.notification, scratchProjects: parsed.scratchProjects, conversations, currentConversationId, visible: false }
        const current = currentConversationId ? conversations[currentConversationId] : null
        // Restoring the panel as the operator left it is correct in both
        // modes: 'preserve' is about keeping it pinned across tab switches,
        // not about discarding it across restarts.
        initial.visible = current?.visible ?? false
        set({ ...project(initial), pinnedTabs: parsed.pinnedTabs, notification: parsed.notification, scratchProjects: parsed.scratchProjects, currentConversationId, hydrated: true })
        rDebug('studio.surface', 'surface hydrated', { conversation_count: Object.keys(conversations).length, pinned_count: parsed.pinnedTabs.length, tab_id: currentConversationId ?? '' })
      } catch (err) {
        const currentConversationId = useSessionStore.getState().activeTabId
        const empty = emptySurfacePersisted()
        set({ ...project({ pinnedTabs: empty.pinnedTabs, notification: empty.notification, scratchProjects: empty.scratchProjects, conversations: {}, currentConversationId, visible: false }), pinnedTabs: empty.pinnedTabs, notification: empty.notification, scratchProjects: empty.scratchProjects, currentConversationId, hydrated: true })
        rWarn('studio.surface', 'surface hydrate failed, starting with default pins', { error: String(err) })
      }
    })()
    return hydrationPromise
  },

  selectConversation: (currentConversationId) => applyConversationSelection(set, get, currentConversationId),

  setVisible: (visible) => {
    const state = get()
    // Pane close is refused while the current conversation has a live
    // guided-questions workflow requiring input: hiding the canvas would
    // bury the one surface the run is blocked on.
    if (!visible && state.currentConversationId && state.questionsConversations.has(state.currentConversationId)) {
      rDebug('studio.surface', 'canvas hide refused: questions workflow requires input', { tab_id: state.currentConversationId })
      return
    }
    // Recorded in BOTH modes. The mode decides how a tab SWITCH reads this
    // (see surface-selection.ts), not whether the panel's state is ever
    // written — and conflating the two meant 'preserve' always reopened the
    // app with the panel closed, however the operator left it.
    if (state.currentConversationId) {
      updateCurrent(set, get, (current) => ({ ...current, visible }))
      set({ visible })
    } else {
      set({ visible })
    }
  },

  toggleVisible: () => get().setVisible(!get().visible),

  openSingleton: (id) => {
    const state = get()
    if (state.pinnedTabs.includes(id as PinnableSingletonId)) {
      updateCurrent(set, get, (current) => ({ ...current, activeTabId: id }))
      return
    }
    updateCurrent(set, get, (current) => ({ ...current, tabs: normalizeTabs(current.tabs.some((tab) => tab.id === id) ? current.tabs : [...current.tabs, { kind: 'singleton', id }]), activeTabId: id }))
  },

  openFileTab: (dir, tabId, filePath) => {
    const resolvedDir = materializeFileBuffer(filePath, dir, tabId)
    if (resolvedDir === null) return
    updateCurrent(set, get, (current) => openFileTabIn(current, filePath, resolvedDir, tabId))
  },

  openPreviewTab: (filePath, dataUrl) => {
    updateCurrent(set, get, (current) => openPreviewTabIn(current, filePath, dataUrl))
  },

  openResourceTab: (item) => {
    const notification: NotificationTab = { kind: 'notification', id: NOTIFICATION_SURFACE_ID, resourceKind: item.kind, resourceId: item.id, resourceProducer: item.producer }
    const state = get()
    const currentConversationId = state.currentConversationId ?? useSessionStore.getState().activeTabId
    rDebug('studio.surface', 'opening workspace notification', {
      resource_id: item.id,
      resource_kind: item.kind,
      tab_id: currentConversationId ?? '',
    })
    if (!currentConversationId) {
      set({ ...project({ ...state, notification }), notification })
      schedulePersist(get)
      rInfo('studio.surface', 'workspace notification opened without an active conversation', {
        resource_id: item.id,
        resource_kind: item.kind,
      })
      return
    }
    const current = state.conversations[currentConversationId] ?? emptyConversation()
    const conversations = {
      ...state.conversations,
      [currentConversationId]: normalizeConversation(state.pinnedTabs, notification, {
        ...current,
        activeTabId: NOTIFICATION_SURFACE_ID,
      }),
    }
    set({
      ...project({ ...state, notification, conversations, currentConversationId }),
      notification,
      currentConversationId,
    })
    schedulePersist(get)
    rInfo('studio.surface', 'workspace notification opened and focused', {
      resource_id: item.id,
      resource_kind: item.kind,
      surface_tab: NOTIFICATION_SURFACE_ID,
      tab_id: currentConversationId,
    })
  },

  openDispatchTab: (agentName, dispatchId, title) => updateCurrent(set, get, (current) => ({
    ...current,
    tabs: current.tabs.some((tab) => tab.id === DISPATCH_SURFACE_ID)
      ? current.tabs.map((tab) => tab.id === DISPATCH_SURFACE_ID ? { kind: 'dispatch', id: DISPATCH_SURFACE_ID, agentName, dispatchId, title } : tab)
      : [...current.tabs, { kind: 'dispatch', id: DISPATCH_SURFACE_ID, agentName, dispatchId, title }],
    activeTabId: DISPATCH_SURFACE_ID,
  })),

  openRuntimePanel: (id, title) => updateCurrent(set, get, (current) => ({ ...current, tabs: current.tabs.some((tab) => tab.id === id) ? current.tabs.map((tab) => tab.id === id ? { kind: 'runtime-panel', id, title } : tab) : [...current.tabs, { kind: 'runtime-panel', id, title }], activeTabId: id })),

  updateRuntimePanelTitle: (id, title) => updateCurrent(set, get, (current) => ({ ...current, tabs: current.tabs.map((tab) => tab.id === id && tab.kind === 'runtime-panel' ? { ...tab, title } : tab) })),

  removeRuntimePanel: (id) => {
    unregisterRuntimePanel(id)
    updateCurrent(set, get, (current) => ({ ...current, tabs: current.tabs.filter((tab) => tab.id !== id), activeTabId: current.activeTabId === id ? nextActiveAfterClose(get().tabs, id) : current.activeTabId }))
  },

  ...createScratchSurfaceActions({ set, get, project, schedulePersist, emptyConversation }),

  openBrowserTab: (url, mode, sessionMode = 'shared') => {
    const instanceId = crypto.randomUUID()
    const id = browserTabId(instanceId)
    updateCurrent(set, get, (current) => {
      // The conversation's first browser tab becomes the agent's tab. Later
      // tabs stay the operator's own — see surface-agent-browser.ts.
      const agentBrowserInstanceId = pointerAfterOpen(current, instanceId)
      return {
        ...current,
        tabs: normalizeTabs([
          ...current.tabs,
          { kind: 'browser', id, instanceId, url, title: url, mode, sessionMode },
        ], agentBrowserInstanceId),
        activeTabId: id,
        agentBrowserInstanceId,
      }
    })
  },

  ...bindAgentBrowserActions({
    get: () => get(),
    set,
    fallbackConversationId: () => useSessionStore.getState().activeTabId,
    updateConversation: (conversationId, update) => updateConversationById(set, get, conversationId, update),
    normalize: (tabs, agentBrowserInstanceId) => normalizeTabs(tabs, agentBrowserInstanceId),
    info: (message, fields) => rInfo('studio.surface', message, fields),
    debug: (message, fields) => rDebug('studio.surface', message, fields),
  }),

  openTerminalTab: (cwd) => {
    const instanceId = crypto.randomUUID()
    const id = terminalTabId(instanceId)
    updateCurrent(set, get, (current) => ({ ...current, tabs: normalizeTabs([...current.tabs, { kind: 'terminal', id, instanceId, cwd, title: nextTerminalTitle(visibleSurfaceTabs(get().pinnedTabs, get().notification, current)) }]), activeTabId: id }))
  },

  activateTab: (id) => updateCurrent(set, get, (current) => {
    // The membership guard must see the SAME strip project() renders. Scratch
    // tabs live in the global scratchProjects map (not conversation.tabs) and
    // the Questions tab is coordinator-transient — both are appended only when
    // their arguments are passed. Omitting them here made activateTab a no-op
    // for a scratch tab: it never matched, so clicking it (or returning to it
    // after visiting another tab) silently kept the old active tab and the
    // document never loaded.
    const state = get()
    const scratchTabs = scratchTabsForProject(state.scratchProjects, projectKeyForConversation(state.currentConversationId))
    const hasQuestions = !!state.currentConversationId && state.questionsConversations.has(state.currentConversationId)
    return visibleSurfaceTabs(state.pinnedTabs, state.notification, current, scratchTabs, hasQuestions).some((tab) => tab.id === id)
      ? { ...current, activeTabId: id }
      : current
  }),

  closeTab: (id) => {
    const state = get()
    const tab = state.tabs.find((item) => item.id === id)
    if (!tab) return
    // The Questions tab refuses close while input/review is required: an
    // operator answer is what retires it (the synchronizer removes it when
    // the workflow completes). This single refusal covers every close verb
    // — middle-click, keyboard, context menu, closeOthers/closeToRight all
    // funnel here or exclude it structurally below.
    if (id === QUESTIONS_SURFACE_ID) {
      rDebug('studio.surface', 'questions tab close refused: workflow requires input', {})
      return
    }
    if (id === NOTIFICATION_SURFACE_ID && state.notification) {
      const notification = null
      const conversations = { ...state.conversations }
      if (state.currentConversationId) {
        const current = conversations[state.currentConversationId] ?? emptyConversation()
        const remaining = visibleSurfaceTabs(state.pinnedTabs, notification, current)
        conversations[state.currentConversationId] = { ...current, activeTabId: current.activeTabId === id ? (remaining[0]?.id ?? null) : current.activeTabId }
      }
      set({ ...project({ ...state, notification, conversations }), notification })
      schedulePersist(get)
      rInfo('studio.surface', 'workspace notification closed', { resource_id: state.notification.resourceId, resource_kind: state.notification.resourceKind })
      return
    }
    if (state.pinnedTabs.includes(id as PinnableSingletonId)) {
      const pinnedTabs = state.pinnedTabs.filter((tabId) => tabId !== id)
      const conversations = { ...state.conversations }
      if (state.currentConversationId) {
        const current = conversations[state.currentConversationId] ?? emptyConversation()
        const remaining = visibleSurfaceTabs(pinnedTabs, state.notification, current)
        conversations[state.currentConversationId] = {
          ...current,
          activeTabId: current.activeTabId === id ? (remaining[0]?.id ?? null) : current.activeTabId,
        }
      }
      set({ ...project({ ...state, pinnedTabs, conversations }), pinnedTabs })
      schedulePersist(get)
      rInfo('studio.surface', 'pinned surface tab closed', { surface_tab: id, tab_id: state.currentConversationId ?? '' })
      return
    }
    if (tab.kind === 'scratch') {
      get().requestScratchClose(tab.projectKey, tab.documentId)
      return
    }
    if (tab.kind === 'terminal') {
      const key = `${state.currentConversationId ?? 'studio'}:surface:${tab.instanceId}`
      const activity = useSessionStore.getState().terminalActivities?.get(key)
      if (activity?.active) {
        rWarn('studio.surface', 'terminal tab close refused: terminal activity is running', { surface_tab: id, tab_id: state.currentConversationId ?? '', terminal_key: key })
        return
      }
    }
    teardownSurfaceTab(tab, state.currentConversationId)
    updateCurrent(set, get, (current) => ({ ...current, tabs: current.tabs.filter((item) => item.id !== id), activeTabId: current.activeTabId === id ? nextActiveAfterClose(state.tabs, id) : current.activeTabId }))
  },

  closeOthers: (id) => {
    const state = get()
    const targets = closeOthersTargets(state.tabs, id, [...globalSurfaceTabIds(state.pinnedTabs, state.notification), QUESTIONS_SURFACE_ID])
      .filter((tab) => tab.kind !== 'scratch')
      .filter((tab) => tab.kind !== 'terminal' || !useSessionStore.getState().terminalActivities?.get(`${state.currentConversationId ?? 'studio'}:surface:${tab.instanceId}`)?.active)
    for (const tab of targets) teardownSurfaceTab(tab, state.currentConversationId)
    const ids = new Set(targets.map((tab) => tab.id))
    updateCurrent(set, get, (current) => ({ ...current, tabs: current.tabs.filter((tab) => !ids.has(tab.id)), activeTabId: current.activeTabId && ids.has(current.activeTabId) ? id : current.activeTabId }))
  },

  closeToRight: (id) => {
    const state = get()
    const targets = closeToRightTargets(state.tabs, id, [...globalSurfaceTabIds(state.pinnedTabs, state.notification), QUESTIONS_SURFACE_ID])
      .filter((tab) => tab.kind !== 'scratch')
      .filter((tab) => tab.kind !== 'terminal' || !useSessionStore.getState().terminalActivities?.get(`${state.currentConversationId ?? 'studio'}:surface:${tab.instanceId}`)?.active)
    for (const tab of targets) teardownSurfaceTab(tab, state.currentConversationId)
    const ids = new Set(targets.map((tab) => tab.id))
    updateCurrent(set, get, (current) => ({ ...current, tabs: current.tabs.filter((tab) => !ids.has(tab.id)), activeTabId: current.activeTabId && ids.has(current.activeTabId) ? id : current.activeTabId }))
  },

  pinTab: (id) => {
    const state = get()
    if (state.pinnedTabs.includes(id)) return
    const pinnedTabs = normalizePinnedTabs([...state.pinnedTabs, id])
    const conversations = Object.fromEntries(Object.entries(state.conversations).map(([tabId, current]) => [tabId, { ...current, tabs: current.tabs.filter((tab) => tab.id !== id) }]))
    set({ ...project({ ...state, pinnedTabs, conversations }), pinnedTabs })
    schedulePersist(get)
    rInfo('studio.surface', 'surface tab pinned', { surface_tab: id })
  },

  unpinTab: (id) => {
    const state = get()
    if (!state.pinnedTabs.includes(id)) return
    const pinnedTabs = state.pinnedTabs.filter((item) => item !== id)
    const currentConversationId = state.currentConversationId
    const conversations = { ...state.conversations }
    if (currentConversationId) {
      const current = conversations[currentConversationId] ?? emptyConversation()
      conversations[currentConversationId] = { ...current, tabs: normalizeTabs([...current.tabs, { kind: 'singleton', id }]), activeTabId: current.activeTabId ?? id }
    }
    set({ ...project({ ...state, pinnedTabs, conversations }), pinnedTabs })
    schedulePersist(get)
    rInfo('studio.surface', 'surface tab unpinned', { surface_tab: id, tab_id: currentConversationId ?? '' })
  },

  updateBrowserTab: (id, patch) => updateCurrent(set, get, (current) => ({ ...current, tabs: current.tabs.map((tab) => tab.id === id && tab.kind === 'browser' ? { ...tab, ...patch } : tab) })),
  renameTerminalTab: (id, title) => updateCurrent(set, get, (current) => ({ ...current, tabs: current.tabs.map((tab) => tab.id === id && tab.kind === 'terminal' ? { ...tab, title } : tab) })),

  revealDiffFile: ({ filePath, staged }) => {
    get().openSingleton('diff')
    set((state) => ({ diffReveal: { filePath, staged, nonce: (state.diffReveal?.nonce ?? 0) + 1 } }))
  },

  ...createQuestionsSurfaceActions({
    get,
    set,
    project,
    visibleTabs: (pinnedTabs, notification, conversation, tabId) => visibleSurfaceTabs(
      pinnedTabs,
      notification,
      conversation,
      scratchTabsForProject(get().scratchProjects, projectKeyForConversation(tabId)),
    ),
    emptyConversation,
  }),
}))
