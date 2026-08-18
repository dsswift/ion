import type { TabStatus } from '../../../shared/types'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { activeInstance, commitInstance } from '../conversation-instance'
import { rWarn, rError } from '../../rendererLogger'

export function createPermissionsSlice(set: StoreSet, _get: StoreGet): Partial<State> {
  return {
    respondPermission: (tabId, questionId, optionId) => {
      window.ion.respondPermission(tabId, questionId, optionId).catch((err) => {
        // If the response IPC fails, the user's approve/deny never reaches the
        // engine while the UI clears the queue below — a silent lost decision.
        rError('permissions', 'respondPermission failed', { tab_id: tabId, error: String(err) })
      })

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

    respondElicitation: (tabId, requestId, response, cancelled) => {
      window.ion.respondElicitation(tabId, requestId, response, cancelled).catch((err) => {
        rError('permissions', 'respondElicitation failed', { tab_id: tabId, error: String(err) })
      })

      // elicitationQueue lives on the active conversation instance. Remove the
      // answered request and derive currentActivity from what remains so the
      // tab stops showing "Waiting for approval" once the queue drains.
      set((s) => {
        const inst = activeInstance(s.conversationPanes, tabId)
        const remaining = (inst?.elicitationQueue ?? []).filter((e) => e.requestId !== requestId)
        const conversationPanes = commitInstance(s.conversationPanes, tabId, (i) => ({
          ...i,
          elicitationQueue: i.elicitationQueue.filter((e) => e.requestId !== requestId),
        }))
        const tabs = s.tabs.map((t) => {
          if (t.id !== tabId) return t
          return {
            ...t,
            currentActivity: remaining.length > 0 ? 'Waiting for approval' : 'Working...',
          }
        })
        return { tabs, conversationPanes }
      })
    },

    forceRecoverTab: (tabId, reason) => {
      rWarn('session.recover', 'force recovering tab', { tab_id: tabId, reason })
      try { void window.ion.stopTab(tabId).catch((err) => rWarn('session.recover', 'stopTab during force-recover rejected', { tab_id: tabId, error: String(err) })) } catch (err) {
        rWarn('session.recover', 'stopTab during force-recover failed', { tab_id: tabId, error: String(err) })
      }
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
