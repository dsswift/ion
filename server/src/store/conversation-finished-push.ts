/**
 * conversation-finished-push — ring the phone when a conversation's run is
 * truly over.
 *
 * "Truly over" is two conditions, and both must hold:
 *
 *  1. At rest by the exact signals. The run came to rest (running or waiting →
 *     idle or completed), and nothing else is still going or still waiting on the
 *     person: no background agents, shells, or engine-reported pending work in
 *     any instance, no pending plan, permission ask, question, or denial. These
 *     are the same rules automatic settlement uses (`autoSettleBlocked`).
 *
 *  2. At rest continuously for `settleMs`. Status arrives through several
 *     events (the completion, the engine's idle ticks, a background agent's
 *     first `running` snapshot landing just after the orchestrator idles), so
 *     a single at-rest moment is not proof. The window restarts whenever any
 *     condition above stops holding, and a new run discards it entirely.
 *
 * A run that ends waiting on the person (a plan, a question, a permission)
 * never rings here: that conversation already rang for its ask
 * (`engine/event-wiring-remote.ts`), and it is not finished.
 *
 * The push goes out through the relay doorbell, which skips any phone that is
 * attached to this server right now and rings every other one. Its fields ride
 * beside the sealed frame in plaintext: the server's name, the conversation's
 * id (the tap opens it), and its title when this server allows titles in
 * pushes (`thin-view/push-title.ts`). Never anything the conversation says.
 */
import { hostName } from '../host-name'
import type { StoreApi } from 'zustand'
import { autoSettleBlocked } from '@ion/shared/inbox-classify'
import { isPersistedSettled } from '@ion/shared/tab-predicates'
import { usageLimitedUntil } from '@ion/shared/usage-limit'
import type { RelayPushMeta } from '@ion/shared/studio-wire/relay-envelope'
import { ringOfflineThinClients } from '../thin-view/push-doorbell'
import { pushConversationTitle } from '../thin-view/push-title'
import { inboxTabView } from './inbox-tab-view'
import { hasPendingWorkInPane } from './slices/pending-work'
import { rDebug, rInfo } from './rendererLogger'
import type { State } from './session-store-types'

/** How long a conversation must stay at rest before its finished push rings. */
export const FINISHED_PUSH_SETTLE_MS = 5_000

/** The `notifyKind` a relay copies into the push payload for this push. */
export const FINISHED_PUSH_KIND = 'conversation_finished'

type Tab = State['tabs'][number]

export interface FinishedPushDeps {
  ring: (push: RelayPushMeta) => void
  /** The machine name shown in the push body, so two servers read differently. */
  host: () => string
  /** The conversation's title for the push, or null to send generic text. */
  title: (tab: Tab) => string | null
  settleMs: number
}

const defaultDeps: FinishedPushDeps = {
  ring: ringOfflineThinClients,
  host: () => hostName(),
  title: pushConversationTitle,
  settleMs: FINISHED_PUSH_SETTLE_MS,
}

/**
 * Statuses a run is in while it is not finished. `waiting` is a run whose
 * foreground turn stopped while background agents or shells still work; when
 * that work ends it goes straight to `completed`, and that is a finish too.
 */
const RUN_ACTIVE: ReadonlySet<string> = new Set(['running', 'waiting'])

/** A run that came to rest and has not rung yet. `timer` runs only while every rest condition holds. */
interface PendingRest {
  restedAt: number
  timer: ReturnType<typeof setTimeout> | null
  /** Last reason the window was held, so a held line logs once per change rather than per store tick. */
  heldBy: string | null
}

/**
 * Why this conversation is not at rest right now, or null when it is.
 * Every reason is a named state the conversation is in, never a guess.
 */
export function finishedPushBlocker(state: State, tab: Tab): string | null {
  if (tab.isTerminalOnly) return 'terminal_only'
  if (isPersistedSettled(tab)) return 'settled'
  // It rang for its limit, and it is not finished: it stopped part way.
  if (usageLimitedUntil(tab, Date.now()) !== null) return 'usage_limited'
  if (tab.status !== 'idle' && tab.status !== 'completed') return `status_${tab.status}`
  // Every instance, not just the active one: a background agent dispatched
  // from any instance means the conversation is still working.
  if (hasPendingWorkInPane(state.conversationPanes.get(tab.id))) return 'background_work_pending'
  return autoSettleBlocked(inboxTabView(state, tab))
}

/** Watch the owner store and ring a finished push for each run that stays at rest. */
export function setupConversationFinishedPush(store: StoreApi<State>, deps: FinishedPushDeps = defaultDeps): () => void {
  const pending = new Map<string, PendingRest>()

  const drop = (tabId: string, reason: string): void => {
    const entry = pending.get(tabId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    pending.delete(tabId)
    rInfo('push.finished', 'finished push dropped', { tab_id: tabId.slice(0, 8), reason })
  }

  const fire = (tabId: string): void => {
    const entry = pending.get(tabId)
    if (!entry) return
    entry.timer = null
    const state = store.getState()
    const tab = state.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) {
      drop(tabId, 'tab_gone')
      return
    }
    // Re-check at the moment of ringing. A question or plan can open without
    // a store change this watcher sees, so the window alone is not enough.
    const blocker = finishedPushBlocker(state, tab)
    if (blocker) {
      entry.heldBy = blocker
      rInfo('push.finished', 'finished push held at ring time', { tab_id: tabId.slice(0, 8), reason: blocker })
      return
    }
    pending.delete(tabId)
    const host = deps.host()
    // Named: the title says which conversation, the body what happened where.
    const title = deps.title(tab)
    deps.ring(title
      ? { pushTitle: title, pushBody: `Finished on ${host}`, pushTabId: tabId, notifyKind: FINISHED_PUSH_KIND }
      : { pushTitle: 'Conversation finished', pushBody: `On ${host}`, pushTabId: tabId, notifyKind: FINISHED_PUSH_KIND })
    rInfo('push.finished', 'finished push rung', { tab_id: tabId.slice(0, 8), push_host: host, titled: title !== null, at_rest_ms: Date.now() - entry.restedAt })
  }

  /** Start, hold, or keep the settle window for one pending conversation. */
  const evaluate = (state: State, tab: Tab, entry: PendingRest): void => {
    const blocker = finishedPushBlocker(state, tab)
    if (blocker) {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      if (entry.heldBy !== blocker) {
        entry.heldBy = blocker
        rDebug('push.finished', 'finished push held', { tab_id: tab.id.slice(0, 8), reason: blocker })
      }
      return
    }
    if (entry.timer) return
    entry.heldBy = null
    entry.timer = setTimeout(() => fire(tab.id), deps.settleMs)
    rDebug('push.finished', 'finished push settle window started', { tab_id: tab.id.slice(0, 8), settle_ms: deps.settleMs })
  }

  const unsubscribe = store.subscribe((state, previous) => {
    // Restoring tabs at boot is not a run ending, so nothing arms before the
    // store is ready and no transition that crosses readiness counts.
    if (!state.tabsReady || !previous.tabsReady) return
    if (state.tabs === previous.tabs && state.conversationPanes === previous.conversationPanes) return

    const before = new Map(previous.tabs.map((tab) => [tab.id, tab.status]))
    const present = new Set<string>()
    for (const tab of state.tabs) {
      present.add(tab.id)
      const was = before.get(tab.id)
      if (tab.status === 'running' && pending.has(tab.id)) {
        drop(tab.id, 'new_run_started')
        continue
      }
      // Only a run ending counts. `connecting → idle` is an engine starting,
      // and `completed → idle` is the engine's idle tick after a completion.
      if (was !== undefined && RUN_ACTIVE.has(was) && (tab.status === 'idle' || tab.status === 'completed')) {
        const existing = pending.get(tab.id)
        if (existing?.timer) clearTimeout(existing.timer)
        pending.set(tab.id, { restedAt: Date.now(), timer: null, heldBy: null })
        rInfo('push.finished', 'run came to rest', { tab_id: tab.id.slice(0, 8), from: was, status: tab.status })
      }
    }

    for (const [tabId, entry] of pending) {
      const tab = present.has(tabId) ? state.tabs.find((candidate) => candidate.id === tabId) : undefined
      if (!tab) {
        drop(tabId, 'tab_gone')
        continue
      }
      evaluate(state, tab, entry)
    }
  })

  return () => {
    unsubscribe()
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    pending.clear()
  }
}
