/**
 * Relay-client wiring for RemoteTransport, extracted from transport.ts
 * (_connectRelayForDevice body) to keep it under the file-size cap. Follows
 * the transport-lan-auth.ts pattern: an explicit ctx of narrow callbacks
 * instead of `this`, so the wiring is unit-testable and the transport class
 * stays the single owner of its state.
 */

import { RelayClient } from './relay-client'
import { log as _log, warn as _warn } from '../logger'
import type { WireMessage, PairedDevice } from './protocol'
import type { RelayFailure } from './relay-failure'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RemoteTransport', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('RemoteTransport', msg, fields)
}

/** The slice of RemoteTransport the relay wiring needs. */
export interface RelayWiringCtx {
  relayUrl: string
  relayApiKey: string
  /**
   * OIDC credential factory. When set, the relay client calls this before each
   * connect attempt to mint a fresh bearer token instead of using relayApiKey.
   */
  getCredential?: () => Promise<string>
  relays: Map<string, RelayClient>
  setDeviceSecret: (deviceId: string, secret: Buffer) => void
  handleIncoming: (msg: WireMessage, deviceId: string) => void
  recomputeState: () => void
  hasLanConnection: (deviceId: string) => boolean
  emit: (event: string, ...args: unknown[]) => void
}

/** Create, wire, register, and connect a RelayClient for one paired device. */
export function connectRelayForDevice(ctx: RelayWiringCtx, device: PairedDevice): void {
  if (ctx.relays.has(device.id)) {
    log('transport: relay already exists, skipping', { device_id: device.id })
    return
  }

  ctx.setDeviceSecret(device.id, Buffer.from(device.sharedSecret, 'base64'))

  const relay = new RelayClient({
    relayUrl: ctx.relayUrl,
    apiKey: ctx.relayApiKey,
    channelId: device.channelId,
    getCredential: ctx.getCredential,
  })

  relay.on('connected', () => {
    log('transport: relay connected', { device_id: device.id })
    ctx.recomputeState()
  })

  relay.on('disconnected', () => {
    log('transport: relay disconnected', { device_id: device.id })
    ctx.recomputeState()
  })

  // A permanent failure has stopped retrying. Recompute so the UI shows a
  // reason instead of a spinner that will never resolve — the whole point of
  // classifying is that the operator learns what to fix.
  relay.on('failed', (failure: RelayFailure) => {
    warn('transport: relay failed permanently, not retrying', {
      device_id: device.id, reason: failure.reason, detail: failure.detail,
    })
    ctx.recomputeState()
  })

  relay.on('message', (msg: WireMessage) => {
    // Route inbound relay data straight to _handleIncoming, even when a LAN
    // entry exists for this device. lanDeviceMap is only cleaned on
    // 'client-disconnected', so gating on it let a half-open (zombie) LAN
    // socket blackhole every inbound relay command. iOS never sends the same
    // frame over both transports in normal operation, and the windowed dedup
    // in _handleIncoming drops any genuine duplicate.
    ctx.handleIncoming(msg, device.id)
  })

  relay.on('control', (ctrl) => {
    if (ctrl.type === 'relay:peer-reconnected') {
      // No dedup reset here. iOS's outbound seq is continuous for the life
      // of its TransportManager instance, so a relay-level peer reconnect
      // does NOT imply a new seq space — resetting here let one late
      // high-seq frame from the old socket re-poison the mark. If iOS
      // actually rebuilt its transport, its next frame carries a NEWER
      // epoch and _handleIncoming resets the dedup on that signal — the
      // epoch is the only reset trigger.
      ctx.emit('peer-connected')
    } else if (ctrl.type === 'relay:peer-disconnected') {
      // Only emit if this device has no LAN connection either.
      if (!ctx.hasLanConnection(device.id)) {
        ctx.emit('peer-disconnected')
      }
    } else if (ctrl.type === 'relay:push-failed') {
      log('transport: push-failed', { device_id: device.id, reason: ctrl.reason ?? '', resource_id: ctrl.resourceId ?? '' })
      ctx.emit('push-failed', { reason: ctrl.reason, resourceId: ctrl.resourceId, deviceId: device.id })
    }
  })

  ctx.relays.set(device.id, relay)
  relay.connect()
}

/** The slice of RemoteTransport that updateConfig's relay reconciliation needs. */
export interface RelayReconcileCtx {
  relayUrl: string
  relayApiKey: string
  getCredential?: () => Promise<string>
  relays: Map<string, RelayClient>
  getPairedDevice: (deviceId: string) => PairedDevice | null
  getAllPairedDevices: () => PairedDevice[]
  connectRelayForDevice: (device: PairedDevice) => void
}

/**
 * Reconcile relay connections after a config change: update credentials on
 * existing connections, drop connections for unpaired devices, and CREATE
 * connections for paired devices that have none.
 *
 * The create step is load-bearing for OIDC bootstrap: start() skips relay
 * creation entirely when it runs without a usable credential (relayApiKey
 * empty, getCredential not yet set because the relay auth-config probe is
 * async). The probe then hot-swaps the credential via updateConfig; before
 * this reconciliation created missing connections, the hot-swap updated ZERO
 * relays and the desktop stayed LAN-only until the next full restart —
 * mobile clients authenticated to the relay channel and found no peer.
 */
export function reconcileRelayConnections(ctx: RelayReconcileCtx): void {
  // Update or drop existing connections.
  for (const [deviceId, relay] of ctx.relays) {
    const device = ctx.getPairedDevice(deviceId)
    if (!device) {
      relay.disconnect()
      ctx.relays.delete(deviceId)
      continue
    }
    relay.updateOptions({
      relayUrl: ctx.relayUrl,
      apiKey: ctx.relayApiKey,
      getCredential: ctx.getCredential,
      channelId: device.channelId,
    })
    relay.disconnect()
    relay.connect()
  }

  // Create connections for paired devices that don't have one yet.
  if (ctx.relayUrl && (ctx.relayApiKey || ctx.getCredential)) {
    for (const device of ctx.getAllPairedDevices()) {
      if (!ctx.relays.has(device.id)) {
        log('transport: creating missing relay connection after config update', { device_id: device.id })
        ctx.connectRelayForDevice(device)
      }
    }
  }
}
