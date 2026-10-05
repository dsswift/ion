/**
 * active-path-reload — the store's answer to `active_path_changed`.
 *
 * The engine moved a conversation onto another branch of its tree; the model
 * context now holds that path only. The event names no rows, so the active
 * instance's transcript is rebuilt from the engine's history of the new path
 * and every attached client is handed the replacement, the same way a
 * rewind publishes its truncated history.
 */
import type { NormalizedEvent } from '@ion/shared/types-events'
import { mapSessionHistory } from '@ion/shared/session-message-mapper'
import type { StoreSet, StoreGet } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { commitInstance } from '../conversation-instance'
import { buildRestoredDenied } from './resume-slice-restore-denied'
import { engineBroadcastHistory, loadChainHistory } from '../host-api'
import { rError, rInfo, rWarn } from '../rendererLogger'

type ActivePathChanged = Extract<NormalizedEvent, { type: 'active_path_changed' }>

export async function reloadActivePath(set: StoreSet, get: StoreGet, tabId: string, event: ActivePathChanged): Promise<void> {
  const tab = get().tabs.find((t) => t.id === tabId)
  if (!tab?.conversationId) {
    rWarn('engine.branch', 'active path changed: tab has no conversation, nothing to reload', { tab_id: tabId.slice(0, 8), conversation_id: event.conversationId })
    return
  }
  if (tab.conversationId !== event.conversationId) {
    rWarn('engine.branch', 'active path changed: event names another conversation, not reloading', { tab_id: tabId.slice(0, 8), conversation_id: event.conversationId, tab_conversation_id: tab.conversationId })
    return
  }

  let history: Awaited<ReturnType<typeof loadChainHistory>>
  try {
    history = await loadChainHistory([...(tab.historicalSessionIds ?? []), tab.conversationId])
  } catch (err) {
    rError('engine.branch', 'active path changed: history load failed, transcript left as it was', { tab_id: tabId.slice(0, 8), conversation_id: event.conversationId, error: String(err) })
    return
  }
  const messages = mapSessionHistory(history, nextMsgId)
  set((s) => ({
    conversationPanes: commitInstance(s.conversationPanes, tabId, (inst) => ({
      ...inst,
      messages,
      messageCount: messages.length,
      permissionDenied: buildRestoredDenied(messages),
      historyHydrated: true,
    })),
  }))
  rInfo('engine.branch', 'active path changed: transcript replaced', {
    tab_id: tabId.slice(0, 8), conversation_id: event.conversationId, leaf_id: event.leafId,
    previous_leaf_id: event.previousLeafId ?? '', count: messages.length,
  })
  await engineBroadcastHistory(tabId, null)
}
