import { existsSync, readFileSync } from 'fs'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { state, pairingManager } from '../state'
import { broadcast } from '../broadcast'
import { SETTINGS_FILE, readSettings, writeSettings } from '../settings-store'
import { deriveChannelId, generateKeyPair, deriveSharedSecret } from './crypto'
import { getRemoteTabStates } from './snapshot'
import type { PairedDevice } from './protocol'

function log(msg: string): void {
  _log('main', msg)
}

export interface PairRequest {
  code: string
  publicKey: string
  deviceName: string
  recovery?: boolean
  respond: (response: Record<string, unknown>) => void
  reject: (message: string) => void
}

export function handlePairRequest(request: PairRequest): void {
  let relayUrl = ''
  let relayApiKey = ''
  let existingDevices: any[] = []
  try {
    if (existsSync(SETTINGS_FILE)) {
      const s = readSettings()
      relayUrl = s.relayUrl || ''
      relayApiKey = s.relayApiKey || ''
      existingDevices = Array.isArray(s.pairedDevices) ? s.pairedDevices : []
    }
  } catch {}

  const isRecovery = request.recovery &&
    existingDevices.some((d: any) => d.name === request.deviceName)

  let ourPublicKey: string
  let pairedDevice: {
    id: string; name: string; pairedAt: string; lastSeen: string | null
    channelId: string; sharedSecret: string
  }

  if (isRecovery) {
    log(`[Remote] recovery re-pair for known device: ${request.deviceName}`)
    const keyPair = generateKeyPair()
    const peerPubBuf = Buffer.from(request.publicKey, 'base64')
    const sharedSecret = deriveSharedSecret(keyPair.secretKey, peerPubBuf)
    const channelId = deriveChannelId(sharedSecret)

    ourPublicKey = keyPair.publicKey.toString('base64')
    pairedDevice = {
      id: channelId.substring(0, 16),
      name: request.deviceName,
      pairedAt: new Date().toISOString(),
      lastSeen: null,
      channelId,
      sharedSecret: sharedSecret.toString('base64'),
    }
  } else {
    const result = pairingManager.completePairing(
      request.code,
      request.publicKey,
      request.deviceName,
      undefined,
      { relayUrl, relayApiKey },
    )

    if (!result) {
      log(`Pairing rejected for ${request.deviceName}`)
      request.reject('Invalid pairing code')
      return
    }

    ourPublicKey = result.ourPublicKey
    pairedDevice = {
      id: result.device.id,
      name: result.device.name,
      pairedAt: result.device.pairedAt,
      lastSeen: result.device.lastSeen,
      channelId: result.device.channelId,
      sharedSecret: result.device.sharedSecret,
    }
  }

  log(`Pairing succeeded with ${request.deviceName}${isRecovery ? ' (recovery)' : ''}`)
  request.respond({
    type: 'pair_response',
    publicKey: ourPublicKey,
    relayUrl: relayUrl || undefined,
    relayApiKey: relayApiKey || undefined,
  })

  try {
    const settings = readSettings()
    const devices = Array.isArray(settings.pairedDevices) ? settings.pairedDevices : []
    const idx = devices.findIndex((d: any) => d.id === pairedDevice.id || d.name === pairedDevice.name)
    if (idx >= 0) devices[idx] = pairedDevice
    else devices.push(pairedDevice)
    settings.pairedDevices = devices
    writeSettings(settings)
  } catch (err) {
    log(`Failed to save paired device: ${(err as Error).message}`)
  }

  broadcast(IPC.REMOTE_DEVICE_PAIRED, pairedDevice)

  if (state.remoteTransport) {
    state.remoteTransport.addDevice(pairedDevice as PairedDevice)
  }

  setTimeout(async () => {
    const tabs = await getRemoteTabStates()
    const pairSettings = readSettings()
    const pairRecentDirs: string[] = Array.isArray(pairSettings.recentBaseDirectories) ? pairSettings.recentBaseDirectories : []
    state.remoteTransport?.send({ type: 'snapshot', tabs, recentDirectories: pairRecentDirs })
  }, 500)
}
