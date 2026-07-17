/**
 * tab-slice-misc-actions.ts
 *
 * Tab group placement, pin, worktree, and system-message actions, extracted
 * from tab-slice.ts for line-cap. All exports are functions that accept the
 * Zustand `set`/`get` pair and return the matching partial-state objects —
 * the same pattern used by tab-slice-thinking.ts.
 */

import type { StoreSet, StoreGet } from '../session-store-types'
import { commitInstance } from '../conversation-instance'
import { rDebug } from '../../rendererLogger'

// ─── shared helper: reorder a tab into the last position in `targetGroupId` ───

function insertAfterGroup(
  tabs: { id: string; groupId?: string | null }[],
  tabId: string,
  updater: (t: typeof tabs[0]) => typeof tabs[0],
): typeof tabs {
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab) return tabs
  const updated = updater(tab)
  const without = tabs.filter((t) => t.id !== tabId)
  const groupId = (updated as any).groupId as string | null | undefined
  let insertIdx = -1
  for (let i = without.length - 1; i >= 0; i--) {
    if ((without[i] as any).groupId === groupId) { insertIdx = i; break }
  }
  const result = [...without]
  if (insertIdx >= 0) {
    result.splice(insertIdx + 1, 0, updated)
  } else {
    result.push(updated)
  }
  return result
}

// ─── actions ─────────────────────────────────────────────────────────────────

export function moveTabToGroupAction(set: StoreSet) {
  return (tabId: string, groupId: string | null) => {
    set((s) => ({
      tabs: insertAfterGroup(s.tabs as any[], tabId, (t) => ({ ...t, groupId })) as any,
    }))
  }
}

export function moveTabToGroupAndPinAction(set: StoreSet) {
  return (tabId: string, groupId: string | null) => {
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab) return s
      rDebug('tab.pin', 'move+pin tab', { tab_id: tabId.slice(0, 8), group: groupId, was_group: tab.groupId ?? '', was_pinned: tab.groupPinned ?? false })
      const tabs = insertAfterGroup(s.tabs as any[], tabId, (t) => ({ ...t, groupId, groupPinned: true })) as any
      return { tabs }
    })
  }
}

export function setTabGroupIdAction(set: StoreSet) {
  return (tabId: string, groupId: string | null) => {
    set((s) => ({
      tabs: insertAfterGroup(s.tabs as any[], tabId, (t) => ({ ...t, groupId })) as any,
    }))
  }
}

export function toggleTabGroupPinAction(set: StoreSet) {
  return (tabId: string) => {
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab) return s
      const newPinned = !tab.groupPinned
      rDebug('tab.pin', 'toggle pin', { tab_id: tabId.slice(0, 8), from: tab.groupPinned, to: newPinned, current_group: tab.groupId ?? '' })
      return {
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, groupPinned: newPinned } : t
        ),
      }
    })
  }
}

export function setWorktreeUncommittedAction(set: StoreSet, get: StoreGet) {
  return (tabId: string, hasChanges: boolean) => {
    const map = new Map(get().worktreeUncommittedMap)
    map.set(tabId, hasChanges)
    set({ worktreeUncommittedMap: map })
  }
}

export function addSystemMessageAction(set: StoreSet, get: StoreGet) {
  return (content: string) => {
    const { activeTabId } = get()
    // System messages append onto the active conversation instance.
    set((s) => ({
      conversationPanes: commitInstance(s.conversationPanes, activeTabId, (inst) => ({
        ...inst,
        messages: [
          ...inst.messages,
          { id: `msg-${Date.now()}-${Math.random()}`, role: 'system' as const, content, timestamp: Date.now() },
        ],
      })),
    }))
  }
}
