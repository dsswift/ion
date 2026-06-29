/**
 * engine-slice-submit — engine dialog + system-message + draft actions
 *
 * Extracted from engine-slice.ts to keep that file under the 600-line
 * TypeScript cap. Contains three actions that write to engine instances:
 *
 *   - respondEngineDialog    — answer a dialog raised by the engine
 *   - addEngineSystemMessage — inject a system message by tabId
 *   - setEngineDraftInput    — persist the InputBar draft per instance
 *
 * (Prompt submission is no longer here: `submitEnginePrompt` was removed when
 * the engine-vs-plain send fork collapsed into the single `submit` action in
 * send-slice.ts. Every conversation tab — plain or extension-backed — submits
 * through that one path.)
 *
 * All three are spread into the object returned by createEngineSlice.
 */

import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { commitInstance } from '../conversation-instance'

export function createEngineSubmitActions(set: StoreSet, get: StoreGet): Partial<State> {
  return {

    respondEngineDialog: (tabId, dialogId, value) => {
      const pane = get().conversationPanes.get(tabId)
      const instanceId = pane?.activeInstanceId
      if (!instanceId) return
      set((state) => {
        const dialogs = new Map(state.engineDialogs)
        dialogs.set(tabId, null)
        return { engineDialogs: dialogs }
      })
      window.ion.engineDialogResponse(tabId, dialogId, value)
    },

    addEngineSystemMessage: (tabId, content, planFilePath) => {
      // Append a system message onto the active conversation instance.
      // commitInstance resolves the active instance internally — no compound
      // key needed since Phase 4b collapsed every tab to a single 'main' instance.
      // `planFilePath` is optional and only set on plan-lifecycle dividers
      // (e.g. the "Implementing plan" divider) so the renderer can make the
      // slug a clickable link to the plan preview.
      set((state) => {
        const msg = {
          id: nextMsgId(),
          role: 'system' as const,
          content,
          timestamp: Date.now(),
          ...(planFilePath ? { planFilePath } : {}),
        }
        const conversationPanes = commitInstance(state.conversationPanes, tabId, (inst) => ({
          ...inst,
          messages: [...(inst.messages || []), msg],
        }))
        return { conversationPanes }
      })
    },

    insertRemoteUserMessage: (tabId, content, slashCommand, slashArgs) => {
      // Insert a user message for a remote-originated prompt that bypassed the
      // renderer's submit() path. This happens when an extension command
      // succeeds synchronously: the extension's ctx.sendPrompt starts the run,
      // but the renderer never ran submit() for the iOS prompt, so the store
      // has no user message. Without this insert, the desktop shows assistant
      // text with no preceding user bubble, and iOS history reads (which pull
      // from the renderer store) also miss the user turn.
      set((state) => {
        const msg = {
          id: nextMsgId(),
          role: 'user' as const,
          content,
          timestamp: Date.now(),
          source: 'remote' as const,
          ...(slashCommand ? { slashCommand, slashArgs: slashArgs || '' } : {}),
        }
        const conversationPanes = commitInstance(state.conversationPanes, tabId, (inst) => ({
          ...inst,
          messages: [...(inst.messages || []), msg],
        }))
        return { conversationPanes }
      })
    },

    setEngineDraftInput: (tabId, text) => {
      // Write draftInput onto the active conversation instance.
      // commitInstance resolves the active instance internally — no compound
      // key needed since Phase 4b collapsed every tab to a single 'main' instance.
      set((state) => ({
        conversationPanes: commitInstance(state.conversationPanes, tabId, (inst) => ({
          ...inst,
          draftInput: text,
        })),
      }))
    },
  }
}
