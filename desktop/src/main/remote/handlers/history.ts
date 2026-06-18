import { log as _log } from '../../logger'
import { state } from '../../state'
import { revokeDeviceLocally } from '../revoke'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

export async function handleRewind(cmd: Extract<RemoteCommand, { type: 'desktop_rewind' }>): Promise<void> {
  try {
    const escapedTabId = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedMsgId = cmd.messageId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const inputText = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        store.getState().rewindToMessage('${escapedTabId}', '${escapedMsgId}');
        var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTabId}'; });
        return tab ? tab.pendingInput || null : null;
      })()
    `)
    if (inputText) {
      state.remoteTransport?.send({ type: 'desktop_input_prefill', tabId: cmd.tabId, text: inputText })
    }
  } catch (err) {
    log(`rewind error: ${(err as Error).message}`)
  }
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
    log(`fork_from_message error: ${(err as Error).message}`)
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
    const inputText = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        store.getState().rewindEngineInstance('${escapedTabId}', '${escapedInstId}', '${escapedMsgId}', ${userTurnIndexArg});
        var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTabId}'; });
        return tab ? tab.pendingInput || null : null;
      })()
    `)
    if (inputText) {
      state.remoteTransport?.send({ type: 'desktop_input_prefill', tabId: cmd.tabId, text: inputText, instanceId: cmd.instanceId })
    }
  } catch (err) {
    log(`engine_rewind error: ${(err as Error).message}`)
  }
}

export function handleUnpair(deviceId: string): void {
  if (deviceId) {
    log(`Remote unpair command from device ${deviceId}`)
    state.remoteTransport?.removeDevice(deviceId)
    revokeDeviceLocally(deviceId)
  } else {
    log('Remote unpair command but no device ID')
  }
}
