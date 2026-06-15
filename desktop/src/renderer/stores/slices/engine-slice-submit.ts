/**
 * engine-slice-submit — prompt submission and messaging actions
 *
 * Extracted from engine-slice.ts to keep that file under the 600-line
 * TypeScript cap. Contains the four actions that write user-initiated
 * content into engine instances:
 *
 *   - submitEnginePrompt   — send a prompt to the active instance
 *   - respondEngineDialog  — answer a dialog raised by the engine
 *   - addEngineSystemMessage — inject a system message by compound key
 *   - setEngineDraftInput  — persist the InputBar draft per instance
 *
 * All four are spread into the object returned by createEngineSlice.
 */

import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { parseSessionKey } from '../../../shared/session-key'

export function createEngineSubmitActions(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    submitEnginePrompt: (tabId, text, appendSystemPrompt, imageAttachments, rawAttachments, implementationPhase) => {
      const pane = get().conversationPanes.get(tabId)
      const instanceId = pane?.activeInstanceId
      if (!instanceId) return
      const key = `${tabId}:${instanceId}`
      // Sync plan mode to the engine session via compound key before
      // submitting the prompt. Read from the per-instance permissionMode field.
      const inst = pane.instances.find((i) => i.id === instanceId)
      const isPlanMode = inst?.permissionMode === 'plan'
      window.ion.engineSetPlanMode(key, isPlanMode)
      // Build a FileAttachment list from the encoded image attachments so
      // the user-message bubble can render images inline. The path is the
      // only field needed at render time; main-side READ_IMAGE_DATA_URL
      // turns it into a data URL for <img>.
      const userAttachments = rawAttachments && rawAttachments.length > 0
        ? rawAttachments.map((a) => ({
          id: a.id,
          type: a.type,
          name: a.name,
          path: a.path,
          mimeType: a.mimeType,
        }))
        : (imageAttachments || [])
          .filter((a) => !!a.path)
          .map((a) => ({
            id: crypto.randomUUID(),
            type: 'image' as const,
            name: (a.path?.split('/').pop() || 'image'),
            path: a.path!,
            mimeType: a.mediaType,
          }))
      set((state) => {
        const pinnedPrompt = new Map(state.enginePinnedPrompt)
        pinnedPrompt.set(key, text)
        // Add user message and clear permissionDenied on the instance.
        const conversationPanes = new Map(state.conversationPanes)
        const paneInner = conversationPanes.get(tabId)
        if (paneInner) {
          const idx = paneInner.instances.findIndex((i) => i.id === instanceId)
          if (idx !== -1) {
            const instances = paneInner.instances.slice()
            const msgs = [...(instances[idx].messages || []), {
              id: nextMsgId(),
              role: 'user' as const,
              content: text,
              timestamp: Date.now(),
              ...(userAttachments.length > 0 ? { attachments: userAttachments } : {}),
            }]
            instances[idx] = {
              ...instances[idx],
              messages: msgs,
              // Clear any pending engine-instance denial — submitting a new
              // prompt is the user moving past the question/plan card. Mirrors
              // the engine-side clearing in `prompt_dispatch.go`.
              permissionDenied: null,
            }
            conversationPanes.set(tabId, { ...paneInner, instances })
          }
        }
        const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'running' as const, attachments: [] } : t)
        return { enginePinnedPrompt: pinnedPrompt, conversationPanes, tabs }
      })
      const prefs = usePreferencesStore.getState()
      // Re-read inst from store in case set() above updated panes
      const currentInst = get().conversationPanes.get(tabId)?.instances.find((i) => i.id === instanceId)
      const rawModel = currentInst?.modelOverride || prefs.engineDefaultModel || prefs.preferredModel || undefined
      // Filter out invalid model values (e.g. "unknown" from stale state)
      // so the engine's own defaultModel resolution handles the fallback.
      const modelOverride = rawModel === 'unknown' ? undefined : rawModel

      // ─── Rewind context injection ───
      // If this instance was rewound (forkedFromConversationIds is set),
      // inject the prior conversation as a system prompt so the fresh
      // engine session has context from before the rewind point. Same
      // pattern as CLI rewind in send-slice.ts. One-shot: cleared after
      // injection regardless of whether prior messages existed.
      let effectiveSystemPrompt = appendSystemPrompt
      if (currentInst?.forkedFromConversationIds) {
        const priorMessages = (currentInst.messages ?? [])
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .filter((m) => m.content.trim().length > 0)
        if (priorMessages.length > 0) {
          const transcript = priorMessages
            .map((m) => `[${m.role}]: ${m.content}`)
            .join('\n\n')
          const forkCtx = `This conversation was forked from a previous session. Here is the conversation history up to the fork point:\n\n<prior-conversation>\n${transcript}\n</prior-conversation>\n\nContinue from this point. The user's next message is the first message in this forked conversation.`
          effectiveSystemPrompt = effectiveSystemPrompt
            ? `${effectiveSystemPrompt}\n\n${forkCtx}`
            : forkCtx
          console.log(`[engine] rewind context injected: key=${key} priorMessages=${priorMessages.length} transcriptLen=${transcript.length} forkedFrom=${JSON.stringify(currentInst.forkedFromConversationIds)}`)
        } else {
          console.log(`[engine] rewind context skipped (no prior user/assistant messages): key=${key} forkedFrom=${JSON.stringify(currentInst.forkedFromConversationIds)}`)
        }
        // Clear forkedFromConversationIds — one-shot injection.
        console.log(`[engine] rewind context cleared forkedFromConversationIds: key=${key}`)
        set((state) => {
          const conversationPanes = new Map(state.conversationPanes)
          const paneInner = conversationPanes.get(tabId)
          if (paneInner) {
            const idx2 = paneInner.instances.findIndex((i) => i.id === instanceId)
            if (idx2 !== -1) {
              const instances = paneInner.instances.slice()
              instances[idx2] = { ...instances[idx2], forkedFromConversationIds: null }
              conversationPanes.set(tabId, { ...paneInner, instances })
            }
          }
          return { conversationPanes }
        })
      }

      window.ion.enginePrompt(key, text, modelOverride, effectiveSystemPrompt, imageAttachments, rawAttachments, implementationPhase).then((result) => {
        if (result && !result.ok) {
          set((state) => {
            const conversationPanes = new Map(state.conversationPanes)
            const paneInner = conversationPanes.get(tabId)
            if (paneInner) {
              const idx = paneInner.instances.findIndex((i) => i.id === instanceId)
              if (idx !== -1) {
                const instances = paneInner.instances.slice()
                const msgs = [...(instances[idx].messages || []), { id: nextMsgId(), role: 'system' as const, content: `Error: ${result.error}`, timestamp: Date.now() }]
                instances[idx] = { ...instances[idx], messages: msgs }
                conversationPanes.set(tabId, { ...paneInner, instances })
              }
            }
            const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
            return { conversationPanes, tabs }
          })
        }
      }).catch((err: any) => {
        set((state) => {
          const conversationPanes = new Map(state.conversationPanes)
          const paneInner = conversationPanes.get(tabId)
          if (paneInner) {
            const idx = paneInner.instances.findIndex((i) => i.id === instanceId)
            if (idx !== -1) {
              const instances = paneInner.instances.slice()
              const msgs = [...(instances[idx].messages || []), { id: nextMsgId(), role: 'system' as const, content: `Error: ${err.message}`, timestamp: Date.now() }]
              instances[idx] = { ...instances[idx], messages: msgs }
              conversationPanes.set(tabId, { ...paneInner, instances })
            }
          }
          const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
          return { conversationPanes, tabs }
        })
      })
    },

    respondEngineDialog: (tabId, dialogId, value) => {
      const pane = get().conversationPanes.get(tabId)
      const instanceId = pane?.activeInstanceId
      if (!instanceId) return
      const key = `${tabId}:${instanceId}`
      set((state) => {
        const dialogs = new Map(state.engineDialogs)
        dialogs.set(key, null)
        return { engineDialogs: dialogs }
      })
      window.ion.engineDialogResponse(key, dialogId, value)
    },

    addEngineSystemMessage: (key, content) => {
      // Write system message directly onto the instance in conversationPanes.
      set((state) => {
        const { tabId, instanceId } = parseSessionKey(key)
        const conversationPanes = new Map(state.conversationPanes)
        const paneInner = conversationPanes.get(tabId)
        if (!paneInner) return {}
        const idx = paneInner.instances.findIndex((i) => i.id === instanceId)
        if (idx === -1) return {}
        const instances = paneInner.instances.slice()
        const msgs = [...(instances[idx].messages || []), { id: nextMsgId(), role: 'system' as const, content, timestamp: Date.now() }]
        instances[idx] = { ...instances[idx], messages: msgs }
        conversationPanes.set(tabId, { ...paneInner, instances })
        return { conversationPanes }
      })
    },

    setEngineDraftInput: (key, text) => {
      // Write draftInput directly onto the instance in conversationPanes.
      set((state) => {
        const { tabId, instanceId } = parseSessionKey(key)
        const conversationPanes = new Map(state.conversationPanes)
        const paneInner = conversationPanes.get(tabId)
        if (!paneInner) return {}
        const idx = paneInner.instances.findIndex((i) => i.id === instanceId)
        if (idx === -1) return {}
        const instances = paneInner.instances.slice()
        instances[idx] = { ...instances[idx], draftInput: text }
        conversationPanes.set(tabId, { ...paneInner, instances })
        return { conversationPanes }
      })
    },
  }
}
