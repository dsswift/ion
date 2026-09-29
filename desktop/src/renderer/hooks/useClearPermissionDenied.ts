import { useCallback } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'

/**
 * Returns a stable callback that clears the active instance's
 * `permissionDenied` (dismisses the Plan Ready / AskUserQuestion / permission
 * card) for a conversation tab. Extracted from ConversationView to keep that
 * component under the file-size cap; the logic is unchanged.
 *
 * No-ops when the tab has no engine key or no active instance, or when the
 * pane / active instance cannot be resolved.
 */
export function useClearPermissionDenied(
  key: string | null | undefined,
  tabId: string,
  activeInstanceId: string | null | undefined,
): () => void {
  return useCallback(() => {
    if (!key || !activeInstanceId) return
    useSessionStore.setState((s) => {
      const pane = s.conversationPanes.get(tabId)
      if (!pane) return {}
      const idx = pane.instances.findIndex((i) => i.id === activeInstanceId)
      if (idx === -1) return {}
      const updatedPanes = new Map(s.conversationPanes)
      const instances = pane.instances.slice()
      instances[idx] = { ...instances[idx], permissionDenied: null }
      updatedPanes.set(tabId, { ...pane, instances })
      return { conversationPanes: updatedPanes }
    })
  }, [key, tabId, activeInstanceId])
}
