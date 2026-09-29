/**
 * tab-slice-misc-actions.ts
 *
 * Worktree and system-message actions, extracted
 * from tab-slice.ts for line-cap. All exports are functions that accept the
 * Zustand `set`/`get` pair and return the matching partial-state objects —
 * the same pattern used by tab-slice-thinking.ts.
 */

import type { StoreSet, StoreGet } from '../session-store-types'
import { commitInstance } from '../conversation-instance'

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
