import { IPC } from '../../shared/types'
import { log as _log, warn as _warn, error as _error } from '../logger'
import { state, modelCache, deviceFocusMap } from '../state'
import { broadcast, startTerminalOutputFlushing, stopTerminalOutputFlushing } from '../broadcast'
import { readSettings } from '../settings-store'
import { RemoteTransport } from './transport'
import { handleRemoteCommand } from './command-handler'
import { handlePairRequest } from './pairing-handler'
import { revokeDeviceLocally } from './revoke'
import { startTabSnapshotPolling, stopTabSnapshotPolling } from './snapshot-polling'
import { getRemoteTabStates } from './snapshot'
import { startGitWatcherBridge, stopGitWatcherBridge } from './git-watcher-bridge'
import { focusState } from '../git/focus-state'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _error('main', msg, fields)
}

export function initRemoteTransport(settings: Record<string, unknown>): void {
  log('remote_transport: init', { remote_enabled: settings.remoteEnabled, relay_url: settings.relayUrl })

  if (state.remoteTransport) {
    stopTabSnapshotPolling()
    stopGitWatcherBridge()
    state.remoteTransport.stop()
    state.remoteTransport = null
    // No transport = no remote clients; let the git focus gate suspend again.
    focusState.setRemoteClientCount(0)
  }

  if (!settings.remoteEnabled) {
    log('[Remote] remote not enabled, skipping')
    stopTerminalOutputFlushing()
    return
  }

  const relayUrl = (settings.relayUrl as string) || ''
  const relayApiKey = (settings.relayApiKey as string) || ''

  const pairedDevices = settings.pairedDevices as any[] | undefined
  log('remote_transport: paired devices', { count: pairedDevices?.length || 0, has_relay: !!relayUrl })

  state.remoteTransport = new RemoteTransport({
    relayUrl,
    relayApiKey,
    lanPort: (settings.lanServerPort as number) || 19837,
    getPairedDevice: (deviceId: string) => {
      try {
        const s = readSettings()
        const devices = Array.isArray(s.pairedDevices) ? s.pairedDevices : []
        return devices.find((d: any) => d.id === deviceId) || null
      } catch { return null }
    },
    getAllPairedDevices: () => {
      try {
        const s = readSettings()
        return Array.isArray(s.pairedDevices) ? s.pairedDevices : []
      } catch { return [] }
    },
  })

  startTabSnapshotPolling()

  state.remoteTransport.on('peer-connected', () => {
    try {
      const s = readSettings()
      const devices = Array.isArray(s.pairedDevices) ? s.pairedDevices : []
      if (!devices.some((d: any) => d.sharedSecret)) {
        log('[Remote] peer connected but no paired device with shared secret -- skipping snapshot')
        return
      }
    } catch (err) {
      // A settings read failure here would silently skip the no-paired-device
      // guard and fall through to send a snapshot anyway. Log it.
      warn('[Remote] peer-connected settings read failed', { error: String(err) })
    }
    setTimeout(async () => {
      const { tabs, resourceManifest } = await getRemoteTabStates()

      try {
        const peerSettings = readSettings()
        const peerRecentDirs: string[] = Array.isArray(peerSettings.recentBaseDirectories) ? peerSettings.recentBaseDirectories : []
        const tabGroupMode = peerSettings.tabGroupMode || 'off'
        const tabGroups = Array.isArray(peerSettings.tabGroups) ? peerSettings.tabGroups.map((g: any) => ({ id: g.id, label: g.label, isDefault: g.isDefault, order: g.order })) : []
        state.remoteTransport?.send({
          type: 'desktop_snapshot',
          tabs,
          recentDirectories: peerRecentDirs,
          tabGroupMode,
          tabGroups,
          preferredModel: peerSettings.preferredModel || undefined,
          engineDefaultModel: peerSettings.engineDefaultModel || undefined,
          availableModels: modelCache.models.length > 0 ? modelCache.models : undefined,
          resources: Object.keys(resourceManifest).length > 0 ? resourceManifest : undefined,
        })
        const peerRelayUrl = (peerSettings.relayUrl as string) || ''
        const peerRelayApiKey = (peerSettings.relayApiKey as string) || ''
        if (peerRelayUrl) {
          state.remoteTransport?.send({ type: 'desktop_relay_config', relayUrl: peerRelayUrl, relayApiKey: peerRelayApiKey })
        }
        const profiles = Array.isArray(peerSettings.engineProfiles) ? peerSettings.engineProfiles : []
        state.remoteTransport?.send({ type: 'desktop_engine_profiles', profiles })
      } catch (err) {
        // A throw here means iOS silently never receives its snapshot on peer
        // connect — a view-readiness failure with no trace. Escalate to error.
        error('[Remote] auto-snapshot send failed', { error: String(err) })
      }

      // Start the git watcher bridge so tab directories get push-driven freshness
      const directories = new Set(tabs.map(t => t.workingDirectory).filter(Boolean))
      startGitWatcherBridge(directories)
    }, 300)
  })

  state.remoteTransport.on('command', handleRemoteCommand)

  state.remoteTransport.on('state-change', (transportState: string) => {
    broadcast(IPC.REMOTE_STATE_CHANGED, { transportState })
    // Keep the git focus gate aware of remote attention: a connected iOS
    // device depends on proactive watcher pushes, so the watcher must not
    // suspend just because the desktop window is backgrounded. See
    // git/focus-state.ts for the full rationale.
    focusState.setRemoteClientCount(state.remoteTransport?.getConnectedDeviceIds().length ?? 0)
  })

  state.remoteTransport.on('device-unpaired', (deviceId: string) => {
    log('remote_transport: device unpaired via close code', { device_id: deviceId })
    deviceFocusMap.delete(deviceId)
    revokeDeviceLocally(deviceId)
  })

  state.remoteTransport.on('pair-request', handlePairRequest)

  state.remoteTransport.start().catch((err) => {
    log('remote_transport: failed to start', { error: (err as Error).message })
  })

  startTerminalOutputFlushing()
}
