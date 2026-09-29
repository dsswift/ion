import type { StoreSet, StoreGet, State } from '../session-store-types'
import type { FileAttachment } from '@ion/shared/types-session'
import { commitInstance, activeInstance } from '../conversation-instance'
import { needsPreviewRehydration } from '@ion/shared/staged-attachments'
import { rDebug, rInfo, rWarn } from '../rendererLogger'
import { attachFileByPath } from '../host-api'

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

    // Restore writes the tray back without `dataUrl` (persistence strips the
    // base64 preview — see shared/staged-attachments.ts). Walk every tab once
    // and rebuild the preview from the attachment's permanent path so a
    // restored image renders as a thumbnail instead of a bare filename.
    rehydrateAttachmentPreviews: async () => {
      const targets: Array<{ tabId: string; id: string; path: string }> = []
      for (const t of get().tabs) {
        for (const a of t.attachments) {
          if (needsPreviewRehydration(a)) targets.push({ tabId: t.id, id: a.id, path: a.path })
        }
      }
      if (targets.length === 0) return
      rDebug('attachments', 'rehydrating staged attachment previews', { count: targets.length })

      let rebuilt = 0
      for (const target of targets) {
        let described: FileAttachment | null = null
        try {
          described = await attachFileByPath(target.path)
        } catch (err) {
          rWarn('attachments', 'preview rehydration failed', { attachment_id: target.id, error: String(err) })
          continue
        }
        // A missing or unreadable file yields null. Keep the row — the path may
        // come back, and dropping a staged attachment silently is worse than
        // showing it without a thumbnail.
        if (!described?.dataUrl) {
          rDebug('attachments', 'preview unavailable, keeping row without thumbnail', { attachment_id: target.id })
          continue
        }
        const dataUrl = described.dataUrl
        rebuilt++
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === target.tabId
              ? { ...t, attachments: t.attachments.map((a) => (a.id === target.id ? { ...a, dataUrl } : a)) }
              : t
          ),
        }))
      }
      rInfo('attachments', 'staged attachment previews rehydrated', { requested: targets.length, rebuilt })
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
      // draftInput now lives on the active conversation instance, and is
      // owner-durable: writing it here marks conversationPanes dirty, which
      // the persistence subscriber debounces into the tabs file, which
      // boot-restore-tab.ts reads back. That is the whole path by which an
      // unsent prompt survives a quit — every client's composer forwards here
      // rather than keeping the text to itself.
      //
      // The draft text itself is never logged: it is the operator's unsent
      // words, and a prompt in the log file is a prompt in every log bundle.
      // The length is what a diagnosis needs (did the write arrive, was it a
      // clear or a keystroke) and it is what the restore path already logs.
      const previous = activeInstance(get().conversationPanes, tabId)?.draftInput ?? ''
      set((s) => ({
        conversationPanes: commitInstance(s.conversationPanes, tabId, (inst) => ({ ...inst, draftInput: text })),
      }))
      if (previous === text) {
        rDebug('drafts', 'draft write is a no-op; text unchanged', { tab_id: tabId, count: text.length })
        return
      }
      rDebug('drafts', text.length === 0 ? 'draft cleared' : 'draft updated', {
        tab_id: tabId,
        count: text.length,
        previous_count: previous.length,
      })
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
