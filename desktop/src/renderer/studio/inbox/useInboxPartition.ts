import { useEffect, useMemo, useState } from 'react'
import { useSessionStore } from '../../stores/sessionStore'
import { usePreferencesStore } from '../../preferences'
import { activeInstance } from '../../stores/conversation-instance'
import { waitingStateOfPane } from '../../components/TabStripShared'
import { classifyInbox, inboxUnread, wokeAt, type InboxTabView } from '../../../shared/inbox-classify'
import { liveBackgroundShellCount } from '../../../shared/background-shell-counts'
import { sortPinnedByOrder } from '../../../shared/inbox-pin-order'
import type { TabState } from '../../../shared/types'

export interface InboxMeta {
  unread: boolean
  wokeAt: number | null
  backgroundLiveness: 'working' | 'monitoring' | null
}

export interface InboxPartition {
  pinned: TabState[]
  inbox: TabState[]
  snoozed: TabState[]
  settled: TabState[]
  meta: Map<string, InboxMeta>
}

const MINUTE = 60_000

function activeOrder(left: TabState, right: TabState): number {
  const leftCreated = left.createdAt
  const rightCreated = right.createdAt
  // Legacy tabs have no durable timestamp. Returning zero retains persisted
  // tabs.json order, which is the only truthful creation-order fallback.
  if (leftCreated == null || rightCreated == null) return 0
  return rightCreated - leftCreated || left.id.localeCompare(right.id)
}

function viewFor(tab: TabState, pendingAskCount: number, waiting: boolean, hasPendingWork: boolean, hasPendingPlan: boolean): InboxTabView {
  return {
    status: tab.status,
    settledOverride: tab.settledOverride,
    settledAt: tab.settledAt,
    snoozedUntil: tab.snoozedUntil,
    snoozedAt: tab.snoozedAt,
    lastVisitedAt: tab.lastVisitedAt,
    lastCompletionAt: tab.lastCompletionAt,
    lastMessageAt: tab.lastMessageAt,
    lastActivityAt: tab.lastActivityAt,
    manualUnread: tab.manualUnread,
    hasPendingWork,
    hasPendingPlan,
    pendingAskCount,
    waiting,
    failed: tab.status === 'failed',
  }
}

/** Desktop-owned inbox partition. Clients receive its derived state in snapshots. */
export function useInboxPartition(): InboxPartition {
  const tabs = useSessionStore((s) => s.tabs)
  const panes = useSessionStore((s) => s.conversationPanes)
  const autoSettleDays = usePreferencesStore((s) => s.inboxAutoSettleDays)
  const [, setClock] = useState(0)

  useEffect(() => {
    const minuteTimer = setInterval(() => setClock((value) => value + 1), MINUTE)
    return () => clearInterval(minuteTimer)
  }, [])


  return useMemo(() => {
    const now = Date.now()
    const pinned: TabState[] = []
    const inbox: TabState[] = []
    const snoozed: TabState[] = []
    const settled: TabState[] = []
    const meta = new Map<string, InboxMeta>()
    for (const tab of tabs) {
      const instance = activeInstance(panes, tab.id)
      const pendingAskCount = (instance?.permissionQueue.length ?? 0) + (instance?.elicitationQueue.length ?? 0)
      const waiting = waitingStateOfPane(panes.get(tab.id)) !== null
      const agentCount = instance?.agentStates.filter((agent) => agent.status === 'running').length ?? 0
      const backgroundAgents = instance?.statusFields?.backgroundAgents ?? 0
      const shells = liveBackgroundShellCount(instance?.statusFields)
      const hasPendingPlan = instance?.planFilePath != null
      const view = viewFor(tab, pendingAskCount, waiting, Math.max(agentCount, backgroundAgents) > 0 || shells > 0 || instance?.statusFields?.hasPendingWork === true, hasPendingPlan)
      meta.set(tab.id, {
        unread: inboxUnread(view),
        wokeAt: wokeAt(view, now),
        backgroundLiveness: Math.max(agentCount, backgroundAgents) > 0 ? 'working' : shells > 0 ? 'monitoring' : null,
      })
      const state = classifyInbox(view, now, autoSettleDays > 0 ? autoSettleDays : null)
      if (state === 'snoozed') snoozed.push(tab)
      else if (tab.pinnedAt != null) pinned.push(tab)
      else if (state === 'settled') settled.push(tab)
      else inbox.push(tab)
    }
    pinned.splice(0, pinned.length, ...sortPinnedByOrder(pinned))
    inbox.sort(activeOrder)
    snoozed.sort((left, right) => (left.snoozedUntil ?? 0) - (right.snoozedUntil ?? 0) || left.id.localeCompare(right.id))
    settled.sort((left, right) => (right.settledAt ?? right.lastMessageAt ?? 0) - (left.settledAt ?? left.lastMessageAt ?? 0) || left.id.localeCompare(right.id))
    return { pinned, inbox, snoozed, settled, meta }
  }, [tabs, panes, autoSettleDays])
}
