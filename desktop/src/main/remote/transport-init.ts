import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { state } from '../state'
import { broadcast, startTerminalOutputFlushing } from '../broadcast'
import { readSettings } from '../settings-store'
import { RemoteTransport } from './transport'
import { handleRemoteCommand } from './command-handler'
import { handlePairRequest } from './pairing-handler'
import { revokeDeviceLocally } from './revoke'
import { startTabSnapshotPolling, stopTabSnapshotPolling } from './snapshot-polling'
import { getRemoteTabStates } from './snapshot'

function log(msg: string): void {
  _log('main', msg)
}

export function initRemoteTransport(settings: Record<string, unknown>): void {
  log(`[Remote] initRemoteTransport called: remoteEnabled=${settings.remoteEnabled} relayUrl=${settings.relayUrl}`)

  if (state.remoteTransport) {
    stopTabSnapshotPolling()
    state.remoteTransport.stop()
    state.remoteTransport = null
  }

  if (!settings.remoteEnabled) {
    log('[Remote] remote not enabled, skipping')
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
      const tabs = await getRemoteTabStates()

      try {
        const peerSettings = readSettings()
        const peerRecentDirs: string[] = Array.isArray(peerSettings.recentBaseDirectories) ? peerSettings.recentBaseDirectories : []
        state.remoteTransport?.send({ type: 'snapshot', tabs, recentDirectories: peerRecentDirs })
        const peerRelayUrl = (peerSettings.relayUrl as string) || ''
        const peerRelayApiKey = (peerSettings.relayApiKey as string) || ''
        if (peerRelayUrl) {
          state.remoteTransport?.send({ type: 'relay_config', relayUrl: peerRelayUrl, relayApiKey: peerRelayApiKey })
        }
        const profiles = Array.isArray(peerSettings.engineProfiles) ? peerSettings.engineProfiles : []
        state.remoteTransport?.send({ type: 'engine_profiles', profiles })
      } catch {}
    }, 300)
  })

  state.remoteTransport.on('command', handleRemoteCommand)

  state.remoteTransport.on('state-change', (transportState: string) => {
    broadcast(IPC.REMOTE_STATE_CHANGED, { transportState })
  })

  state.remoteTransport.on('device-unpaired', (deviceId: string) => {
    log(`[Remote] device ${deviceId} unpaired via close code`)
    revokeDeviceLocally(deviceId)
  })

  state.remoteTransport.on('pair-request', handlePairRequest)

  state.remoteTransport.start().catch((err) => {
    log(`Remote transport failed to start: ${(err as Error).message}`)
  })

  startTerminalOutputFlushing()
}
