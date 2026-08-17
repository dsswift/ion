/**
 * Device registry operations for RemoteTransport, extracted from transport.ts
 * to keep it under the file-size cap. Follows the transport-lan-auth.ts /
 * transport-relay-wiring.ts pattern: an explicit ctx of narrow callbacks
 * instead of `this`, so the operations are unit-testable and the transport
 * class stays the single owner of its state.
 *
 * These are the add/remove/disconnect lifecycle verbs. Registration is the
 * point where a stored pairing secret first becomes a live key, so it is also
 * the point where an unusable secret must be refused — see device-secret.ts
 * for why a base64 decode is not sufficient validation.
 */

import { decodeSharedSecret, describeSecretFailure } from './device-secret'
import { LAN_CLOSE_UNKNOWN_DEVICE } from './protocol'
import { log as _log, error as _error } from '../logger'
import type { PairedDevice } from './protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RemoteTransport', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _error('RemoteTransport', msg, fields)
}

/** The slice of RemoteTransport the device registry operations need. */
export interface DeviceRegistryCtx {
  deviceSecrets: Map<string, Buffer>
  /** Push the current secret set to the crypto worker. MUST be called after
   *  any deviceSecrets mutation — the worker holds its own copy and frames
   *  fail to build ("no secret for device") for any device it doesn't know. */
  syncWorkerSecrets: () => void
  disconnectRelay: (deviceId: string) => void
  connectRelay: (device: PairedDevice) => void
  /** True when relay credentials are configured (URL + key or OIDC factory). */
  relayConfigured: () => boolean
  clearDeviceState: (deviceId: string) => void
  getLanConnectionForDevice: (deviceId: string) => string | null
  disconnectLanClient: (connectionId: string, code: number, reason: string) => void
  forgetLanConnection: (connectionId: string) => void
  recomputeState: () => void
}

/**
 * Register a newly paired device: install its secret and open its relay.
 *
 * Returns false when the stored secret is unusable. Registering it anyway
 * would install a wrong key that fails silently on every subsequent frame —
 * LAN auth would report "invalid proof" and payloads "decryption failed",
 * both of which point at the client rather than at this machine's secret
 * store. Refusing here makes the fault attributable where it occurs.
 */
export function addDevice(ctx: DeviceRegistryCtx, device: PairedDevice): boolean {
  log('transport: adding device', { device_id: device.id, device_name: device.name })

  const decoded = decodeSharedSecret(device.sharedSecret)
  if (!decoded.ok) {
    error('transport: refusing to add device with unusable pairing secret', {
      device_id: device.id,
      device_name: device.name,
      reason: decoded.reason,
      detail: describeSecretFailure(decoded.reason),
      decoded_bytes: decoded.byteLength,
    })
    return false
  }

  ctx.deviceSecrets.set(device.id, decoded.secret)
  ctx.syncWorkerSecrets()

  // Disconnect old relay if exists (channel may have changed on re-pair).
  ctx.disconnectRelay(device.id)

  if (ctx.relayConfigured()) {
    ctx.connectRelay(device)
  }
  return true
}

/** Remove a device. Disconnects relay and LAN client, clears all per-device state. */
export function removeDevice(ctx: DeviceRegistryCtx, deviceId: string): void {
  log('transport: removing device', { device_id: deviceId })
  ctx.disconnectRelay(deviceId)
  ctx.deviceSecrets.delete(deviceId)
  ctx.syncWorkerSecrets()
  ctx.clearDeviceState(deviceId)

  // Disconnect any LAN client for this device.
  const lanConnectionId = ctx.getLanConnectionForDevice(deviceId)
  if (lanConnectionId) {
    ctx.disconnectLanClient(lanConnectionId, LAN_CLOSE_UNKNOWN_DEVICE, 'device removed')
    ctx.forgetLanConnection(lanConnectionId)
  }

  ctx.recomputeState()
}

/** Forcibly disconnect a specific device by its deviceId. */
export function disconnectDevice(
  ctx: DeviceRegistryCtx,
  deviceId: string,
  code: number,
  reason: string,
): void {
  log('transport: disconnecting device', { device_id: deviceId, code, reason })
  const lanConnectionId = ctx.getLanConnectionForDevice(deviceId)
  if (lanConnectionId) {
    ctx.disconnectLanClient(lanConnectionId, code, reason)
    ctx.forgetLanConnection(lanConnectionId)
  }
  ctx.recomputeState()
}
