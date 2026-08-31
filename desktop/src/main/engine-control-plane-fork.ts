import type { EngineBridge } from './engine-bridge'
import type { TabEntry } from './engine-control-plane-events-types'
import { error, log, warn } from './logger'

export interface ForkSessionTarget {
  messageIndex: number
  entryId?: string
  userTurnIndex?: number
}

export interface ForkSessionResult {
  ok: boolean
  error?: string
  conversationId?: string
}

/**
 * Fork one live tab into another registered tab.
 *
 * The engine owns the durable copy. The client does not publish the target tab
 * identity until the engine has created and started the independent conversation.
 */
export async function forkControlPlaneSession(
  bridge: EngineBridge,
  tabs: Map<string, TabEntry>,
  sourceTabId: string,
  newTabId: string,
  target: ForkSessionTarget,
  resyncStatus: (tabId: string, reason: string) => void,
): Promise<ForkSessionResult> {
  const source = tabs.get(sourceTabId)
  const targetTab = tabs.get(newTabId)
  if (!source || !targetTab) {
    warn('SessionPlane', 'fork_session: source or target tab missing', { source_tab_id: sourceTabId, new_tab_id: newTabId })
    return { ok: false, error: 'Source or target tab not found' }
  }
  if (!source.engineSessionStarted || !source.conversationId) {
    warn('SessionPlane', 'fork_session: source session is not ready', { source_tab_id: sourceTabId, new_tab_id: newTabId })
    return { ok: false, error: 'Source conversation is not ready to fork' }
  }

  log('SessionPlane', 'fork_session: starting', {
    source_tab_id: sourceTabId, new_tab_id: newTabId, source_conversation_id: source.conversationId,
  })
  const result = await bridge.forkSession(sourceTabId, newTabId, target)
  if (!result.ok || !result.conversationId) {
    error('SessionPlane', 'fork_session: failed', {
      source_tab_id: sourceTabId, new_tab_id: newTabId, error: result.error ?? 'missing conversation id',
    })
    return { ok: false, error: result.error ?? 'Fork did not return a conversation ID' }
  }

  targetTab.conversationId = result.conversationId
  targetTab.engineSessionStarted = true
  targetTab.resumedSavedConversation = false
  targetTab.permissionMode = source.permissionMode
  bridge.updateSessionConversationId(newTabId, result.conversationId)
  log('SessionPlane', 'fork_session: complete', {
    source_tab_id: sourceTabId, new_tab_id: newTabId, conversation_id: result.conversationId,
  })
  resyncStatus(newTabId, 'fork_session_live')
  return { ok: true, conversationId: result.conversationId }
}
