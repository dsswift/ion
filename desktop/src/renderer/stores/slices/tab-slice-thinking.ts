import type { StoreSet, StoreGet } from '../session-store-types'
import type { ThinkingEffort } from '../../../shared/types-session'

/**
 * Apply a per-conversation thinking-effort change to the active conversation.
 * Extracted from tab-slice.ts to keep that file under the 600-line cap.
 *
 * Isolated per-tab (bare conversation) and per-instance (engine subtab),
 * mirroring setPermissionMode's tab-type routing. Purely local state: the
 * level is read at prompt-submit time and rides on the next send_prompt as
 * `thinkingEffort` (live, no restart). There is no engine call here — unlike
 * permission mode, the effort is a per-prompt override, not a session command.
 */
export function applySetThinkingEffort(set: StoreSet, get: StoreGet, effort: ThinkingEffort): void {
  const { activeTabId } = get()
  const activeTab = get().tabs.find((t) => t.id === activeTabId)
  if (activeTab?.hasEngineExtension) {
    const pane = get().conversationPanes.get(activeTabId)
    const instanceId = pane?.activeInstanceId
    if (!instanceId) return
    set((s) => {
      const conversationPanes = new Map(s.conversationPanes)
      const paneInner = conversationPanes.get(activeTabId)
      if (!paneInner) return {}
      const idx = paneInner.instances.findIndex((i) => i.id === instanceId)
      if (idx === -1) return {}
      const instances = paneInner.instances.slice()
      instances[idx] = { ...instances[idx], thinkingEffort: effort }
      conversationPanes.set(activeTabId, { ...paneInner, instances })
      return { conversationPanes }
    })
  } else {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId ? { ...t, thinkingEffort: effort } : t
      ),
    }))
  }
}
