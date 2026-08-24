/**
 * Questions ↔ Canvas synchronizer (Studio window only).
 *
 * Watches the window-local Questions cache and drives the transient
 * `questions` Canvas singleton: a conversation gaining an open workflow
 * inserts + activates the tab and opens the pane; losing its last workflow
 * retires the tab and restores the previously active Canvas tab. Keys off
 * every conversation with open workflows (not only the active one) so a tab
 * switch lands on an already-inserted surface.
 */
import { useQuestionsStore } from '../../stores/questions-store'
import { useSurfaceStore } from './surface-store'

let unsubscribe: (() => void) | null = null

export function initQuestionsSurfaceSync(): () => void {
  if (unsubscribe) return unsubscribe

  const apply = (): void => {
    const workflows = useQuestionsStore.getState().workflows
    const surface = useSurfaceStore.getState()
    const active = new Set(
      workflows
        .filter((w) => w.phase !== 'terminal')
        // sessionKey is the ENGINE key (`tabId` or `tabId:instanceId`);
        // surface descriptors key by tab.
        .map((w) => (w.sessionKey.includes(':') ? w.sessionKey.slice(0, w.sessionKey.indexOf(':')) : w.sessionKey)),
    )
    for (const tabId of active) {
      if (!surface.questionsConversations.has(tabId)) surface.showQuestionsSurface(tabId)
    }
    for (const tabId of surface.questionsConversations) {
      if (!active.has(tabId)) surface.retireQuestionsSurface(tabId)
    }
  }

  const off = useQuestionsStore.subscribe((state, previous) => {
    if (state.workflows !== previous.workflows) apply()
  })
  apply()
  unsubscribe = () => {
    off()
    unsubscribe = null
  }
  return unsubscribe
}
