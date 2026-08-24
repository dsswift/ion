import { create } from 'zustand'
import { useSessionStore } from '../../stores/sessionStore'
import { editorDirForTab } from '../../stores/session-store-helpers'
import { usePreferencesStore } from '../../preferences'
import type { ResourceItem } from '../../../shared/types-engine'
import {
  browserTabId,
  DISPATCH_SURFACE_ID,
  fileTabId,
  previewTabId,
  terminalTabId,
  NOTIFICATION_SURFACE_ID,
  QUESTIONS_SURFACE_ID,
  type FileTab,
  type NotificationTab,
  type LegacySurfacePersisted,
  type PinnableSingletonId,
  type SingletonId,
  type SurfaceConversationPersisted,
  type SurfaceTab,
} from '../../../shared/studio-surface-types'
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
  serializeSurface,
} from '../../../shared/studio-surface-persistence'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'
import { runtimePanel, unregisterRuntimePanel } from './runtime-panel-registry'

const PERSIST_DEBOUNCE_MS = 300

type ConversationMap = Record<string, SurfaceConversationPersisted>

export interface SurfaceState {
  /** Composed global pins and active conversation descriptors. */
  tabs: SurfaceTab[]
  activeTabId: string | null
  pinnedTabs: PinnableSingletonId[]
  /** Workspace-scoped notification kept open across every conversation. */
  notification: NotificationTab | null
  conversations: ConversationMap
  currentConversationId: string | null
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
  openBrowserTab(url: string, mode: 'preview' | 'browse'): void
  openTerminalTab(cwd: string): void
  activateTab(id: string): void
  closeTab(id: string): void
  closeOthers(id: string): void
  closeToRight(id: string): void
  pinTab(id: PinnableSingletonId): void
  unpinTab(id: PinnableSingletonId): void
  updateBrowserTab(id: string, patch: Partial<{ url: string; title: string; mode: 'preview' | 'browse' }>): void
  renameTerminalTab(id: string, title: string): void
  revealDiffFile(target: { filePath: string; staged: boolean }): void
  /** Synchronizer entry: a conversation gained an open guided workflow. */
  showQuestionsSurface(tabId: string): void
  /** Synchronizer entry: a conversation's guided workflows all closed. */
  retireQuestionsSurface(tabId: string): void
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
let hydrationPromise: Promise<void> | null = null

export function resetSurfaceHydrationForTests(): void {
  hydrationPromise = null
  useSurfaceStore.setState({ hydrated: false })
}

function shouldRememberVisibility(): boolean {
  return usePreferencesStore.getState().studioSurfaceSwitchMode === 'per-conversation'
}

function emptyConversation(): SurfaceConversationPersisted {
  return { tabs: [], activeTabId: null, visible: false }
}

function visibleTabs(pinnedTabs: readonly PinnableSingletonId[], notification: NotificationTab | null, conversation: SurfaceConversationPersisted, hasQuestions = false): SurfaceTab[] {
  // The Questions tab is an explicit FORCED group ahead of the global pins:
  // composeTabs puts pins first, so changing SINGLETON_ORDER alone could
  // never place a needs-you surface leftmost. Window-transient — derived
  // from the coordinator state, never part of conversation.tabs.
  const forced: SurfaceTab[] = hasQuestions ? [{ kind: 'questions', id: QUESTIONS_SURFACE_ID }] : []
  return [...forced, ...composeTabs(pinnedTabs, conversation.tabs), ...(notification ? [notification] : [])]
}

function globalTabIds(pinnedTabs: readonly PinnableSingletonId[], notification: NotificationTab | null): string[] {
  return [...pinnedTabs, ...(notification ? [notification.id] : [])]
}

function normalizeConversation(pinnedTabs: readonly PinnableSingletonId[], notification: NotificationTab | null, conversation: SurfaceConversationPersisted, hasQuestions = false): SurfaceConversationPersisted {
  const tabs = normalizeTabs(conversation.tabs.filter((tab) => !(tab.kind === 'singleton' && pinnedTabs.includes(tab.id as PinnableSingletonId))))
  const composed = visibleTabs(pinnedTabs, notification, { ...conversation, tabs }, hasQuestions)
  return {
    tabs,
    visible: conversation.visible,
    activeTabId: conversation.activeTabId && composed.some((tab) => tab.id === conversation.activeTabId)
      ? conversation.activeTabId
      : (composed[0]?.id ?? null),
  }
}

function project(state: Pick<SurfaceState, 'pinnedTabs' | 'notification' | 'conversations' | 'currentConversationId' | 'visible'> & { questionsConversations?: Set<string> }): Pick<SurfaceState, 'tabs' | 'activeTabId' | 'conversations' | 'visible'> {
  if (!state.currentConversationId) return { tabs: [], activeTabId: null, conversations: state.conversations, visible: state.visible }
  const hasQuestions = state.questionsConversations?.has(state.currentConversationId) ?? false
  const current = normalizeConversation(state.pinnedTabs, state.notification, state.conversations[state.currentConversationId] ?? emptyConversation(), hasQuestions)
  const conversations = { ...state.conversations, [state.currentConversationId]: current }
  return { tabs: visibleTabs(state.pinnedTabs, state.notification, current, hasQuestions), activeTabId: current.activeTabId, conversations, visible: state.visible }
}

function schedulePersist(get: () => SurfaceState): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    const state = get()
    void window.ion.studioSetSetting('studioSurface', serializeSurface(state.pinnedTabs, state.notification, state.conversations))
      .then((ok) => {
        if (!ok) rWarn('studio.surface', 'surface persist rejected by validator', { conversation_count: Object.keys(state.conversations).length })
        else rDebug('studio.surface', 'surface state persisted', { conversation_count: Object.keys(state.conversations).length, pinned_count: state.pinnedTabs.length })
      })
      .catch((err) => rWarn('studio.surface', 'surface persist failed', { error: String(err) }))
  }, PERSIST_DEBOUNCE_MS)
}

function materializeFileBuffer(filePath: string, dir: string, tabId: string | undefined): string | null {
  const sessionState = useSessionStore.getState()
  if (tabId) {
    const tab = sessionState.tabs.find((item) => item.id === tabId)
    if (!tab) {
      rWarn('studio.surface', 'materializeFileBuffer: source tab gone, skipping', { tab_id: tabId, file_path: filePath })
      return null
    }
    const resolvedDir = editorDirForTab(tab)
    sessionState.openFileInEditor(resolvedDir, tabId, filePath)
    return resolvedDir
  }
  sessionState.openFileInEditor(dir, '', filePath)
  return dir
}

function materializeConversation(conversation: SurfaceConversationPersisted): SurfaceConversationPersisted {
  const tabs: SurfaceTab[] = []
  for (const tab of conversation.tabs) {
    if (tab.kind !== 'file') {
      tabs.push(tab)
      continue
    }
    const dir = materializeFileBuffer(tab.filePath, tab.dir, tab.tabId)
    if (dir !== null) tabs.push({ ...tab, dir })
  }
  return { ...conversation, tabs }
}

function teardown(tab: SurfaceTab): void {
  if (tab.kind === 'terminal') {
    void window.ion.terminalDestroy?.(`studio:${tab.instanceId}`)
    rDebug('studio.surface', 'terminal tab closed, pty destroyed', { instance_id: tab.instanceId })
  }
  if (tab.kind === 'runtime-panel') {
    const entry = runtimePanel(tab.id)
    unregisterRuntimePanel(tab.id)
    entry?.close()
  }
}

function updateCurrent(set: (partial: Partial<SurfaceState>) => void, get: () => SurfaceState, update: (current: SurfaceConversationPersisted) => SurfaceConversationPersisted): void {
  const state = get()
  // Content routes can fire before the Studio sync subscription has observed
  // its first owner tab push. Resolve the live session target here so the
  // route never loses a deliberate open during that short boot interval.
  const id = state.currentConversationId ?? useSessionStore.getState().activeTabId
  if (!id) return
  const current = state.conversations[id] ?? emptyConversation()
  const conversations = { ...state.conversations, [id]: normalizeConversation(state.pinnedTabs, state.notification, update(current)) }
  set({ ...project({ ...state, conversations, currentConversationId: id }), currentConversationId: id })
  schedulePersist(get)
}

export const useSurfaceStore = create<SurfaceState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  pinnedTabs: [],
  notification: null,
  conversations: {},
  currentConversationId: null,
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
        if (!parsed) {
          const empty = emptySurfacePersisted()
          set({ ...project({ pinnedTabs: empty.pinnedTabs, notification: empty.notification, conversations: {}, currentConversationId, visible: false }), pinnedTabs: empty.pinnedTabs, notification: empty.notification, currentConversationId, hydrated: true })
          rDebug('studio.surface', 'no persisted surface, starting with default pins')
          return
        }
        if (parsed.version === 1) {
          const legacy = parsed as LegacySurfacePersisted
          const legacyVisible = settings?.studioLayout && typeof settings.studioLayout === 'object' && (settings.studioLayout as { surfaceVisible?: unknown }).surfaceVisible === true
          const conversations = currentConversationId
            ? { [currentConversationId]: { tabs: legacy.tabs, activeTabId: legacy.activeTabId, visible: legacyVisible } }
            : {}
          const pinnedTabs: PinnableSingletonId[] = ['plan']
          const local = currentConversationId ? conversations[currentConversationId]! : emptyConversation()
          for (const pin of pinnedTabs) local.tabs = local.tabs.filter((tab: SurfaceTab) => tab.id !== pin)
          if (currentConversationId) conversations[currentConversationId] = local
          const state = { pinnedTabs, notification: null, conversations, currentConversationId, visible: shouldRememberVisibility() ? legacyVisible : false }
          set({ ...project(state), pinnedTabs, currentConversationId, hydrated: true })
          rInfo('studio.surface', 'legacy surface migrated to conversation state', { tab_id: currentConversationId ?? '', tab_count: legacy.tabs.length })
          schedulePersist(get)
          return
        }
        const conversations = Object.fromEntries(Object.entries(parsed.conversations).map(([id, conversation]) => [id, materializeConversation(conversation)]))
        const initial = { pinnedTabs: parsed.pinnedTabs, notification: parsed.notification, conversations, currentConversationId, visible: false }
        const current = currentConversationId ? conversations[currentConversationId] : null
        initial.visible = shouldRememberVisibility() ? (current?.visible ?? false) : false
        set({ ...project(initial), pinnedTabs: parsed.pinnedTabs, notification: parsed.notification, currentConversationId, hydrated: true })
        rDebug('studio.surface', 'surface hydrated', { conversation_count: Object.keys(conversations).length, pinned_count: parsed.pinnedTabs.length, tab_id: currentConversationId ?? '' })
      } catch (err) {
        const currentConversationId = useSessionStore.getState().activeTabId
        const empty = emptySurfacePersisted()
        set({ ...project({ pinnedTabs: empty.pinnedTabs, notification: empty.notification, conversations: {}, currentConversationId, visible: false }), pinnedTabs: empty.pinnedTabs, notification: empty.notification, currentConversationId, hydrated: true })
        rWarn('studio.surface', 'surface hydrate failed, starting with default pins', { error: String(err) })
      }
    })()
    return hydrationPromise
  },

  selectConversation: (currentConversationId) => {
    const state = get()
    const saved = currentConversationId ? state.conversations[currentConversationId]?.visible ?? false : false
    let visible = shouldRememberVisibility() ? saved : state.visible

    // Entering a conversation that owes the operator an answer ALWAYS lands on
    // the Questions tab with the pane open, whatever the saved per-conversation
    // focus or visibility mode said. A parked question is the one surface the
    // run cannot continue without, and restoring "whatever was focused last
    // time" hid it behind a Diff or Explorer tab — the operator then sees an
    // idle conversation with no indication it is waiting on them.
    //
    // This is a re-entry default, not a lock: once here, they may switch to
    // any other tab freely (nothing re-forces focus while they stay), and the
    // next re-entry defaults to Questions again while the question is still
    // outstanding.
    const conversations = { ...state.conversations }
    const owesAnswer = !!currentConversationId && state.questionsConversations.has(currentConversationId)
    if (owesAnswer && currentConversationId) {
      const current = conversations[currentConversationId] ?? emptyConversation()
      conversations[currentConversationId] = { ...current, activeTabId: QUESTIONS_SURFACE_ID }
      visible = true
    }

    set({
      ...project({ ...state, conversations, currentConversationId, visible }),
      currentConversationId,
    })
    rDebug('studio.surface', 'conversation selected', {
      tab_id: currentConversationId ?? '',
      active_surface_tab: currentConversationId ? (conversations[currentConversationId]?.activeTabId ?? '') : '',
      visible,
      mode: shouldRememberVisibility() ? 'per-conversation' : 'keep',
      forced_questions: owesAnswer,
    })
  },

  setVisible: (visible) => {
    const state = get()
    // Pane close is refused while the current conversation has a live
    // guided-questions workflow requiring input: hiding the canvas would
    // bury the one surface the run is blocked on.
    if (!visible && state.currentConversationId && state.questionsConversations.has(state.currentConversationId)) {
      rDebug('studio.surface', 'canvas hide refused: questions workflow requires input', { tab_id: state.currentConversationId })
      return
    }
    if (shouldRememberVisibility() && state.currentConversationId) {
      updateCurrent(set, get, (current) => ({ ...current, visible }))
      set({ visible })
    } else {
      set({ visible })
      rDebug('studio.surface', 'live surface visibility changed without persistence', { visible, mode: 'keep' })
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
    const id = fileTabId(filePath)
    const resolvedDir = materializeFileBuffer(filePath, dir, tabId)
    if (resolvedDir === null) return
    updateCurrent(set, get, (current) => ({ ...current, tabs: current.tabs.some((tab) => tab.id === id) ? current.tabs : normalizeTabs([...current.tabs, { kind: 'file', id, filePath, dir: resolvedDir, tabId } as FileTab]), activeTabId: id }))
  },

  openPreviewTab: (filePath, dataUrl) => {
    const id = previewTabId(filePath)
    updateCurrent(set, get, (current) => {
      const old = current.tabs.find((tab) => tab.id === id)
      const tabs = old?.kind === 'preview' ? current.tabs.map((tab) => tab.id === id ? { ...old, dataUrl: dataUrl ?? old.dataUrl } : tab) : normalizeTabs([...current.tabs, { kind: 'preview', id, filePath, dataUrl }])
      return { ...current, tabs, activeTabId: id }
    })
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
    updateCurrent(set, get, (current) => ({ ...current, tabs: current.tabs.filter((tab) => tab.id !== id), activeTabId: current.activeTabId === id ? nextActiveAfterClose(visibleTabs(get().pinnedTabs, get().notification, current), id) : current.activeTabId }))
  },

  openBrowserTab: (url, mode) => {
    const instanceId = crypto.randomUUID()
    const id = browserTabId(instanceId)
    updateCurrent(set, get, (current) => ({ ...current, tabs: normalizeTabs([...current.tabs, { kind: 'browser', id, instanceId, url, title: url, mode }]), activeTabId: id }))
  },

  openTerminalTab: (cwd) => {
    const instanceId = crypto.randomUUID()
    const id = terminalTabId(instanceId)
    updateCurrent(set, get, (current) => ({ ...current, tabs: normalizeTabs([...current.tabs, { kind: 'terminal', id, instanceId, cwd, title: nextTerminalTitle(visibleTabs(get().pinnedTabs, get().notification, current)) }]), activeTabId: id }))
  },

  activateTab: (id) => updateCurrent(set, get, (current) => visibleTabs(get().pinnedTabs, get().notification, current).some((tab) => tab.id === id) ? { ...current, activeTabId: id } : current),

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
        const remaining = visibleTabs(state.pinnedTabs, notification, current)
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
        const remaining = visibleTabs(pinnedTabs, state.notification, current)
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
    teardown(tab)
    updateCurrent(set, get, (current) => ({ ...current, tabs: current.tabs.filter((item) => item.id !== id), activeTabId: current.activeTabId === id ? nextActiveAfterClose(state.tabs, id) : current.activeTabId }))
  },

  closeOthers: (id) => {
    const state = get()
    const targets = closeOthersTargets(state.tabs, id, [...globalTabIds(state.pinnedTabs, state.notification), QUESTIONS_SURFACE_ID])
    for (const tab of targets) teardown(tab)
    const ids = new Set(targets.map((tab) => tab.id))
    updateCurrent(set, get, (current) => ({ ...current, tabs: current.tabs.filter((tab) => !ids.has(tab.id)), activeTabId: current.activeTabId && ids.has(current.activeTabId) ? id : current.activeTabId }))
  },

  closeToRight: (id) => {
    const state = get()
    const targets = closeToRightTargets(state.tabs, id, [...globalTabIds(state.pinnedTabs, state.notification), QUESTIONS_SURFACE_ID])
    for (const tab of targets) teardown(tab)
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

  showQuestionsSurface: (tabId) => {
    const state = get()
    if (state.questionsConversations.has(tabId)) return
    const questionsConversations = new Set(state.questionsConversations)
    questionsConversations.add(tabId)
    // Remember what was focused so completion can restore it (per
    // conversation; only when Questions is about to steal focus).
    const isCurrent = state.currentConversationId === tabId
    const questionsPriorActive = isCurrent
      ? { ...state.questionsPriorActive, [tabId]: state.activeTabId }
      : state.questionsPriorActive
    const conversations = { ...state.conversations }
    if (isCurrent) {
      const current = conversations[tabId] ?? emptyConversation()
      conversations[tabId] = { ...current, activeTabId: QUESTIONS_SURFACE_ID }
    }
    const next = { ...state, questionsConversations, conversations }
    set({
      ...project(next),
      questionsConversations,
      questionsPriorActive,
      // Open the pane: a guided wait hidden behind a closed canvas looks
      // like a hang. Visibility is live-only (not persisted per the keep
      // mode rules) — setVisible semantics preserved by direct set.
      ...(isCurrent ? { visible: true } : {}),
    })
    rInfo('studio.surface', 'questions surface shown', { tab_id: tabId, focused: isCurrent })
  },

  retireQuestionsSurface: (tabId) => {
    const state = get()
    if (!state.questionsConversations.has(tabId)) return
    const questionsConversations = new Set(state.questionsConversations)
    questionsConversations.delete(tabId)
    const prior = state.questionsPriorActive[tabId]
    const questionsPriorActive = { ...state.questionsPriorActive }
    delete questionsPriorActive[tabId]
    const conversations = { ...state.conversations }
    const current = conversations[tabId]
    if (current && current.activeTabId === QUESTIONS_SURFACE_ID) {
      // Restore the pre-Questions focus when still valid; otherwise the
      // normal normalization fallback picks the first composed tab.
      const composed = visibleTabs(state.pinnedTabs, state.notification, current, false)
      const restored = prior && composed.some((tab) => tab.id === prior) ? prior : (composed[0]?.id ?? null)
      conversations[tabId] = { ...current, activeTabId: restored }
    }
    set({ ...project({ ...state, questionsConversations, conversations }), questionsConversations, questionsPriorActive })
    rInfo('studio.surface', 'questions surface retired', { tab_id: tabId, restored: prior ?? '' })
  },
}))
