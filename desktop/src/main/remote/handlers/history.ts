import { log as _log } from '../../logger'
import { state } from '../../state'
import { revokeDeviceLocally } from '../revoke'
import { clearLoadGateForDevice } from './load-conversation-gate'
import type { RemoteCommand } from '../protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

export async function handleForkFromMessage(cmd: Extract<RemoteCommand, { type: 'desktop_fork_from_message' }>): Promise<void> {
  try {
    const escapedTabId = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedMsgId = cmd.messageId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const result = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return Promise.resolve(null);
        return store.getState().forkFromMessage('${escapedTabId}', '${escapedMsgId}')
          .then(function(newTabId) {
            if (!newTabId) return null;
            var tab = store.getState().tabs.find(function(t) { return t.id === newTabId; });
            return { newTabId: newTabId, inputText: tab ? tab.pendingInput || '' : '' };
          });
      })()
    `)
    if (result?.newTabId) {
      state.remoteTransport?.send({
        type: 'desktop_input_prefill',
        tabId: result.newTabId,
        text: result.inputText,
        switchTo: true,
      })
    }
  } catch (err) {
    log('fork_from_message error', { error: (err as Error).message })
  }
}

export async function handleEngineRewind(cmd: Extract<RemoteCommand, { type: 'desktop_engine_rewind' }>): Promise<void> {
  try {
    const escapedTabId = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedInstId = cmd.instanceId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedMsgId = cmd.messageId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    // userTurnIndex is the 0-based index of the target among role==='user'
    // messages. iOS supplies it because its optimistic user-message id is a
    // UUID the desktop store never minted (the desktop uses nextMsgId()), so
    // an id lookup would miss. rewindEngineInstance falls back to the ordinal
    // when the id is not found. JS-encode null when absent (desktop-initiated
    // rewinds pass only the id and omit the index).
    const userTurnIndexArg = typeof cmd.userTurnIndex === 'number' ? String(cmd.userTurnIndex) : 'null'
    // rewindEngineInstance is TRANSACTIONAL and async: it calls the engine
    // first and mutates local (and Studio/iOS) state only on success. The
    // executeJavaScript call MUST await the returned promise — reading
    // tab.pendingInput synchronously right after the fire-and-forget call
    // would race the truncation and send a prefill for a rewind that had not
    // actually completed (or had been rejected) yet.
    const result = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return { ok: false, error: 'no store', inputText: null };
        return store.getState().rewindEngineInstance('${escapedTabId}', '${escapedInstId}', '${escapedMsgId}', ${userTurnIndexArg})
          .then(function(res) {
            var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTabId}'; });
            return { ok: res.ok, error: res.error || null, inputText: (res.ok && tab) ? (tab.pendingInput || null) : null };
          });
      })()
    `) as { ok: boolean; error: string | null; inputText: string | null } | undefined
    if (!result || !result.ok) {
      const error = result?.error ?? 'unknown'
      log('engine_rewind: rejected', { tab_id: cmd.tabId, instance_id: cmd.instanceId, error })
      // Tell iOS the rewind was refused. Without this reply the user taps
      // "Rewind", the transcript never changes (correctly — the engine
      // refused it), and iOS shows nothing at all: a silent no-op that reads
      // as the button doing nothing. A successful rewind stays silent by
      // convention (observable through the existing history/prefill push);
      // only the failure path needs an explicit notice.
      state.remoteTransport?.send({
        type: 'desktop_engine_rewind_result',
        tabId: cmd.tabId,
        instanceId: cmd.instanceId,
        status: 'rejected',
        error,
      })
      return
    }
    if (result.inputText) {
      state.remoteTransport?.send({ type: 'desktop_input_prefill', tabId: cmd.tabId, text: result.inputText, instanceId: cmd.instanceId })
    }
  } catch (err) {
    const error = (err as Error).message
    log('engine_rewind error', { error })
    state.remoteTransport?.send({
      type: 'desktop_engine_rewind_result',
      tabId: cmd.tabId,
      instanceId: cmd.instanceId,
      status: 'rejected',
      error,
    })
  }
}

export function handleUnpair(deviceId: string): void {
  if (deviceId) {
    log('remote_unpair', { device_id: deviceId })
    state.remoteTransport?.removeDevice(deviceId)
    revokeDeviceLocally(deviceId)
    // Drop the load-conversation coalesce entries for this device so its keys
    // don't linger (the gate self-prunes too, but an unpair is a clean signal).
    clearLoadGateForDevice(deviceId)
  } else {
    log('Remote unpair command but no device ID')
  }
}
