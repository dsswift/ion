import type { EnrichedError, TabStatus } from '@ion/shared/types'
import type { StoreSet } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { activeInstance, commitInstance } from '../conversation-instance'
import { rError } from '../rendererLogger'

/** Handle an enriched-error event: append a system error message and mark the
 *  tab failed. Extracted from event-slice.ts to keep that file under the 600-
 *  line cap. */
export function handleErrorAction(set: StoreSet, tabId: string, error: EnrichedError): void {
  // The one sink every prompt-dispatch rejection reaches (send-slice's
  // `.catch` handlers route here), so this is where the failure becomes
  // visible in the log. Before this line a prompt whose pipeline threw
  // showed "Failed" in the tab and nothing in server.jsonl.
  rError('tab.error', 'conversation marked failed', {
    tab_id: tabId,
    message: error.message,
    exit_code: error.exitCode ?? '',
    elapsed_ms: error.elapsedMs,
    tool_calls: error.toolCallCount,
    stderr_tail: error.stderrTail.slice(-3),
  })
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
