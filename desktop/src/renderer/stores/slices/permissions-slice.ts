import type { TabStatus } from '../../../shared/types'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { activeInstance, commitInstance } from '../conversation-instance'

export function createPermissionsSlice(set: StoreSet, _get: StoreGet): Partial<State> {
  return {
    respondPermission: (tabId, questionId, optionId) => {
      window.ion.respondPermission(tabId, questionId, optionId).catch(() => {})

      // permissionQueue lives on the active conversation instance now; filter it
      // there and derive currentActivity (a tab field) from the remaining queue.
      set((s) => {
        const inst = activeInstance(s.conversationPanes, tabId)
        const remaining = (inst?.permissionQueue ?? []).filter((p) => p.questionId !== questionId)
        const conversationPanes = commitInstance(s.conversationPanes, tabId, (i) => ({
          ...i,
          permissionQueue: i.permissionQueue.filter((p) => p.questionId !== questionId),
        }))
        const tabs = s.tabs.map((t) => {
          if (t.id !== tabId) return t
          return {
            ...t,
            currentActivity: remaining.length > 0
              ? `Waiting for permission: ${remaining[0].toolTitle}`
              : 'Working...',
          }
        })
        return { tabs, conversationPanes }
      })
    },

    forceRecoverTab: (tabId, reason) => {
      console.warn(`[Ion] forceRecoverTab: tab=${tabId} reason="${reason}"`)
      try { window.ion.stopTab(tabId) } catch {}
      // permissionQueue / permissionDenied / messages all live on the active
      // conversation instance now. Clear the queue + denial and append the
      // recovery system message onto the instance; keep status/activity on the tab.
      set((s) => {
        const inst = activeInstance(s.conversationPanes, tabId)
        const msgs = inst?.messages ?? []
        const lastMsg = msgs[msgs.length - 1]
        const alreadyRecovered = lastMsg?.role === 'system' && lastMsg.content.startsWith('Recovered:')
        const conversationPanes = commitInstance(s.conversationPanes, tabId, (i) => ({
          ...i,
          permissionQueue: [],
          permissionDenied: null,
          messages: alreadyRecovered
            ? i.messages
            : [
                ...i.messages,
                {
                  id: nextMsgId(),
                  role: 'system' as const,
                  content: `Recovered: ${reason}`,
                  timestamp: Date.now(),
                },
              ],
        }))
        const tabs = s.tabs.map((t) => {
          if (t.id !== tabId) return t
          return {
            ...t,
            status: 'idle' as TabStatus,
            activeRequestId: null,
            currentActivity: '',
            lastEventAt: Date.now(),
          }
        })
        return { tabs, conversationPanes }
      })
    },
  }
}
