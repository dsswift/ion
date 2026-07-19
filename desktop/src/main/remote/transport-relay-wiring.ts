/**
 * Relay-client wiring for RemoteTransport, extracted from transport.ts
 * (_connectRelayForDevice body) to keep it under the file-size cap. Follows
 * the transport-lan-auth.ts pattern: an explicit ctx of narrow callbacks
 * instead of `this`, so the wiring is unit-testable and the transport class
 * stays the single owner of its state.
 */

import { RelayClient } from './relay-client'
import { log as _log } from '../logger'
import type { WireMessage, PairedDevice } from './protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RemoteTransport', msg, fields)
}

/** The slice of RemoteTransport the relay wiring needs. */
export interface RelayWiringCtx {
  relayUrl: string
  relayApiKey: string
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
  })

  relay.on('connected', () => {
    log('transport: relay connected', { device_id: device.id })
    ctx.recomputeState()
  })

  relay.on('disconnected', () => {
    log('transport: relay disconnected', { device_id: device.id })
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
