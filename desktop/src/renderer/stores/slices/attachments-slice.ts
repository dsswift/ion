import type { StoreSet, StoreGet, State } from '../session-store-types'

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
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, queuedPrompts: [], pendingInput: text, draftInput: text } : t
        ),
      }))
    },

    setDraftInput: (tabId, text) => {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, draftInput: text } : t
        ),
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
