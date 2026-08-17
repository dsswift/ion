/**
 * Reconnect-time tab reconciliation for `EngineControlPlane`.
 *
 * Extracted from `engine-control-plane.ts` to keep it under the 600-line
 * TypeScript cap. Both listeners here answer the same question — "what is
 * true about this tab now that the socket came back?" — so they belong
 * together and away from the prompt/lifecycle bulk of the control plane.
 */
import { log as _log } from './logger'
import type { EngineBridge } from './engine-bridge'
import type { TabEntry } from './engine-control-plane-events'
import type { TabStatus } from '../shared/types'

// Same tag the control plane logs under: these listeners are part of its
// lifecycle, so their lines must stay greppable alongside it.
const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/**
 * Settle a tab whose deferred interrupt was delivered on reconnect.
 *
 * The operator interrupted while the socket was down, so the bridge held the
 * abort and flushed it once reconnected (`flushPendingAborts`). That flush also
 * retires the session, which means this tab has no run left to report: without
 * this listener it would sit in running/connecting until the renderer's
 * five-second force-recovery timer fired, which is the delay the operator sees
 * as "the interrupt did nothing".
 */
export function installAbortDeliveredListener(
  bridge: EngineBridge,
  tabs: Map<string, TabEntry>,
  setStatus: (tabId: string, next: TabStatus) => void,
): void {
  bridge.on('abort-delivered', (key: string) => {
    const tab = tabs.get(key)
    if (!tab) return
    log('abort_delivered after reconnect', {
      tab_id: tab.tabId,
      prev_status: tab.status,
      conversation_id: tab.conversationId ?? '',
    })
    tab.engineSessionStarted = false
    tab.activeRequestId = null
    setStatus(tab.tabId, 'completed')
  })
}

/**
 * Clear the per-tab session-started flag after a reconnect.
 *
 * `conversationId` is intentionally preserved: the bridge's
 * `_reRegisterSessions` re-sends start_session with that id so the engine
 * resumes the original conversation rather than minting a fresh one, and the
 * B1 guard in handleStatusEvent keeps the post-restart pre-mint idle event
 * from clobbering it.
 */
export function installReconnectResetListener(
  bridge: EngineBridge,
  tabs: Map<string, TabEntry>,
): void {
  bridge.on('reconnected', () => {
    for (const tab of tabs.values()) {
      if (!tab.engineSessionStarted) continue
      log('reset_session_flag after reconnect', {
        tab_id: tab.tabId,
        conversation_id: tab.conversationId ?? '',
      })
      tab.engineSessionStarted = false
    }
  })
}
