import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log, debug as _debug } from '../logger'
import { state, pairingManager, relayDiscovery } from '../state'
import { readSettings } from '../settings-store'
import { initRemoteTransport } from '../remote/transport-init'
import { revokeDeviceLocally } from '../remote/revoke'
import { requestLogsFromFirstDevice } from '../remote/handlers/diagnostics'
import { setRemoteDisplay, readRemoteDisplay } from '../remote/handlers/display'
import { isValidRemoteTabStatesPayload } from '../ipc-validation'
import type { RemoteTabStatesPayload } from '../../shared/remote-projection-types'
import type { DiscoveredRelay } from '../remote/discovery'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
}

export function registerRemoteControlIpc(): void {
  // Renderer-push snapshot projection: the OWNER renderer pushes its
  // projected RemoteTabStatesPayload on store change (debounced). Cache it
  // with an arrival timestamp; getRemoteTabStates() (remote/snapshot.ts)
  // serves the cache when fresh and falls back to the legacy renderer poll
  // when empty/stale. Validated before caching — a malformed payload is
  // dropped (logged), never cached.
  ipcMain.on(IPC.REMOTE_TAB_STATES_PUSH, (_event, payload: unknown) => {
    if (!isValidRemoteTabStatesPayload(payload)) {
      log('remote_tab_states_push: rejected malformed payload', {
        payload_type: typeof payload,
        has_tabs: !!(payload as { tabs?: unknown })?.tabs,
      })
      return
    }
    const p = payload as unknown as RemoteTabStatesPayload
    state.rendererSnapshotCache = {
      tabs: p.tabs,
      resourceManifest: p.resourceManifest,
      receivedAt: Date.now(),
    }
    debug('remote_tab_states_push: cache updated', {
      tab_count: p.tabs.length,
      resource_kinds: Object.keys(p.resourceManifest).length,
    })
  })

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
      log('pairing_code_generated', { code })
      return code
    } catch (err) {
      log('start_pairing: failed', { error: (err as Error).message })
      return null
    }
  })

  ipcMain.on(IPC.REMOTE_CANCEL_PAIRING, () => {
    pairingManager.cancelPairing()
  })

  ipcMain.on(IPC.REMOTE_REVOKE_DEVICE, (_event, deviceId: string) => {
    log('revoke_paired_device', { device_id: deviceId })

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
      log('remote_get_messages: error', { error: (err as Error).message })
      return []
    }
  })

  ipcMain.handle(IPC.REMOTE_REQUEST_IOS_LOGS, async () => {
    try {
      const logs = await requestLogsFromFirstDevice()
      return { ok: true, logs }
    } catch (err) {
      log('remote_request_ios_logs: error', { error: (err as Error).message })
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.REMOTE_SET_DISPLAY, (_event, customName: string | null, customIcon: string | null) => {
    log('remote_set_display', { has_name: customName !== null, icon: customIcon ?? '' })
    const result = setRemoteDisplay(customName, customIcon, Date.now(), 'desktop')
    return result.value
  })

  ipcMain.handle('ion:remote-get-display', () => {
    const value = readRemoteDisplay()
    log('remote_get_display', { has_value: !!value, has_name: value ? value.customName !== null : false, icon: value?.customIcon ?? '', ts: value?.updatedAt ?? 0 })
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
