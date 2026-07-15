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
    overrides[name] = (...args: unknown[]) => {
      rDebug('atv.mirror', 'forwarding action to owner', { action: name, arg_count: args.length })
      window.ion.atvForwardAction(name, args)
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
