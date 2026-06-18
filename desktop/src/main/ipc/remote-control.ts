import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { state, pairingManager, relayDiscovery } from '../state'
import { readSettings } from '../settings-store'
import { initRemoteTransport } from '../remote/transport-init'
import { revokeDeviceLocally } from '../remote/revoke'
import { requestLogsFromFirstDevice } from '../remote/handlers/diagnostics'
import { setRemoteDisplay, readRemoteDisplay } from '../remote/handlers/display'
import type { DiscoveredRelay } from '../remote/discovery'

function log(msg: string): void {
  _log('main', msg)
}

export function registerRemoteControlIpc(): void {
  ipcMain.handle(IPC.REMOTE_GET_STATE, () => {
    return { transportState: state.remoteTransport?.state || 'disconnected' }
  })

  ipcMain.handle(IPC.REMOTE_SET_LAN_DISABLED, async (_event, disabled: boolean) => {
    if (state.remoteTransport) {
      await state.remoteTransport.setLanDisabled(disabled)
    }
  })

  ipcMain.handle(IPC.REMOTE_START_PAIRING, () => {
    try {
      if (!state.remoteTransport) {
        const settings = readSettings()
        if (settings.remoteEnabled) {
          initRemoteTransport(settings)
        }
      }

      const code = pairingManager.startPairing()
      log(`Pairing code generated: ${code}`)
      return code
    } catch (err) {
      log(`Failed to start pairing: ${(err as Error).message}`)
      return null
    }
  })

  ipcMain.on(IPC.REMOTE_CANCEL_PAIRING, () => {
    pairingManager.cancelPairing()
  })

  ipcMain.on(IPC.REMOTE_REVOKE_DEVICE, (_event, deviceId: string) => {
    log(`Revoking paired device: ${deviceId}`)

    if (state.remoteTransport) {
      log('[Remote] sending unpair event to iOS device ' + deviceId)
      state.remoteTransport.sendToDevice(deviceId, { type: 'desktop_unpair' })
      setTimeout(() => {
        state.remoteTransport?.disconnectDevice(deviceId, 4000, 'unpair')
        state.remoteTransport?.removeDevice(deviceId)
      }, 300)
    }

    revokeDeviceLocally(deviceId)
  })

  ipcMain.handle(IPC.REMOTE_GET_MESSAGES, async (_event, tabId: string) => {
    try {
      const result = await state.mainWindow?.webContents.executeJavaScript(`
        (function() {
          try {
            var store = window.__Ion_SESSION_STORE__;
            if (!store) return [];
            var s = store.getState();
            var tab = s.tabs.find(function(t) { return t.id === '${tabId.replace(/'/g, "\\'")}'; });
            if (!tab) return [];
            // Messages now live on the active ConversationInstance in conversationPanes.
            var pane = s.conversationPanes ? s.conversationPanes.get(tab.id) : null;
            var inst = pane ? (pane.instances.find(function(i){ return i.id === pane.activeInstanceId; }) || pane.instances[0]) : null;
            return inst ? JSON.parse(JSON.stringify(inst.messages || [])) : [];
          } catch(e) { return []; }
        })()
      `)
      return result || []
    } catch (err) {
      log(`REMOTE_GET_MESSAGES error: ${(err as Error).message}`)
      return []
    }
  })

  ipcMain.handle(IPC.REMOTE_REQUEST_IOS_LOGS, async () => {
    try {
      const logs = await requestLogsFromFirstDevice()
      return { ok: true, logs }
    } catch (err) {
      log(`REMOTE_REQUEST_IOS_LOGS error: ${(err as Error).message}`)
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.REMOTE_SET_DISPLAY, (_event, customName: string | null, customIcon: string | null) => {
    log(`IPC.REMOTE_SET_DISPLAY: name=${customName === null ? 'null' : 'set'} icon=${customIcon ?? 'null'}`)
    const result = setRemoteDisplay(customName, customIcon, Date.now(), 'desktop')
    return result.value
  })

  ipcMain.handle('ion:remote-get-display', () => {
    const value = readRemoteDisplay()
    log(`IPC.remote-get-display: ${value ? `name=${value.customName === null ? 'null' : 'set'} icon=${value.customIcon ?? 'null'} ts=${value.updatedAt}` : 'unset'}`)
    return value
  })

  relayDiscovery.on('relays-changed', (relays: DiscoveredRelay[]) => {
    state.mainWindow?.webContents.send(IPC.REMOTE_RELAYS_CHANGED, relays)
  })

  ipcMain.handle(IPC.REMOTE_DISCOVER_RELAYS, () => {
    relayDiscovery.startBrowsing()
    return relayDiscovery.relays
  })

  ipcMain.on(IPC.REMOTE_STOP_DISCOVERY, () => {
    relayDiscovery.stopBrowsing()
  })

  ipcMain.handle(IPC.REMOTE_TEST_RELAY, async (_event, relayUrl: string, relayApiKey: string) => {
    const WebSocket = (await import('ws')).default
    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      try {
        const base = relayUrl.replace(/\/+$/, '')
        const ws = new WebSocket(`${base}/v1/channel/_test?role=ion`, {
          headers: { Authorization: `Bearer ${relayApiKey}` },
        })
        const timeout = setTimeout(() => {
          ws.close()
          resolve({ success: false, error: 'Connection timed out' })
        }, 5000)
        ws.on('open', () => {
          clearTimeout(timeout)
          ws.close()
          resolve({ success: true })
        })
        ws.on('error', (err) => {
          clearTimeout(timeout)
          resolve({ success: false, error: (err as Error).message })
        })
      } catch (err) {
        resolve({ success: false, error: (err as Error).message })
      }
    })
  })
}
