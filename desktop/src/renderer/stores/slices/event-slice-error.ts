import type { EnrichedError, TabStatus } from '../../../shared/types'
import type { StoreSet } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { activeInstance, commitInstance } from '../conversation-instance'

/** Handle an enriched-error event: append a system error message and mark the
 *  tab failed. Extracted from event-slice.ts to keep that file under the 600-
 *  line cap. */
export function handleErrorAction(set: StoreSet, tabId: string, error: EnrichedError): void {
  set((s) => {
    const inst = activeInstance(s.conversationPanes, tabId)
    const msgs = inst ? inst.messages : []
    const lastMsg = msgs[msgs.length - 1]
    const alreadyHasError = lastMsg?.role === 'system' && lastMsg.content.startsWith('Error:')
    const nextMessages = alreadyHasError
      ? msgs
      : [
          ...msgs,
          {
            id: nextMsgId(),
            role: 'system' as const,
            content: `Error: ${error.message}${error.stderrTail.length > 0 ? '\n\n' + error.stderrTail.slice(-5).join('\n') : ''}`,
            timestamp: Date.now(),
          },
        ]
    const conversationPanes = commitInstance(s.conversationPanes, tabId, (i) => ({
      ...i,
      messages: nextMessages,
      permissionQueue: [],
      elicitationQueue: [],
    }))
    return {
      conversationPanes,
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              status: 'failed' as TabStatus,
              activeRequestId: null,
              currentActivity: '',
              lastFailureAt: Date.now(),
            }
          : t
      ),
    }
  })
}
