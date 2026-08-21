import { existsSync } from 'fs'
import { IPC } from '../../shared/types'
import { log as _log, warn as _warn } from '../logger'
import { state, pairingManager } from '../state'
import { broadcast } from '../broadcast'
import { SETTINGS_FILE, readSettings, writeSettings } from '../settings-store'
import { deriveChannelId, generateKeyPair, deriveSharedSecret } from './crypto'
import { sendSync } from './handlers/tabs-sync'
import type { PairedDevice } from './protocol'
import { getMachineIdentity } from '../machine-identity'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

export interface PairRequest {
  code: string
  publicKey: string
  deviceName: string
  recovery?: boolean
  mobileDeviceId?: string
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
  } catch (err) {
    // A settings read failure here silently proceeds with empty relayUrl and
    // existingDevices, breaking recovery detection (a genuine re-pair is then
    // treated as new). Log so pairing failures are diagnosable.
    warn('pairing: settings read failed', { error: String(err) })
  }

  const isRecovery = request.recovery &&
    existingDevices.some((d: any) =>
      (request.mobileDeviceId && d.mobileDeviceId)
        ? d.mobileDeviceId === request.mobileDeviceId
        : d.name === request.deviceName,
    )

  // A recovery re-pair carries no PIN (`code: ''`) by design — the desktop
  // already knows this phone by `mobileDeviceId`. When no record matches, the
  // request previously fell through to `completePairing('')`, which is wrong
  // in two ways: it reports "Incorrect pairing code" for a request that never
  // offered one, and — worse — each attempt increments the pairing session's
  // failed-attempt counter, so a phone retrying recovery in the background can
  // burn through MAX_FAILED_ATTEMPTS and cancel the PIN session the operator
  // is in the middle of using. Refuse it here, before the code check.
  if (request.recovery && !isRecovery) {
    log('pairing: recovery requested but no matching device record', {
      device_name: request.deviceName,
      mobile_device_id: request.mobileDeviceId,
      known_devices: existingDevices.length,
    })
    request.reject('No recovery record for this device; pair with a code')
    return
  }

  let ourPublicKey: string
  let pairedDevice: {
    id: string; name: string; pairedAt: string; lastSeen: string | null
    channelId: string; sharedSecret: string; mobileDeviceId?: string
  }

  if (isRecovery) {
    log('pairing: recovery re-pair for known device', {
      device_name: request.deviceName,
      mobile_device_id: request.mobileDeviceId,
    })
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
      mobileDeviceId: request.mobileDeviceId,
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
      log('pairing: rejected', { device_name: request.deviceName })
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
      mobileDeviceId: request.mobileDeviceId,
    }
  }

  const desktopId = getMachineIdentity()?.machineId
  log('pairing: succeeded', {
    device_name: request.deviceName,
    is_recovery: isRecovery,
    mobile_device_id: request.mobileDeviceId,
    desktop_id: desktopId,
  })
  request.respond({
    type: 'pair_response',
    publicKey: ourPublicKey,
    desktopId,
    relayUrl: relayUrl || undefined,
    relayApiKey: relayApiKey || undefined,
  })

  try {
    const settings = readSettings()
    const devices = Array.isArray(settings.pairedDevices) ? settings.pairedDevices : []
    const idx = devices.findIndex((d: any) =>
      d.id === pairedDevice.id ||
      (pairedDevice.mobileDeviceId && d.mobileDeviceId && d.mobileDeviceId === pairedDevice.mobileDeviceId) ||
      d.name === pairedDevice.name,
    )
    if (idx >= 0) devices[idx] = pairedDevice
    else devices.push(pairedDevice)
    settings.pairedDevices = devices
    writeSettings(settings)
  } catch (err) {
    log('pairing: failed to save paired device', { error: (err as Error).message })
  }

  broadcast(IPC.REMOTE_DEVICE_PAIRED, pairedDevice)

  if (state.remoteTransport) {
    // When a re-pair changes the channelId (new ECDH keys), the old device.id
    // no longer matches the new one. addDevice only disconnects relays keyed by
    // the NEW id, so the old relay client would be orphaned. Find the
    // superseded entry and remove it before adding the replacement.
    const supersededId = existingDevices.find((d: any) =>
      d.id !== pairedDevice.id && (
        (pairedDevice.mobileDeviceId && d.mobileDeviceId && d.mobileDeviceId === pairedDevice.mobileDeviceId) ||
        d.name === pairedDevice.name
      ),
    )?.id as string | undefined
    if (supersededId) {
      log('pairing: removing superseded device relay', {
        old_id: supersededId,
        new_id: pairedDevice.id,
      })
      state.remoteTransport.removeDevice(supersededId)
    }
    state.remoteTransport.addDevice(pairedDevice as PairedDevice)
  }

  setTimeout(() => {
    void (async () => {
      const deviceIds = state.remoteTransport?.getConnectedDeviceIds() ?? []
      await sendSync((event) => state.remoteTransport?.send(event), deviceIds)
    })().catch((err) => warn('pairing: post-pair snapshot send failed', { error: String(err) }))
  }, 500)
}
