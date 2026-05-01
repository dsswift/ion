import type { TabStatus } from '../../../shared/types'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'

export function createPermissionsSlice(set: StoreSet, _get: StoreGet): Partial<State> {
  return {
    respondPermission: (tabId, questionId, optionId) => {
      window.ion.respondPermission(tabId, questionId, optionId).catch(() => {})

      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== tabId) return t
          const remaining = t.permissionQueue.filter((p) => p.questionId !== questionId)
          return {
            ...t,
            permissionQueue: remaining,
            currentActivity: remaining.length > 0
              ? `Waiting for permission: ${remaining[0].toolTitle}`
              : 'Working...',
          }
        }),
      }))
    },

    forceRecoverTab: (tabId, reason) => {
      console.warn(`[Ion] forceRecoverTab: tab=${tabId} reason="${reason}"`)
      try { window.ion.stopTab(tabId) } catch {}
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== tabId) return t
          const lastMsg = t.messages[t.messages.length - 1]
          const alreadyRecovered = lastMsg?.role === 'system' && lastMsg.content.startsWith('Recovered:')
          return {
            ...t,
            status: 'idle' as TabStatus,
            activeRequestId: null,
            currentActivity: '',
            permissionQueue: [],
            permissionDenied: null,
            lastEventAt: Date.now(),
            messages: alreadyRecovered
              ? t.messages
              : [
                  ...t.messages,
                  {
                    id: nextMsgId(),
                    role: 'system' as const,
                    content: `Recovered: ${reason}`,
                    timestamp: Date.now(),
                  },
                ],
          }
        }),
      }))
    },
  }
}
