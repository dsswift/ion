/**
 * secondary-store — boots the session store in MIRROR mode for the ATV
 * window (see shared/atv-mirror-actions.ts and the ATV shell ADR).
 *
 * Importing the sessionStore module in this window already skips
 * persistence (window-role detection). This module applies the second half
 * of the mirror discipline: every FORWARDED action is swapped for an IPC
 * forwarder, so owner-durable mutations execute in the overlay renderer —
 * Zustand actions are plain state fields, so the swap is a setState.
 */
import { useSessionStore } from '../../stores/sessionStore'
import { FORWARDED_ACTIONS } from '../../../shared/atv-mirror-actions'
import { tabsFromSnapshot, mergePanes } from './hydrate-tabs'
import type { PersistedTabState } from '../../../shared/types'
import { rDebug, rWarn } from '../../rendererLogger'

let applied = false

/**
 * Replace the mirror's tab metadata from an owner-published snapshot.
 * Existing conversation panes are kept (lazy-loaded messages, live streams);
 * panes for owner-closed tabs are dropped.
 */
export function hydrateTabsFromSync(snapshot: unknown): void {
  if (snapshot == null || typeof snapshot !== 'object' || !Array.isArray((snapshot as PersistedTabState).tabs)) {
    rWarn('atv.mirror', 'tabs-sync snapshot malformed, ignored')
    return
  }
  const typed = snapshot as PersistedTabState
  const liveTabStatus = (snapshot as { liveTabStatus?: Record<string, string> }).liveTabStatus
  const { tabs, activeTabId } = tabsFromSnapshot(typed, liveTabStatus, useSessionStore.getState().tabs)
  useSessionStore.setState((s) => ({
    tabs,
    // The owner's active tab is authoritative; atv:active-tab pushes keep it
    // fresh between syncs.
    activeTabId: activeTabId ?? s.activeTabId,
    conversationPanes: mergePanes(s.conversationPanes, typed, tabs),
    tabsReady: true,
  }))
  rDebug('atv.mirror', 'tabs hydrated from owner sync', { tab_count: tabs.length })
}

/** Boot + live wiring for owner tab-metadata sync. Returns unsubscribe. */
export function initTabsSync(): () => void {
  void window.ion.atvGetTabsSync().then((snapshot) => {
    if (snapshot) hydrateTabsFromSync(snapshot)
  })
  return window.ion.onAtvTabsSync((snapshot) => hydrateTabsFromSync(snapshot))
}

/**
 * Remove a resolved permission from the mirror's queue for the tab —
 * consumed from atv:permission-resolved pushes so an answer given on ANY
 * surface (overlay card, iOS, ATV) clears the mirror instantly. Idempotent
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
    rDebug('atv.mirror', 'permission resolved push consumed', { tab_id: tabId.slice(0, 8), question_id: questionId })
    return { conversationPanes }
  })
}

/** Wire the resolution push. Returns unsubscribe. */
export function initPermissionResolutionSync(): () => void {
  return window.ion.onAtvPermissionResolved((tabId, questionId) => removeResolvedPermission(tabId, questionId))
}

/**
 * Wire the user-message echo: the owner does the optimistic transcript
 * insert in ITS store, and user turns never ride normalized events — this
 * push keeps the mirror transcript complete regardless of which surface
 * (overlay, ATV, iOS) submitted the prompt.
 */
export function initUserMessageEcho(): () => void {
  return window.ion.onAtvUserMessageEcho((tabId, text) => {
    if (typeof text === 'string' && text.length > 0) {
      useSessionStore.getState().insertRemoteUserMessage(tabId, text)
    }
  })
}

/**
 * Swap forwarded actions for IPC forwarders. Idempotent. Returns the list of
 * swapped action names (for logging/tests).
 *
 * ── The forwarder's return contract ─────────────────────────────────────────
 * Every override returns a PROMISE that resolves to the OWNER'S actual return
 * value, so a forwarded action behaves in the mirror the way its signature says
 * it does. The round trip is `atvCallAction`: main mints a callId, relays it to
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
      rDebug('atv.mirror', 'forwarding action to owner', { action: name, arg_count: args.length })
      const reply = await window.ion.atvCallAction(name, args)
      if (!reply.ok) {
        // Transport-level: the call never reached a conclusion. Warn rather
        // than throw — the caller's `.catch` is for the action's own failures,
        // and a wedged owner window is not something a click handler can
        // meaningfully recover from beyond reporting "no result".
        rWarn('atv.mirror', 'forwarded action did not complete', {
          action: name, error: reply.error ?? '',
        })
        return undefined
      }
      return reply.value
    }
  }
  if (missing.length > 0) {
    // A table entry with no store action is contract drift — the parity test
    // pins this, but log loudly in case a stale build slips through.
    rWarn('atv.mirror', 'forwarded actions missing from store', { missing: missing.join(',') })
  }
  useSessionStore.setState(overrides as never)
  rDebug('atv.mirror', 'mirror overrides applied', { count: Object.keys(overrides).length })
  return Object.keys(overrides)
}
