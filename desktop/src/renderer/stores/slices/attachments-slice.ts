import type { StoreSet, StoreGet, State } from '../session-store-types'
import { commitInstance } from '../conversation-instance'

export function createAttachmentsSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    addAttachments: (attachments) => {
      const { activeTabId } = get()
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === activeTabId
            ? { ...t, attachments: [...t.attachments, ...attachments] }
            : t
        ),
      }))
    },

    removeAttachment: (attachmentId) => {
      const { activeTabId } = get()
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === activeTabId
            ? { ...t, attachments: t.attachments.filter((a) => a.id !== attachmentId) }
            : t
        ),
      }))
    },

    clearAttachments: () => {
      const { activeTabId } = get()
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === activeTabId ? { ...t, attachments: [] } : t
        ),
      }))
    },

    editQueuedMessage: (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab || tab.queuedPrompts.length === 0) return
      const text = tab.queuedPrompts[0]
      // queuedPrompts + pendingInput stay on the tab; draftInput moved to the
      // active conversation instance, so commit it there.
      set((s) => {
        const conversationPanes = commitInstance(s.conversationPanes, tabId, (inst) => ({ ...inst, draftInput: text }))
        const tabs = s.tabs.map((t) =>
          t.id === tabId ? { ...t, queuedPrompts: [], pendingInput: text } : t
        )
        return { tabs, conversationPanes }
      })
    },

    setDraftInput: (tabId, text) => {
      // draftInput now lives on the active conversation instance.
      set((s) => ({
        conversationPanes: commitInstance(s.conversationPanes, tabId, (inst) => ({ ...inst, draftInput: text })),
      }))
    },

    clearPendingInput: (tabId) => {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, pendingInput: undefined } : t
        ),
      }))
    },
  }
}
