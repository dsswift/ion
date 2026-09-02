/**
 * secondary-store — boots the session store in MIRROR mode for the Studio window
 * window (see shared/studio-mirror-actions.ts and the Studio shell ADR).
 *
 * Importing the sessionStore module in this window already skips
 * persistence (window-role detection). This module applies the second half
 * of the mirror discipline: every FORWARDED action is swapped for an IPC
 * forwarder, so owner-durable mutations execute in the overlay renderer —
 * Zustand actions are plain state fields, so the swap is a setState.
 */
import { useSessionStore } from '../../stores/sessionStore'
import { destroyTerminalInstance } from '../../components/TerminalInstance'
import {
  isStudioConversationTerminalSnapshot,
  removedConversationTerminalKeys,
  terminalPaneMap,
  type StudioConversationTerminalSnapshot,
} from '../../../shared/studio-conversation-terminal-sync'
import { FORWARDED_ACTIONS } from '../../../shared/studio-mirror-actions'
import { tabsFromSnapshot, mergePanes } from './hydrate-tabs'
import { commitInstance } from '../../stores/conversation-instance'
import type { FileAttachment, Message, PersistedTabState } from '../../../shared/types'
import type { RewindResult } from '../../stores/session-store-types'
import type { StudioUserMessageEcho, StudioHistoryReplace, StudioWorktreeSnapshot } from '../../../shared/types-studio'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'

let applied = false

let tabsSyncPromise: Promise<void> | null = null
let terminalSyncPromise: Promise<void> | null = null
let resolveTerminalSync: (() => void) | null = null
let lastSnapshotRevision = -1
let lastTerminalSnapshotRevision = -1
let lastWorktreeSnapshotRevision = -1
let worktreeSyncPromise: Promise<void> | null = null
let worktreeReady = false
let resolveWorktreeSync: (() => void) | null = null

const pendingUserMessageEchoes = new Map<string, StudioUserMessageEcho[]>()
const pendingHistoryReplacements = new Map<string, StudioHistoryReplace>()
let pendingActiveTabId: string | null = null

function hasMirrorTab(tabId: string): boolean {
  const state = useSessionStore.getState()
  return state.tabs.some((tab) => tab.id === tabId) && state.conversationPanes.has(tabId)
}

/** Apply an owner active-tab target only after owner sync creates its pane. */
export function consumeStudioActiveTab(tabId: string): void {
  if (!hasMirrorTab(tabId)) {
    pendingActiveTabId = tabId
    rDebug('studio.mirror', 'active tab queued until owner sync', { tab_id: tabId })
    return
  }
  pendingActiveTabId = null
  useSessionStore.setState({ activeTabId: tabId })
}

function drainActiveTab(): void {
  if (pendingActiveTabId && hasMirrorTab(pendingActiveTabId)) {
    const tabId = pendingActiveTabId
    pendingActiveTabId = null
    useSessionStore.setState({ activeTabId: tabId })
    rDebug('studio.mirror', 'queued active tab applied after owner sync', { tab_id: tabId })
  }
}
/** Insert a typed echo once its owner tab and conversation pane exist. */
export function applyUserMessageEcho(tabId: string, echo: StudioUserMessageEcho): boolean {
  if (!hasMirrorTab(tabId)) {
    return false
  }
  useSessionStore.setState((current) => {
    const conversationPanes = commitInstance(current.conversationPanes, tabId, (inst) => {
      if (inst.messages.some((message) => message.id === echo.id)) return inst
      return {
        ...inst,
        messages: [...inst.messages, {
          id: echo.id,
          role: 'user',
          content: echo.content,
          timestamp: echo.timestamp,
          ...(echo.implementationPhase ? { implementationPhase: true } : {}),
          // Carries the questions-submission classification so the mirror
          // renders the same frame the Overlay does. The mirror constructs
          // the Message itself, so an omission here is invisible until the
          // two presentations are compared side by side.
          ...(echo.injectionKind ? { injectionKind: echo.injectionKind } : {}),
        }],
      }
    })
    return conversationPanes === current.conversationPanes ? {} : { conversationPanes }
  })
  return true
}

/** Queue an echo until owner tab sync creates its pane, then consume it once. */
export function consumeUserMessageEcho(tabId: string, echo: StudioUserMessageEcho): void {
  if (applyUserMessageEcho(tabId, echo)) return
  const pending = pendingUserMessageEchoes.get(tabId) ?? []
  if (!pending.some((item) => item.id === echo.id)) pending.push(echo)
  pendingUserMessageEchoes.set(tabId, pending)
  rDebug('studio.mirror', 'user message echo queued', { tab_id: tabId, message_id: echo.id })
}

/** Drain queued echoes after hydration establishes owner tab and pane. */
export function drainUserMessageEchoes(): void {
  for (const [tabId, echoes] of pendingUserMessageEchoes) {
    const remaining = echoes.filter((echo) => !applyUserMessageEcho(tabId, echo))
    if (remaining.length === 0) pendingUserMessageEchoes.delete(tabId)
    else pendingUserMessageEchoes.set(tabId, remaining)
  }
}

/** Wait for one structurally valid owner snapshot, rejecting rejected boot pulls. */
export function waitForTabsSync(): Promise<void> {
  if (useSessionStore.getState().tabsReady) return Promise.resolve()
  if (tabsSyncPromise) return tabsSyncPromise
  tabsSyncPromise = new Promise((resolve, reject) => {
    const unsubscribe = useSessionStore.subscribe((next) => {
      if (next.tabsReady) {
        unsubscribe()
        resolve()
      }
    })
    void window.ion.studioGetTabsSync().then((snapshot) => {
      if (!snapshot) throw new Error('owner tabs snapshot unavailable')
      hydrateTabsFromSync(snapshot)
    }).catch((err) => {
      unsubscribe()
      tabsSyncPromise = null
      reject(err)
    })
  })
  return tabsSyncPromise
}

/**
 * Replace the mirror's tab metadata from an owner-published snapshot.
 * Existing conversation panes are kept (lazy-loaded messages, live streams);
 * panes for owner-closed tabs are dropped.
 */
export function hydrateTabsFromSync(snapshot: unknown): void {
  if (snapshot == null || typeof snapshot !== 'object' || !Array.isArray((snapshot as PersistedTabState).tabs)) {
    rWarn('studio.mirror', 'tabs-sync snapshot malformed, ignored')
    return
  }
  const revision = (snapshot as { revision?: unknown }).revision
  if (typeof revision === 'number' && Number.isSafeInteger(revision)) {
    if (revision <= lastSnapshotRevision) return
    lastSnapshotRevision = revision
  }
  const typed = snapshot as PersistedTabState
  const liveTabStatus = (snapshot as { liveTabStatus?: Record<string, string> }).liveTabStatus
  const queuedAttachments = (snapshot as { queuedAttachments?: Record<string, FileAttachment[]> }).queuedAttachments
  const { tabs, settledHistory, activeTabId } = tabsFromSnapshot(typed, liveTabStatus, useSessionStore.getState().tabs, queuedAttachments)
  useSessionStore.setState((s) => ({
    tabs,
    settledHistory,
    // The owner's active tab is authoritative; studio:active-tab pushes keep it
    // fresh between syncs.
    activeTabId: activeTabId ?? s.activeTabId,
    conversationPanes: mergePanes(s.conversationPanes, typed, tabs),
    tabsReady: true,
  }))
  drainActiveTab()
  drainHistoryReplacements()
  drainUserMessageEchoes()
  rDebug('studio.mirror', 'tabs hydrated from owner sync', { tab_count: tabs.length })
}

/** Boot + live wiring for owner tab-metadata sync. Returns unsubscribe. */
export function initTabsSync(): () => void {
  void waitForTabsSync().catch((err) => rWarn('studio.mirror', 'initial tabs sync failed', { error: String(err) }))
  return window.ion.onStudioTabsSync((snapshot) => hydrateTabsFromSync(snapshot))
}

/** Apply one complete Conversation Terminal Panel snapshot to the mirror. */
export function hydrateConversationTerminals(snapshot: unknown): boolean {
  if (!isStudioConversationTerminalSnapshot(snapshot)) {
    rWarn('studio.terminal-sync', 'terminal snapshot malformed, ignored')
    return false
  }
  if (snapshot.revision <= lastTerminalSnapshotRevision) return false

  const current = useSessionStore.getState()
  const terminalPanes = terminalPaneMap(snapshot)
  const removedKeys = removedConversationTerminalKeys(current.terminalPanes, terminalPanes)
  lastTerminalSnapshotRevision = snapshot.revision
  const openTabIds = new Set(snapshot.openTabIds)
  useSessionStore.setState({
    terminalPanes,
    terminalOpenTabIds: openTabIds,
    ...(current.terminalTallTabId && !openTabIds.has(current.terminalTallTabId)
      ? { terminalTallTabId: null }
      : {}),
    ...(current.terminalBigScreenTabId && !openTabIds.has(current.terminalBigScreenTabId)
      ? { terminalBigScreenTabId: null }
      : {}),
  })
  for (const key of removedKeys) destroyTerminalInstance(key)
  resolveTerminalSync?.()
  resolveTerminalSync = null
  rDebug('studio.terminal-sync', 'terminal snapshot hydrated', {
    revision: snapshot.revision,
    conversation_count: snapshot.panes.length,
    terminal_count: snapshot.panes.reduce((total, pane) => total + pane.instances.length, 0),
    removed_viewer_count: removedKeys.length,
  })
  return true
}

/** Wait until Studio has the owner's current Conversation Terminal Panel state. */
export function waitForConversationTerminalSync(): Promise<void> {
  if (lastTerminalSnapshotRevision >= 0) return Promise.resolve()
  if (terminalSyncPromise) return terminalSyncPromise
  terminalSyncPromise = new Promise((resolve, reject) => {
    resolveTerminalSync = resolve
    void window.ion.studioGetConversationTerminals().then((snapshot) => {
      if (snapshot) hydrateConversationTerminals(snapshot)
      else rDebug('studio.terminal-sync', 'owner terminal snapshot not ready; waiting for live push')
    }).catch((error) => {
      terminalSyncPromise = null
      resolveTerminalSync = null
      reject(error)
    })
  })
  return terminalSyncPromise
}

/** Boot pull plus live owner snapshot subscription. */
export function initConversationTerminalSync(): () => void {
  const unsubscribe = window.ion.onStudioConversationTerminals((snapshot: StudioConversationTerminalSnapshot) => {
    hydrateConversationTerminals(snapshot)
  })
  void waitForConversationTerminalSync().catch((error) =>
    rWarn('studio.terminal-sync', 'initial terminal sync failed', { error: String(error) }))
  return unsubscribe
}

/** Replace the mirror's derived worktree state from one complete owner snapshot. */
export function hydrateWorktreeFromSync(snapshot: StudioWorktreeSnapshot): boolean {
  if (!snapshot || typeof snapshot !== 'object' || !Number.isSafeInteger(snapshot.revision)) {
    rWarn('studio.mirror', 'worktree snapshot malformed, ignored')
    return false
  }
  if (snapshot.revision <= lastWorktreeSnapshotRevision) return false
  lastWorktreeSnapshotRevision = snapshot.revision
  useSessionStore.setState({
    worktreeInventory: new Map(Object.entries(snapshot.inventory)),
    benchWorkspaces: new Map(Object.entries(snapshot.workspaces)),
    benchSourceTips: new Map(snapshot.benchSourceTips),
    benchRetired: new Map(snapshot.benchRetired.map(([repoPath, entries]) => [repoPath, new Map(entries)])),
    gitConflictAlerts: new Map(snapshot.gitConflictAlerts),
    worktreePipeline: snapshot.worktreePipeline as never,
    workspaceOperationLedger: new Map(snapshot.workspaceOperationLedger.map((operation) => [operation.id, operation])),
  })
  rDebug('studio.mirror', 'worktree snapshot hydrated', {
    revision: snapshot.revision,
    ready: String(snapshot.ready),
    repositories: Object.keys(snapshot.inventory).length,
  })
  if (snapshot.ready) {
    worktreeReady = true
    resolveWorktreeSync?.()
    resolveWorktreeSync = null
  }
  return snapshot.ready
}

/** Wait for the owner worktree read model so Inbox does not render an empty cache. */
export function waitForWorktreeSync(): Promise<void> {
  if (worktreeReady) return Promise.resolve()
  if (worktreeSyncPromise) return worktreeSyncPromise
  worktreeSyncPromise = new Promise((resolve, reject) => {
    resolveWorktreeSync = resolve
    const consume = (snapshot: StudioWorktreeSnapshot | null): void => {
      if (!snapshot) throw new Error('owner worktree snapshot unavailable')
      if (hydrateWorktreeFromSync(snapshot) || snapshot.ready) {
        resolveWorktreeSync = null
        resolve()
      }
    }
    void window.ion.studioGetWorktreeSync().then(consume).catch((error) => {
      worktreeSyncPromise = null
      resolveWorktreeSync = null
      reject(error)
    })
  })
  return worktreeSyncPromise
}

/** Boot pull plus live owner snapshot subscription. */
export function initWorktreeSync(): () => void {
  void waitForWorktreeSync().catch((error) => rWarn('studio.mirror', 'initial worktree sync failed', { error: String(error) }))
  return window.ion.onStudioWorktreeSync((snapshot) => {
    const ready = hydrateWorktreeFromSync(snapshot)
    if (ready && worktreeSyncPromise === null) worktreeSyncPromise = Promise.resolve()
  })
}

/**
 * Remove a resolved permission from the mirror's queue for the tab —
 * consumed from studio:permission-resolved pushes so an answer given on ANY
 * surface (overlay card, iOS, Studio) clears the mirror instantly. Idempotent
 * with the local optimistic removal respondPermission already performs.
 */
export function removeResolvedPermission(tabId: string, questionId: string): void {
  useSessionStore.setState((s) => {
    const pane = s.conversationPanes.get(tabId)
    if (!pane) return {}
    let changed = false
    const instances = pane.instances.map((inst) => {
      if (!inst.permissionQueue.some((p) => p.questionId === questionId)) return inst
      changed = true
      return { ...inst, permissionQueue: inst.permissionQueue.filter((p) => p.questionId !== questionId) }
    })
    if (!changed) return {}
    const conversationPanes = new Map(s.conversationPanes)
    conversationPanes.set(tabId, { ...pane, instances })
    rDebug('studio.mirror', 'permission resolved push consumed', { tab_id: tabId.slice(0, 8), question_id: questionId })
    return { conversationPanes }
  })
}

/** Wire the resolution push. Returns unsubscribe. */
export function initPermissionResolutionSync(): () => void {
  return window.ion.onStudioPermissionResolved((tabId, questionId) => removeResolvedPermission(tabId, questionId))
}

/**
 * Wire the user-message echo: the owner does the optimistic transcript
 * insert in ITS store, and user turns never ride normalized events — this
 * push keeps the mirror transcript complete regardless of which surface
 * (overlay, Studio, iOS) submitted the prompt.
 */
export function initUserMessageEcho(): () => void {
  return window.ion.onStudioUserMessageEcho((tabId, echo) => {
    if (
      typeof echo?.id === 'string' && echo.id.length > 0 &&
      typeof echo.content === 'string' && echo.content.length > 0 &&
      typeof echo.timestamp === 'number' && Number.isFinite(echo.timestamp)
    ) {
      consumeUserMessageEcho(tabId, echo)
    } else {
      rWarn('studio.mirror', 'user message echo malformed, ignored', { tab_id: tabId })
    }
  })
}

/**
 * Replace one pane instance's message list wholesale after a successful
 * owner-side engine rewind. Unlike the user-message echo (which appends), a
 * history replace must REPLACE — the owner already branched its engine tree
 * and truncated its own store; the mirror's stale tail past the rewind point
 * must never survive a successful owner branch. Targets the payload's
 * `instanceId` directly rather than going through `commitInstance` (which
 * only ever targets the pane's ACTIVE instance) because a rewind can commit
 * against a background instance the mirror is not currently viewing.
 */
export function applyHistoryReplace(payload: StudioHistoryReplace): boolean {
  if (!hasMirrorTab(payload.tabId)) return false
  useSessionStore.setState((current) => {
    const pane = current.conversationPanes.get(payload.tabId)
    if (!pane) return {}
    const targetId = payload.instanceId ?? pane.activeInstanceId ?? pane.instances[0]?.id
    if (!targetId) return {}
    const idx = pane.instances.findIndex((i) => i.id === targetId)
    if (idx === -1) return {}
    const messages: Message[] = payload.messages.map((m) => ({
      id: m.id,
      role: m.role as Message['role'],
      content: m.content,
      toolName: m.toolName,
      toolId: m.toolId,
      toolStatus: m.toolStatus as Message['toolStatus'],
      timestamp: m.timestamp,
      dedupKey: m.dedupKey,
      planFilePath: m.planFilePath,
      injectionKind: m.injectionKind,
      attachments: m.attachments as Message['attachments'],
    }))
    const instances = pane.instances.slice()
    instances[idx] = {
      ...instances[idx],
      messages,
      messageCount: messages.length,
      historyHydrated: true,
      historyHydrationFailed: false,
    }
    const conversationPanes = new Map(current.conversationPanes)
    conversationPanes.set(payload.tabId, { ...pane, instances })
    return { conversationPanes }
  })
  return true
}

/** Apply fork history once the owner snapshot has created the mirror pane. */
function drainHistoryReplacements(): void {
  for (const [tabId, payload] of pendingHistoryReplacements) {
    if (!applyHistoryReplace(payload)) continue
    pendingHistoryReplacements.delete(tabId)
    rDebug('studio.mirror', 'queued history replacement applied after owner sync', { tab_id: tabId })
  }
}

/**
 * Wire the history-replace push: fired only after the owner's engine rewind
 * commits, so the mirror converges to the exact same committed transcript
 * instead of retaining stale post-rewind rows. No queue-until-hydrated path
 * like the user-message echo — a rewind targets an EXISTING pane the mirror
 * has already hydrated (rewind is only offered on an idle, already-rendered
 * conversation), so a payload arriving before the mirror has the tab is
 * logged and dropped rather than queued.
 */
export function initHistoryReplace(): () => void {
  return window.ion.onStudioHistoryReplace((payload) => {
    if (
      typeof payload?.tabId === 'string' && payload.tabId.length > 0 &&
      Array.isArray(payload.messages)
    ) {
      if (!applyHistoryReplace(payload)) {
        if (payload.queueUntilTabExists) {
          pendingHistoryReplacements.set(payload.tabId, payload)
          rDebug('studio.mirror', 'history replacement queued until owner sync', { tab_id: payload.tabId })
        } else {
          rWarn('studio.mirror', 'history replace arrived before mirror tab existed, dropped', { tab_id: payload.tabId })
        }
      }
    } else {
      rWarn('studio.mirror', 'history replace malformed, ignored', { tab_id: String(payload?.tabId ?? '') })
    }
  })
}

export function reconcileAttachmentTabs(
  tabs: ReturnType<typeof useSessionStore.getState>['tabs'],
  activeTabId: string | null,
  action: string,
  args: unknown[],
): ReturnType<typeof useSessionStore.getState>['tabs'] {
  if (!activeTabId || !['addAttachments', 'removeAttachment', 'clearAttachments'].includes(action)) return tabs

  return tabs.map((tab) => {
    if (tab.id !== activeTabId) return tab
    if (action === 'addAttachments' && Array.isArray(args[0])) {
      return { ...tab, attachments: [...tab.attachments, ...(args[0] as FileAttachment[])] }
    }
    if (action === 'removeAttachment' && typeof args[0] === 'string') {
      return { ...tab, attachments: tab.attachments.filter((attachment) => attachment.id !== args[0]) }
    }
    if (action === 'clearAttachments') return { ...tab, attachments: [] }
    return tab
  })
}

export function reconcileForwardedAttachments(action: string, args: unknown[]): void {
  useSessionStore.setState((state) => ({
    tabs: reconcileAttachmentTabs(state.tabs, state.activeTabId, action, args),
  }))
}

/**
 * Restore the rewound turn in the Studio-local composer after the owner accepts
 * a forwarded rewind. History replacement and composer restoration are separate
 * state changes: the former removes the stale transcript tail, while this result
 * carries the user text and resendable attachments that no longer exist in that
 * transcript.
 */
export function reconcileForwardedRewind(action: string, args: unknown[], value: unknown): boolean {
  if (action !== 'rewindEngineInstance') return false
  const result = value as RewindResult | undefined
  if (!result?.ok) return false
  const tabId = args[0]
  const instanceId = args[1]
  const prefill = result.prefill
  if (
    typeof tabId !== 'string' || typeof instanceId !== 'string' ||
    typeof prefill?.text !== 'string' || !Array.isArray(prefill.attachments)
  ) {
    rWarn('studio.mirror', 'rewind prefill result malformed, ignored', {
      tab_id: typeof tabId === 'string' ? tabId : '',
      instance_id: typeof instanceId === 'string' ? instanceId : '',
    })
    return false
  }

  const current = useSessionStore.getState()
  const pane = current.conversationPanes.get(tabId)
  const instanceIndex = pane?.instances.findIndex((instance) => instance.id === instanceId) ?? -1
  if (!pane || instanceIndex < 0 || !current.tabs.some((tab) => tab.id === tabId)) {
    rWarn('studio.mirror', 'rewind prefill target missing, ignored', {
      tab_id: tabId,
      instance_id: instanceId,
    })
    return false
  }

  const instances = pane.instances.slice()
  instances[instanceIndex] = { ...instances[instanceIndex], draftInput: prefill.text }
  const conversationPanes = new Map(current.conversationPanes)
  conversationPanes.set(tabId, { ...pane, instances })
  useSessionStore.setState({
    conversationPanes,
    tabs: current.tabs.map((tab) => tab.id === tabId
      ? { ...tab, pendingInput: prefill.text, attachments: prefill.attachments }
      : tab),
  })
  rInfo('studio.mirror', 'rewind prefill restored', {
    tab_id: tabId,
    instance_id: instanceId,
    text_length: prefill.text.length,
    attachment_count: prefill.attachments.length,
  })
  return true
}

/**
 * Swap forwarded actions for IPC forwarders. Idempotent. Returns the list of
 * swapped action names (for logging/tests).
 *
 * ── The forwarder's return contract ─────────────────────────────────────────
 * Every override returns a PROMISE that resolves to the OWNER'S actual return
 * value, so a forwarded action behaves in the mirror the way its signature says
 * it does. The round trip is `studioCallAction`: main mints a callId, relays it to
 * the owner renderer, and resolves when the owner replies with the value its
 * store action produced.
 *
 * Both halves of that matter, and both were once wrong:
 *
 *   - Returning a promise at all. The real store actions are `async` and call
 *     sites chain on that — `.then()`, `.catch()`, `.finally()`, `await`. A
 *     `void`-returning override turned each into `TypeError: Cannot read
 *     properties of undefined (reading 'then')` inside a click handler, and
 *     TypeScript could not catch it because the overrides are installed through
 *     `setState(... as never)`, so every call site still saw the store's
 *     promise-returning types. Observed on the AI-assisted conflict resolver:
 *     its `.catch` — the branch that surfaces a refusal in the error banner —
 *     never ran, and the dialog neither closed nor reported.
 *   - Resolving the real VALUE. A resolved-but-empty promise fixed the crash
 *     but left `const result = await store.retireWorktree(…)` reading fields off
 *     `undefined`, so an await-and-inspect call site still could not work in the
 *     mirror. Now it can.
 *
 * The promise never rejects. A transport fault (no owner window, owner did not
 * reply before main's deadline) resolves `undefined` and is logged here, because
 * "the round trip failed" and "the action returned nothing" are the same thing
 * from a caller's perspective: no answer is available. Domain failures are
 * unaffected — an action that returns `{ ok: false, error }` delivers exactly
 * that, and the caller reads it normally.
 */
export function applyMirrorOverrides(): string[] {
  if (applied) return []
  applied = true
  const state = useSessionStore.getState() as unknown as Record<string, unknown>
  const overrides: Record<string, unknown> = {}
  const missing: string[] = []
  for (const name of Object.keys(FORWARDED_ACTIONS)) {
    if (typeof state[name] !== 'function') {
      missing.push(name)
      continue
    }
    overrides[name] = async (...args: unknown[]): Promise<unknown> => {
      rDebug('studio.mirror', 'forwarding action to owner', { action: name, arg_count: args.length })
      // Selection is visually local but owner-durable. Reflect it immediately so
      // Studio does not wait for the IPC round trip plus active-tab push before
      // painting the requested conversation. The owner remains authoritative:
      // transport failure rolls this optimistic value back, and the normal owner
      // push converges successful selections.
      const optimisticTabId = name === 'selectTab' && typeof args[0] === 'string' ? args[0] : null
      const previousTabId = optimisticTabId ? useSessionStore.getState().activeTabId : undefined
      if (optimisticTabId && hasMirrorTab(optimisticTabId)) useSessionStore.setState({ activeTabId: optimisticTabId })
      const reply = await window.ion.studioCallAction(name, args)
      if (!reply.ok) {
        if (optimisticTabId && useSessionStore.getState().activeTabId === optimisticTabId) {
          useSessionStore.setState({ activeTabId: previousTabId })
        }
        // Transport-level: the call never reached a conclusion. Warn rather
        // than throw — the caller's `.catch` is for the action's own failures,
        // and a wedged owner window is not something a click handler can
        // meaningfully recover from beyond reporting "no result".
        rWarn('studio.mirror', 'forwarded action did not complete', {
          action: name, error: reply.error ?? '',
        })
        return undefined
      }
      reconcileForwardedAttachments(name, args)
      reconcileForwardedRewind(name, args, reply.value)
      return reply.value
    }
  }
  if (missing.length > 0) {
    // A table entry with no store action is contract drift — the parity test
    // pins this, but log loudly in case a stale build slips through.
    rWarn('studio.mirror', 'forwarded actions missing from store', { missing: missing.join(',') })
  }
  useSessionStore.setState(overrides as never)
  rDebug('studio.mirror', 'mirror overrides applied', { count: Object.keys(overrides).length })
  return Object.keys(overrides)
}
