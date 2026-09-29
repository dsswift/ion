import { log as _log } from '../../logger'
import { useSessionStore } from '../../store/sessionStore'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/**
 * Fork a conversation at one of its messages. Returns the new tab and the
 * draft the fork seeded it with (the forked turn's text, ready to edit), or
 * `null` when the store refused the fork. One implementation for the
 * `desktop_*` command and the `session.forkFromMessage` Studio action.
 */
export async function forkConversationFromMessage(tabId: string, messageId: string): Promise<{ tabId: string; pendingInput: string } | null> {
  const store = useSessionStore
  const newTabId = await (store.getState() as unknown as { forkFromMessage: (tabId: string, messageId: string) => Promise<string | null> })
    .forkFromMessage(tabId, messageId)
  if (!newTabId) {
    log('fork_from_message: store refused the fork', { tab_id: tabId, message_id: messageId })
    return null
  }
  const pendingInput = store.getState().tabs.find((t) => t.id === newTabId)?.pendingInput || ''
  log('fork_from_message: forked', { tab_id: tabId, new_tab_id: newTabId, pending_input_len: pendingInput.length })
  return { tabId: newTabId, pendingInput }
}

/**
 * Rewind a conversation instance to one of its user turns. The store's rewind
 * is transactional and async: it asks the engine first and changes local state
 * only on success, so the draft is read after the await, never before.
 * `pendingInput` is the rewound turn's text, ready to edit. One implementation
 * for the `desktop_*` command and the `engine.rewind` Studio action.
 */
export async function rewindConversationInstance(tabId: string, instanceId: string, messageId: string, userTurnIndex: number | null): Promise<{ ok: boolean; error?: string; pendingInput?: string }> {
  const store = useSessionStore
  const res = await (store.getState() as unknown as {
    rewindEngineInstance: (tabId: string, instanceId: string, messageId: string, userTurnIndex: number | null) => Promise<{ ok: boolean; error?: string }>
  }).rewindEngineInstance(tabId, instanceId, messageId, userTurnIndex)
  if (!res.ok) {
    const error = res.error ?? 'unknown'
    log('engine_rewind: rejected', { tab_id: tabId, instance_id: instanceId, error })
    return { ok: false, error }
  }
  const pendingInput = store.getState().tabs.find((t) => t.id === tabId)?.pendingInput || ''
  log('engine_rewind: applied', { tab_id: tabId, instance_id: instanceId, pending_input_len: pendingInput.length })
  return { ok: true, pendingInput }
}
