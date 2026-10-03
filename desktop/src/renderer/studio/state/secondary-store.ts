/**
 * secondary-store — boots the session store in MIRROR mode for the Studio
 * window as the UNION of every connected Environment (ADR-033; see
 * shared/studio-mirror-actions.ts). Each Environment's server publishes its
 * own tabs, terminals, and worktrees; the hydrators here merge each one into
 * the single store, keyed by the Environment it came from, so the Inbox
 * shows everything at once and every action is routed back to the
 * server that owns the tab it names (`connection/tab-environment.ts`).
 *
 * Importing the sessionStore module never wires persistence; only the server
 * boot does that. This module applies the rest of the mirror discipline: it
 * declares this process a mirror, and every FORWARDED action is swapped for a
 * `studio_action` round trip over the local server's Studio wire (the same
 * seam a remote environment uses), so owner-durable mutations execute in the
 * server process that actually owns `useSessionStore` — Zustand actions are
 * plain state fields, so the swap is a setState.
 */
import { useSessionStore } from '@ion/server/store/sessionStore'
import { destroyTerminalInstance } from '../../components/TerminalInstance'
import {
  isStudioConversationTerminalSnapshot,
  removedConversationTerminalKeys,
  terminalPaneMap,
} from '@ion/shared/studio-conversation-terminal-sync'
import { FORWARDED_ACTIONS } from '@ion/shared/studio-mirror-actions'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { resolveActionEnvironment, activeTabIdForAction, tabEnvironmentId } from '../connection/tab-environment'
import { environmentAvailability } from '../connection/environment-availability'
import { StudioActionFailure } from '@ion/shared/studio-wire/action-failure'
import { tabsFromSnapshot, mergePanes, nextActiveTabId, type ResolvedModelMap } from './hydrate-tabs'
import { commitInstance } from '@ion/server/store/conversation-instance'
import type { ConversationPane } from '@ion/shared/types'
import type { FileAttachment, Message, PersistedTabState } from '@ion/shared/types'
import type { StudioUserMessageEcho, StudioHistoryReplace } from '@ion/shared/types-studio'
// The worktree read model's sync lives beside this module; re-exported so
// every existing import path keeps resolving.
export { hydrateWorktreeFromSync } from './secondary-store-worktree-sync'
import { rDebug, rWarn } from '../../rendererLogger'
import { developerSurfaceBlock } from '@ion/shared/developer-surfaces'
import { policyStore } from '../connection/policy-store'
import { declareMirrorWindow } from '@ion/server/lib/window-role'
import { host, action } from '../../host/host-instance'
import { reconcileAttachmentTabs, reconcileForwardedAttachments, reconcileForwardedRewind, reconcileForwardedCloseIntent, applyOptimisticDraft } from './secondary-store-reconcile'

export { reconcileAttachmentTabs, reconcileForwardedRewind, reconcileForwardedCloseIntent, applyOptimisticDraft }

let applied = false

/**
 * Applied-revision cursors, one per Environment: revisions are minted per
 * server, so devbox's revision 3 says nothing about the local server's
 * revision 40.
 */
const lastSnapshotRevision = new Map<string, number>()
const lastTerminalSnapshotRevision = new Map<string, number>()

/**
 * Forget one Environment's applied-revision cursors.
 *
 * Revisions are minted per server and restart at zero with it, so a cursor
 * kept across a disconnect makes the FIRST snapshot after a server restart
 * look stale and drops it -- the tabs would then only reappear on whatever
 * later revision happened to climb past the old high-water mark. Called
 * when an Environment is dropped and again on every welcome, which is the
 * start of a new session with that server either way.
 */
export function clearEnvironmentSyncCursors(environmentId: string): void {
  lastSnapshotRevision.delete(environmentId)
  lastTerminalSnapshotRevision.delete(environmentId)
}

function isStale(cursors: Map<string, number>, environmentId: string, revision: number): boolean {
  if (revision <= (cursors.get(environmentId) ?? -1)) return true
  cursors.set(environmentId, revision)
  return false
}

const pendingUserMessageEchoes = new Map<string, StudioUserMessageEcho[]>()
const pendingHistoryReplacements = new Map<string, StudioHistoryReplace>()

function hasMirrorTab(tabId: string): boolean {
  const state = useSessionStore.getState()
  return state.tabs.some((tab) => tab.id === tabId) && state.conversationPanes.has(tabId)
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
          // The inline image previews render from this array; the content only
          // holds a stripped marker. Dropping it here shows the words alone.
          ...(echo.attachments && echo.attachments.length > 0 ? { attachments: echo.attachments } : {}),
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


/**
 * Replace ONE Environment's slice of the mirror's tab metadata from that
 * server's snapshot, leaving every other Environment's tabs untouched.
 * Existing conversation panes are kept (lazy-loaded messages, live streams);
 * panes for tabs that server has closed are dropped. Tab ids are UUIDs
 * minted per server, so the union is keyed by tab id alone.
 */
/** The local owner's active tab as of its last sync, so a CHANGE there can be told from its steady state. */
let lastLocalOwnerActiveTabId: string | null = null

/** TEST ONLY. */
export function _resetLocalOwnerActiveTabForTest(): void { lastLocalOwnerActiveTabId = null }

export function hydrateTabsFromSync(snapshot: unknown, environmentId: string = LOCAL_ENVIRONMENT_ID): void {
  if (snapshot == null || typeof snapshot !== 'object' || !Array.isArray((snapshot as PersistedTabState).tabs)) {
    rWarn('studio.mirror', 'tabs-sync snapshot malformed, ignored', { environment_id: environmentId })
    return
  }
  const revision = (snapshot as { revision?: unknown }).revision
  if (typeof revision === 'number' && Number.isSafeInteger(revision) && isStale(lastSnapshotRevision, environmentId, revision)) return
  const typed = snapshot as PersistedTabState
  const liveTabStatus = (snapshot as { liveTabStatus?: Record<string, string> }).liveTabStatus
  const queuedAttachments = (snapshot as { queuedAttachments?: Record<string, FileAttachment[]> }).queuedAttachments
  const liveIsCompacting = (snapshot as { liveIsCompacting?: Record<string, boolean> }).liveIsCompacting
  // The welcome snapshot names it `resolvedModels`; the tabs sync, `liveResolvedModel`.
  const resolvedModels = (snapshot as { liveResolvedModel?: ResolvedModelMap; resolvedModels?: ResolvedModelMap }).liveResolvedModel
    ?? (snapshot as { resolvedModels?: ResolvedModelMap }).resolvedModels
  const before = useSessionStore.getState()
  const { tabs: envTabs, settledHistory: envSettled, activeTabId: ownerActiveTabId } = tabsFromSnapshot(typed, liveTabStatus, before.tabs, queuedAttachments, liveIsCompacting, environmentId)
  useSessionStore.setState((s) => {
    const otherTabs = s.tabs.filter((t) => tabEnvironmentId(t) !== environmentId)
    const otherSettled = s.settledHistory.filter((t) => tabEnvironmentId(t) !== environmentId)
    // Local first, then each remote Environment in the order it arrived, so
    // the Inbox does not reshuffle when one server re-publishes.
    const tabs = environmentId === LOCAL_ENVIRONMENT_ID ? [...envTabs, ...otherTabs] : [...otherTabs, ...envTabs]
    const settledHistory = environmentId === LOCAL_ENVIRONMENT_ID ? [...envSettled, ...otherSettled] : [...otherSettled, ...envSettled]
    const envPanes = mergePanes(s.conversationPanes, typed, envTabs, resolvedModels)
    const conversationPanes = new Map<string, ConversationPane>()
    for (const t of otherTabs) {
      const pane = s.conversationPanes.get(t.id)
      if (pane) conversationPanes.set(t.id, pane)
    }
    for (const [id, pane] of envPanes) conversationPanes.set(id, pane)
    const current = tabs.find((t) => t.id === s.activeTabId)
    const activeTabId = nextActiveTabId({
      environmentId,
      ownerActiveTabId: ownerActiveTabId ?? null,
      ownerChanged: environmentId === LOCAL_ENVIRONMENT_ID && (ownerActiveTabId ?? null) !== lastLocalOwnerActiveTabId,
      currentTabId: current ? s.activeTabId : null,
      currentEnvironmentId: current ? tabEnvironmentId(current) : null,
      firstTabId: tabs[0]?.id ?? null,
    }) ?? s.activeTabId
    if (environmentId === LOCAL_ENVIRONMENT_ID) lastLocalOwnerActiveTabId = ownerActiveTabId ?? null
    return { tabs, settledHistory, activeTabId, conversationPanes, tabsReady: true }
  })
  drainHistoryReplacements()
  drainUserMessageEchoes()
  rDebug('studio.mirror', 'tabs hydrated from owner sync', { environment_id: environmentId, tab_count: envTabs.length, union_tab_count: useSessionStore.getState().tabs.length })
}

/**
 * How every client learns what tabs exist: tabsReady is set ONLY inside
 * hydrateTabsFromSync, and the InputBar and Inbox block on it. (An Electron-only
 * IPC pull of the same data once ran alongside this for the LOCAL
 * Environment; it was deleted with the `windowMirrorSync` capability.)
 *
 * The server fans out the identical data two ways: `studio_welcome`
 * carries the current tabs as StudioSnapshotTab[] (Omit<PersistedTab,
 * 'terminalBuffers' | 'conversationPane'> -- deliberately the same shape
 * family hydrateTabsFromSync already consumes) at connect time, and ongoing
 * changes arrive as studio_event frames on the 'studio:tabs-sync' channel
 * with the exact PersistedTabState payload (server/src/broadcast.ts's publishStudioEvent, fed by
 * the same call sites IPC.STUDIO_TABS_SYNC used to reach). Missing
 * terminalBuffers/conversationPane fields are tolerated by tabsFromSnapshot
 * the same way a fresh hydration with no prior pane state already is.
 */
export function initTabsSyncFromWire(): () => void {
  return host.onFrame((environmentId, frame) => {
    if (frame.type === 'studio_welcome' || frame.type === 'studio_snapshot') {
      // A welcome starts a fresh session with that server, whose revision
      // counters may have restarted below the ones we applied last time.
      if (frame.type === 'studio_welcome') clearEnvironmentSyncCursors(environmentId)
      hydrateTabsFromSync({ tabs: frame.snapshot.tabs, resolvedModels: frame.snapshot.resolvedModels }, environmentId)
    } else if (frame.type === 'studio_event' && frame.channel === 'studio:tabs-sync') {
      hydrateTabsFromSync(frame.payload, environmentId)
    }
  })
}

/**
 * Apply ONE Environment's complete Conversation Terminal Panel snapshot to
 * the mirror, leaving every other Environment's terminal panes in place.
 * A pane belongs to the Environment that owns its tab (`tabEnvironmentId`);
 * a pane whose tab is not in the store yet is attributed to the publishing
 * Environment.
 */
export function hydrateConversationTerminals(snapshot: unknown, environmentId: string = LOCAL_ENVIRONMENT_ID): boolean {
  if (!isStudioConversationTerminalSnapshot(snapshot)) {
    rWarn('studio.terminal-sync', 'terminal snapshot malformed, ignored', { environment_id: environmentId })
    return false
  }
  if (isStale(lastTerminalSnapshotRevision, environmentId, snapshot.revision)) return false

  const current = useSessionStore.getState()
  const ownedBy = (tabId: string): string => {
    const tab = current.tabs.find((t) => t.id === tabId)
    return tab ? tabEnvironmentId(tab) : environmentId
  }
  const envPanes = terminalPaneMap(snapshot)
  const previousEnvPanes = new Map([...current.terminalPanes].filter(([tabId]) => ownedBy(tabId) === environmentId))
  const removedKeys = removedConversationTerminalKeys(previousEnvPanes, envPanes)
  const terminalPanes = new Map([...current.terminalPanes].filter(([tabId]) => ownedBy(tabId) !== environmentId))
  for (const [tabId, pane] of envPanes) terminalPanes.set(tabId, pane)
  const openTabIds = new Set([...current.terminalOpenTabIds].filter((tabId) => ownedBy(tabId) !== environmentId))
  for (const tabId of snapshot.openTabIds) openTabIds.add(tabId)
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
  rDebug('studio.terminal-sync', 'terminal snapshot hydrated', {
    environment_id: environmentId,
    revision: snapshot.revision,
    conversation_count: snapshot.panes.length,
    terminal_count: snapshot.panes.reduce((total, pane) => total + pane.instances.length, 0),
    removed_viewer_count: removedKeys.length,
  })
  return true
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
  return host.shell.onStudioPermissionResolved((tabId, questionId) => removeResolvedPermission(tabId, questionId))
}

/**
 * Wire the user-message echo: the owner does the optimistic transcript
 * insert in ITS store, and user turns never ride normalized events — this
 * push keeps the mirror transcript complete regardless of which surface
 * (overlay, Studio, iOS) submitted the prompt.
 */
export function initUserMessageEcho(): () => void {
  return host.shell.onStudioUserMessageEcho((tabId, echo) => {
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
  return host.shell.onStudioHistoryReplace((payload) => {
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

/**
 * Swap forwarded actions for `studio_action` round trips against the
 * Environment that owns the tab each call names (`resolveActionEnvironment`:
 * explicit target, else the named tab's owner, else local). Idempotent.
 * Returns the list of swapped action names (for logging/tests).
 *
 * ── The forwarder's return contract ─────────────────────────────────────────
 * Every override returns a PROMISE that resolves to the real store action's
 * return value, so a forwarded action behaves in this window the way its
 * signature says it does. The round trip is `host.action`: the same
 * `studio_action` frame a remote environment answers, sent here to the local
 * server, which runs `useSessionStore.getState()[action](...args)` and
 * replies with `ok/value/refusal/error` (`server/src/protocol/actions.ts`).
 *
 * Both halves of that matter, and both were once wrong (back when the round
 * trip was IPC to a separate Overlay owner window):
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
 * The promise never rejects. A transport fault (`StudioActionFailure`, e.g.
 * the local server is unreachable) resolves `undefined` and is logged here,
 * because "the round trip failed" and "the action returned nothing" are the
 * same thing from a caller's perspective: no answer is available. Domain
 * failures are unaffected — an action that returns `{ ok: false, error }`
 * delivers exactly that, and the caller reads it normally.
 */
export function applyMirrorOverrides(): string[] {
  if (applied) return []
  applied = true
  // Before any reducer runs here: owner-only side effects in the shared
  // reducers check this, and they must not repeat in a Studio client.
  declareMirrorWindow()
  const state = useSessionStore.getState() as unknown as Record<string, unknown>
  const overrides: Record<string, unknown> = {}
  const missing: string[] = []
  for (const name of Object.keys(FORWARDED_ACTIONS)) {
    if (typeof state[name] !== 'function') {
      missing.push(name)
      continue
    }
    overrides[name] = async (...args: unknown[]): Promise<unknown> => {
      const environmentId = resolveActionEnvironment(name, args)
      const activeTabId = activeTabIdForAction(name)
      // A mutation aimed at a remote Environment this desktop cannot reach
      // is refused here, not queued. The broker WOULD hold it and send it on
      // reconnect, which is right for the local server (a restart is a blip
      // on this machine's own state) and wrong for another machine: the
      // action was decided against rows that stopped being current the
      // moment the wire dropped, and replaying it minutes later applies an
      // old intent to a conversation that has moved on.
      if (environmentId !== LOCAL_ENVIRONMENT_ID && environmentAvailability.availabilityOf(environmentId) !== 'connected') {
        rWarn('studio.mirror', 'refused an action for an environment this desktop cannot reach', {
          action: name, environment_id: environmentId, availability: environmentAvailability.availabilityOf(environmentId),
        })
        return undefined
      }
      const blockedSurfaces = developerSurfaceBlock(name, policyStore.developerSurfacesFor(environmentId))
      if (blockedSurfaces) {
        rWarn('studio.mirror', 'held an action for a developer surface that is off for its environment', {
          action: name, environment_id: environmentId, surfaces: blockedSurfaces,
        })
        return undefined
      }
      rDebug('studio.mirror', 'forwarding action to owning environment', { action: name, arg_count: args.length, environment_id: environmentId, active_tab_id: activeTabId ?? '' })
      // Selection is visually local but owner-durable. Reflect it immediately so
      // Studio does not wait for the wire round trip plus active-tab push before
      // painting the requested conversation. The server remains authoritative:
      // transport failure rolls this optimistic value back, and the normal
      // tabs-sync push converges successful selections.
      const optimisticTabId = name === 'selectTab' && typeof args[0] === 'string' ? args[0] : null
      const previousTabId = optimisticTabId ? useSessionStore.getState().activeTabId : undefined
      if (optimisticTabId && hasMirrorTab(optimisticTabId)) useSessionStore.setState({ activeTabId: optimisticTabId })
      // The composer reads the draft back out of this store on the next tab
      // switch, which can happen before the round trip lands.
      applyOptimisticDraft(name, args)
      let value: unknown
      try {
        value = await action(environmentId, name, args, activeTabId ? { activeTabId } : {})
      } catch (err) {
        if (optimisticTabId && useSessionStore.getState().activeTabId === optimisticTabId) {
          useSessionStore.setState({ activeTabId: previousTabId })
        }
        // Transport-level or domain-level: the call never produced a usable
        // value. Warn rather than throw — the caller's `.catch` is for the
        // action's own failures, and an unreachable local server is not
        // something a click handler can meaningfully recover from beyond
        // reporting "no result".
        const failure = err instanceof StudioActionFailure ? err.message : String(err)
        rWarn('studio.mirror', 'forwarded action did not complete', {
          action: name, error: failure,
        })
        return undefined
      }
      reconcileForwardedAttachments(name, args)
      reconcileForwardedRewind(name, args, value)
      reconcileForwardedCloseIntent(name, value)
      return value
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
