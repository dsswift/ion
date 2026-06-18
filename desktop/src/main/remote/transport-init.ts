import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
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

function log(msg: string): void {
  _log('main', msg)
}

export function initRemoteTransport(settings: Record<string, unknown>): void {
  log(`[Remote] initRemoteTransport called: remoteEnabled=${settings.remoteEnabled} relayUrl=${settings.relayUrl}`)

  if (state.remoteTransport) {
    stopTabSnapshotPolling()
    stopGitWatcherBridge()
    state.remoteTransport.stop()
    state.remoteTransport = null
  }

  if (!settings.remoteEnabled) {
    log('[Remote] remote not enabled, skipping')
    stopTerminalOutputFlushing()
    return
  }

  const relayUrl = (settings.relayUrl as string) || ''
  const relayApiKey = (settings.relayApiKey as string) || ''

  const pairedDevices = settings.pairedDevices as any[] | undefined
  log(`[Remote] pairedDevices=${pairedDevices?.length || 0} relay=${!!relayUrl}`)

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
    } catch {}

    log('[Remote] peer connected, sending auto-snapshot')
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
      } catch {}

      // Start the git watcher bridge so tab directories get push-driven freshness
      const directories = new Set(tabs.map(t => t.workingDirectory).filter(Boolean))
      startGitWatcherBridge(directories)
    }, 300)
  })

  state.remoteTransport.on('command', handleRemoteCommand)

  state.remoteTransport.on('state-change', (transportState: string) => {
    broadcast(IPC.REMOTE_STATE_CHANGED, { transportState })
  })

  state.remoteTransport.on('device-unpaired', (deviceId: string) => {
    log(`[Remote] device ${deviceId} unpaired via close code`)
    deviceFocusMap.delete(deviceId)
    revokeDeviceLocally(deviceId)
  })

  state.remoteTransport.on('pair-request', handlePairRequest)

  state.remoteTransport.start().catch((err) => {
    log(`Remote transport failed to start: ${(err as Error).message}`)
  })

  startTerminalOutputFlushing()
}
