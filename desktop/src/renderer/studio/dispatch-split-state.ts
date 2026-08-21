import { rDebug } from '../rendererLogger'
import { useSessionStore } from '../stores/sessionStore'
import type { DispatchSplitSubject } from '../stores/session-store-types'

/** Return split subject only while its originating conversation remains active. */
export function activeDispatchSplit(
  subject: DispatchSplitSubject | null,
  activeTabId: string,
): DispatchSplitSubject | null {
  return subject?.tabId === activeTabId ? subject : null
}

let unsubscribe: (() => void) | null = null

/**
 * Close Studio's ephemeral dispatch detail before a new conversation can render.
 * Subscription catches every activeTabId writer, including mirror hydration and
 * owner pushes that do not pass through selectTab.
 */
export function initDispatchSplitConversationGuard(): () => void {
  if (unsubscribe) return unsubscribe

  const off = useSessionStore.subscribe((state, previous) => {
    if (state.activeTabId === previous.activeTabId) return

    const subject = previous.dispatchSplit
    if (!subject) return

    rDebug('panels', 'closeDispatchSplit: conversation changed', {
      dispatch_id: subject.dispatchId,
      previous_tab_id: previous.activeTabId,
      target_tab_id: state.activeTabId,
      subject_tab_id: subject.tabId,
    })
    useSessionStore.setState({ dispatchSplit: null })
  })

  unsubscribe = () => {
    off()
    unsubscribe = null
  }
  return unsubscribe
}
