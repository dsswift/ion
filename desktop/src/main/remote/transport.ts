/**
 * RemoteTransport: abstraction over LAN and relay connections.
 *
 * Manages the preference state machine:
 *   disconnected → relay_only → lan_preferred → relay_only (on LAN loss)
 *
 * Supports multiple paired devices simultaneously. Each device gets its own
 * relay connection and can connect via LAN independently. Events are broadcast
 * to all connected devices.
 */

import { EventEmitter } from 'events'
import { RelayClient } from './relay-client'
import { LANServer } from './lan-server'
import { decrypt } from './crypto'
import { compressPayload, decompressPayload } from './transport-compression'
import { mark, Activity } from '../watchdog'
import { startLanAuth, handleLanAuthResponse, type LanAuthCtx } from './transport-lan-auth'
import { log as _log } from '../logger'
import { RetransmitBuffer, replayRange } from './retransmit-buffer'
import { InboundDedup } from './transport-dedup'
import { buildDeviceFrame } from './transport-frame'
import { enqueueSend, drainSendQueue, MAX_PLAINTEXT_BYTES, type SendCtx, type SendQueueItem } from './transport-send'
import type {
  TransportState,
  WireMessage,
  RemoteEvent,
  RemoteCommand,
  PairedDevice,
} from './protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RemoteTransport', msg, fields)
}

export interface RemoteTransportConfig {
  relayUrl: string
  relayApiKey: string
  lanPort: number
  /** Callback to look up a paired device by ID. */
  getPairedDevice?: (deviceId: string) => PairedDevice | null
  /** Callback to get all paired devices. */
  getAllPairedDevices?: () => PairedDevice[]
}

/**
 * Events:
 *  - 'command' (cmd: RemoteCommand, deviceId: string) -- incoming command from iOS
 *  - 'state-change' (state: TransportState) -- transport state changed
 *  - 'peer-connected' -- iOS client connected (via any transport)
 *  - 'peer-disconnected' -- iOS client disconnected from all transports
 *  - 'push-failed' ({ reason, resourceId, deviceId }) -- relay reports APNs push failure
 *  - 'device-unpaired' (deviceId: string) -- iOS client sent unpair close code
 *  - 'pair-request' -- pairing request from LAN
 */
export class RemoteTransport extends EventEmitter {
  private relays: Map<string, RelayClient> = new Map()    // deviceId -> relay
  private deviceSecrets: Map<string, Buffer> = new Map()   // deviceId -> shared secret
  // Windowed inbound dedup (per device). Replaced the strict "drop anything
  // <= last seq" high-water mark, which silently ate real out-of-order
  // commands from iOS's concurrent senders. See transport-dedup.ts.
  private dedup = new InboundDedup()
  // Per-device retransmit buffer: keeps recently-sent encrypted frames so a
  // forward-seq-gap from iOS (a frame lost during a transport switch) can be
  // recovered by replaying the originals instead of waiting for the snapshot
  // reconcile. See retransmit-buffer.ts and resend().
  private retransmit = new RetransmitBuffer()
  private lan: LANServer | null = null
  private _state: TransportState = 'disconnected'
  private config: RemoteTransportConfig
  // Per-device outbound seq counters. Each paired device gets its own
  // contiguous 1,2,3,... stream; a single shared counter made every device see
  // a strided subsequence (stride ≈ paired-device count), so iOS gap detection
  // fired on nearly every frame and the resulting desktop_request_resend could
  // never be satisfied (the retransmit buffer is per-device and never held the
  // other devices' seqs) — a permanent resend/resend_unavailable storm.
  private seqs = new Map<string, number>()
  // Outbound-seq epoch (generation id) stamped on every frame. Generated once
  // per RemoteTransport instance, so a desktop process restart (new instance) or
  // an in-process stop()+recreate produces a NEW epoch while the per-device seqs
  // reset to 1. iOS keys its receive dedup high-water to this: an epoch change
  // means "the seq space restarted, drop your high-water" — the deterministic
  // fix for stale/backward-seq frames after a desktop restart (the retransmit
  // buffer is empty post-restart, so a resend request can't heal that gap). A
  // timestamp seed is monotonic across restarts and collision-free in practice.
  private readonly epoch: number = Date.now()
  private static readonly HEARTBEAT_INTERVAL_MS = 15_000
  // Backpressure cap, critical-type set, and the send-queue path itself live in
  // transport-send.ts (extracted for the file-size cap and to make the drain
  // logic unit-testable). sendQueue is mutated in place by those helpers.
  private sendQueue: SendQueueItem[] = []
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  // LAN auth tracking per pending connection
  private lanAuthPending: Map<string, { nonce: string; timeout: ReturnType<typeof setTimeout> }> = new Map()
  // connectionId -> deviceId mapping for authenticated LAN clients
  private lanDeviceMap: Map<string, string> = new Map()

  // Stable context handed to the extracted send-queue helpers. Built once: the
  // Maps and buffer are stable references and sendQueue is mutated in place, so
  // the helpers see live state through it. nextSeq / deliverFrame close over
  // `this` so the seq counters and per-device delivery stay on the instance.
  private readonly _sendCtx: SendCtx = {
    sendQueue: this.sendQueue,
    deviceSecrets: this.deviceSecrets,
    retransmit: this.retransmit,
    nextSeq: (deviceId) => this._nextSeqFor(deviceId),
    deliverFrame: (deviceId, frame) => this._deliverFrame(deviceId, frame),
    epoch: this.epoch,
  }

  /** Allocate the next outbound seq for one device (per-device counters). */
  private _nextSeqFor(deviceId: string): number {
    const next = (this.seqs.get(deviceId) ?? 0) + 1
    this.seqs.set(deviceId, next)
    return next
  }

  constructor(config: RemoteTransportConfig) {
    super()
    this.config = config
  }

  get state(): TransportState {
    return this._state
  }

  async start(): Promise<void> {
    // Start relay connections for all paired devices.
    if (this.config.relayUrl && this.config.relayApiKey) {
      const devices = this.config.getAllPairedDevices?.() || []
      for (const device of devices) {
        this._connectRelayForDevice(device)
      }
    }

    // Always start LAN server for pairing and direct connections.
    await this._startLan()
  }

  /** Temporarily disable or re-enable the LAN server (debug toggle, not persisted). */
  async setLanDisabled(disabled: boolean): Promise<void> {
    if (disabled) {
      if (this.lan) {
        log('LAN disabled (debug toggle)')
        await this.lan.stop()
        this.lan = null
        this.lanAuthPending.clear()
        this.lanDeviceMap.clear()
        this._recomputeState()
      }
    } else {
      if (!this.lan) {
        log('LAN re-enabled (debug toggle)')
        await this._startLan()
      }
    }
  }

  private async _startLan(): Promise<void> {
    log('transport: lan config', { port: this.config.lanPort })
    this.lan = new LANServer({ port: this.config.lanPort })

    // Raw connection: start auth handshake before emitting peer-connected.
    this.lan.on('raw-client-connected', (_ws: any, connectionId: string) => {
      log('transport: lan raw client connected, auth handshake', { connection_id: connectionId })
      this._startLanAuth(connectionId)
    })

    this.lan.on('client-disconnected', (connectionId: string, code: number, _reason: string) => {
      const deviceId = this.lanDeviceMap.get(connectionId)
      this.lanDeviceMap.delete(connectionId)
      if (deviceId) {
        for (const [key, val] of this.lanDeviceMap) {
          if (val === deviceId) this.lanDeviceMap.delete(key)
        }
      }

      // Clean up any pending auth for this connection.
      const pending = this.lanAuthPending.get(connectionId)
      if (pending) {
        clearTimeout(pending.timeout)
        this.lanAuthPending.delete(connectionId)
      }

      this._recomputeState()

      // Close code 4000 = iOS-initiated unpair.
      if (code === 4000 && deviceId) {
        log('transport: device sent unpair close code', { device_id: deviceId })
        this.emit('device-unpaired', deviceId)
      }

      // Emit peer-disconnected if no connections remain for this device.
      if (deviceId && !this._isDeviceConnected(deviceId)) {
        this.emit('peer-disconnected')
      }
    })

    this.lan.on('message', (msg: WireMessage, connectionId: string) => {
      // If not yet authenticated, only accept auth_response messages.
      const deviceId = this.lanDeviceMap.get(connectionId)
      if (!deviceId) {
        this._handleLanAuthResponse(msg, connectionId)
        return
      }
      this._handleIncoming(msg, deviceId)
    })

    this.lan.on('pair-request', (request: any) => {
      this.emit('pair-request', request)
    })

    try {
      await this.lan.start()
    } catch (err) {
      log('transport: lan server failed to start', { error: (err as Error).message })
    }
  }

  /** Create a relay connection for a specific paired device. */
  private _connectRelayForDevice(device: PairedDevice): void {
    if (this.relays.has(device.id)) {
      log('transport: relay already exists, skipping', { device_id: device.id })
      return
    }

    const secret = Buffer.from(device.sharedSecret, 'base64')
    this.deviceSecrets.set(device.id, secret)

    const relay = new RelayClient({
      relayUrl: this.config.relayUrl,
      apiKey: this.config.relayApiKey,
      channelId: device.channelId,
    })

    relay.on('connected', () => {
      log('transport: relay connected', { device_id: device.id })
      this._recomputeState()
    })

    relay.on('disconnected', () => {
      log('transport: relay disconnected', { device_id: device.id })
      this._recomputeState()
    })

    relay.on('message', (msg: WireMessage) => {
      // Route inbound relay data straight to _handleIncoming, even when a LAN
      // entry exists for this device. lanDeviceMap is only cleaned on
      // 'client-disconnected', so gating on it let a half-open (zombie) LAN
      // socket blackhole every inbound relay command. iOS never sends the same
      // frame over both transports in normal operation, and the windowed dedup
      // in _handleIncoming drops any genuine duplicate.
      this._handleIncoming(msg, device.id)
    })

    relay.on('control', (ctrl) => {
      if (ctrl.type === 'relay:peer-reconnected') {
        // New inbound-seq epoch: reset the high-water mark AND the seen-set so
        // the reconnected peer's seq=1 isn't dropped against the previous
        // session's state.
        this.dedup.reset(device.id)
        this.emit('peer-connected')
      } else if (ctrl.type === 'relay:peer-disconnected') {
        // Only emit if this device has no LAN connection either.
        if (!this._getLanConnectionForDevice(device.id)) {
          this.emit('peer-disconnected')
        }
      } else if (ctrl.type === 'relay:push-failed') {
        log('transport: push-failed', { device_id: device.id, reason: ctrl.reason ?? '', resource_id: ctrl.resourceId ?? '' })
        this.emit('push-failed', { reason: ctrl.reason, resourceId: ctrl.resourceId, deviceId: device.id })
      }
    })

    this.relays.set(device.id, relay)
    relay.connect()
  }

  /** Send a remote event to all connected iOS devices via their preferred transport. */
  send(event: RemoteEvent, push = false, pushMeta?: { title?: string; body?: string }): void {
    enqueueSend(this._sendCtx, event, push, pushMeta)
  }

  /** Drain the send queue. Kept as a thin method so internal callers (reconnect
   * flush, state transitions) read as before; the logic lives in transport-send.ts. */
  private _drainQueue(): void {
    drainSendQueue(this._sendCtx)
  }

  async stop(): Promise<void> {
    this._stopHeartbeat()

    for (const [, relay] of this.relays) {
      relay.disconnect()
    }
    this.relays.clear()
    this.deviceSecrets.clear()
    this.dedup.clear()
    this.seqs.clear()

    if (this.lan) {
      await this.lan.stop()
      this.lan = null
    }

    this.lanAuthPending.clear()
    this.lanDeviceMap.clear()
    this._setState('disconnected')
  }

  /** Update relay URL/API key. Reconnects all relay clients. */
  updateConfig(config: Partial<RemoteTransportConfig>): void {
    const relayChanged = config.relayUrl !== undefined || config.relayApiKey !== undefined
    Object.assign(this.config, config)

    if (relayChanged) {
      // Reconnect all relays with new credentials.
      for (const [deviceId, relay] of this.relays) {
        const device = this.config.getPairedDevice?.(deviceId)
        if (!device) {
          relay.disconnect()
          this.relays.delete(deviceId)
          continue
        }
        relay.updateOptions({
          relayUrl: this.config.relayUrl,
          apiKey: this.config.relayApiKey,
          channelId: device.channelId,
        })
        relay.disconnect()
        relay.connect()
      }
    }
  }

  /** Add a newly paired device. Creates relay connection and stores secret. */
  addDevice(device: PairedDevice): void {
    log('transport: adding device', { device_id: device.id, device_name: device.name })
    const secret = Buffer.from(device.sharedSecret, 'base64')
    this.deviceSecrets.set(device.id, secret)

    // Disconnect old relay if exists (channel may have changed on re-pair).
    const oldRelay = this.relays.get(device.id)
    if (oldRelay) {
      oldRelay.disconnect()
      this.relays.delete(device.id)
    }

    if (this.config.relayUrl && this.config.relayApiKey) {
      this._connectRelayForDevice(device)
    }
  }

  /** Remove a device. Disconnects relay and LAN client. */
  removeDevice(deviceId: string): void {
    log('transport: removing device', { device_id: deviceId })
    const relay = this.relays.get(deviceId)
    if (relay) {
      relay.disconnect()
      this.relays.delete(deviceId)
    }
    this.deviceSecrets.delete(deviceId)
    this.dedup.remove(deviceId)
    this.seqs.delete(deviceId)

    // Disconnect any LAN client for this device.
    const lanConnectionId = this._getLanConnectionForDevice(deviceId)
    if (lanConnectionId) {
      this.lan?.disconnectClient(lanConnectionId, 4003, 'device removed')
      this.lanDeviceMap.delete(lanConnectionId)
    }

    this._recomputeState()
  }

  /** Forcibly disconnect a specific device by its deviceId. */
  disconnectDevice(deviceId: string, code = 4003, reason = 'device revoked'): void {
    log('transport: disconnecting device', { device_id: deviceId, code, reason })
    // Disconnect LAN client for this device.
    const lanConnectionId = this._getLanConnectionForDevice(deviceId)
    if (lanConnectionId) {
      this.lan?.disconnectClient(lanConnectionId, code, reason)
      this.lanDeviceMap.delete(lanConnectionId)
    }
    this._recomputeState()
  }

  /** Return device IDs of all currently connected devices. */
  getConnectedDeviceIds(): string[] {
    return [...this.deviceSecrets.keys()].filter(id => this._isDeviceConnected(id))
  }

  /** Send to a specific device only (e.g. unpair notification). */
  sendToDevice(deviceId: string, event: RemoteEvent, push = false): void {
    const secret = this.deviceSecrets.get(deviceId)
    if (!secret) return
    // sendToDevice is direct (no queue) so enqueuedAt = sendTs → dwell = 0.
    const plaintext = JSON.stringify(event)
    // Same oversized-payload safety valve as the broadcast path (sendToAll).
    if (plaintext.length > MAX_PLAINTEXT_BYTES) {
      log('transport: dropping oversized event before sendToDevice', { event_type: event.type, chars: plaintext.length, cap: MAX_PLAINTEXT_BYTES })
      return
    }
    mark(Activity.RelayCompress)
    const wire = compressPayload(plaintext)
    const msg = buildDeviceFrame(deviceId, secret, plaintext, wire, event.type, (d) => this._nextSeqFor(d), push, undefined, undefined, Date.now(), this.epoch)
    if (!msg) return
    this.retransmit.record(deviceId, msg)
    this._deliverFrame(deviceId, msg)
  }

  /**
   * Replay buffered frames for `[fromSeq, toSeq]` in response to an iOS
   * `desktop_request_resend` (it detected a forward seq gap). Frames still in
   * the buffer are re-sent byte-identically (original seq preserved so iOS fills
   * the gap); an evicted range yields `desktop_resend_unavailable` so iOS heals
   * via the snapshot reconcile instead. See retransmit-buffer.ts.
   */
  resend(deviceId: string, fromSeq: number, toSeq: number): void {
    const complete = replayRange(this.retransmit, deviceId, fromSeq, toSeq,
      (frame) => this._deliverFrame(deviceId, frame))
    log('transport: resend', { device_id: deviceId, from_seq: fromSeq, to_seq: toSeq, complete })
    if (!complete) {
      this.sendToDevice(deviceId, { type: 'desktop_resend_unavailable', fromSeq })
    }
  }

  /** Deliver a pre-built (seq-stamped, encrypted) frame to a device over its
   *  preferred transport (LAN if connected, else relay). Returns true if it was
   *  handed to a transport. Shared by _sendToAll, sendToDevice, and resend. */
  private _deliverFrame(deviceId: string, frame: WireMessage): boolean {
    const lanConnectionId = this._getLanConnectionForDevice(deviceId)
    if (lanConnectionId && this.lan?.hasClient(lanConnectionId)) {
      this.lan.send(frame, lanConnectionId)
      return true
    }
    const relay = this.relays.get(deviceId)
    if (relay?.connected) {
      relay.send(frame)
      return true
    }
    return false
  }

  private _handleIncoming(msg: WireMessage, deviceId: string): void {
    // Windowed reorder-tolerant dedup (per device): drops genuine duplicates
    // and window-expired stale frames, accepts distinct out-of-order seqs.
    // Gap detection and drop logging live in transport-dedup.ts.
    if (!this.dedup.shouldAccept(deviceId, msg.seq)) return

    // Centralized decryption using per-device secret.
    const secret = this.deviceSecrets.get(deviceId)
    let payload: string | undefined
    if (secret && msg.nonce && msg.ciphertext) {
      const decrypted = decrypt(msg.nonce, msg.ciphertext, secret)
      if (decrypted === null) {
        log('transport: decryption failed', { seq: msg.seq, device_id: deviceId })
        return
      }
      // Check version prefix: 0x01 = deflate-compressed payload.
      // iOS does not currently send compressed payloads, but this
      // handles the case symmetrically for forward compatibility.
      try {
        payload = decompressPayload(decrypted)
      } catch (err) {
        log('transport: decompression failed', { seq: msg.seq, device_id: deviceId, error: (err as Error).message })
        return
      }
    } else if (secret && msg.payload) {
      // Shared secret is set but message is plaintext -- reject it.
      log('transport: rejecting plaintext', { seq: msg.seq, device_id: deviceId })
      return
    } else {
      payload = msg.payload
    }

    if (!payload) {
      log('transport: no payload in message', { seq: msg.seq, device_id: deviceId })
      return
    }

    try {
      const cmd = JSON.parse(payload) as RemoteCommand
      this.emit('command', cmd, deviceId)
    } catch (err) {
      log('transport: incoming parse error', { error: (err as Error).message })
    }
  }

  private _startHeartbeat(): void {
    this._stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      // Heartbeats go per device so the payload `seq` is that device's own
      // outbound counter (a single broadcast payload carried one global seq,
      // which was meaningless under per-device counters). iOS currently reads
      // only ts/buffered from heartbeats, but the seq must still be truthful.
      const ts = Date.now()
      const buffered = this.sendQueue.length
      for (const deviceId of this.deviceSecrets.keys()) {
        this.sendToDevice(deviceId, { type: 'desktop_heartbeat', seq: this.seqs.get(deviceId) ?? 0, ts, buffered })
      }
    }, RemoteTransport.HEARTBEAT_INTERVAL_MS)
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** Recompute transport state based on all connections. */
  private _recomputeState(): void {
    let newState: TransportState = 'disconnected'

    // Any authenticated LAN client means lan_preferred.
    if (this.lanDeviceMap.size > 0) {
      newState = 'lan_preferred'
    } else {
      // Any connected relay means relay_only.
      for (const [, relay] of this.relays) {
        if (relay.connected) {
          newState = 'relay_only'
          break
        }
      }
    }

    this._setState(newState)
  }

  private _setState(state: TransportState): void {
    if (this._state === state) return
    const old = this._state
    this._state = state
    log('transport: state transition', { from: old, to: state })
    this.emit('state-change', state)

    if (state !== 'disconnected') {
      this._startHeartbeat()
      this._drainQueue()
    } else {
      this._stopHeartbeat()
    }
  }

  /** Check if a device has any active connection (relay or LAN). */
  private _isDeviceConnected(deviceId: string): boolean {
    const relay = this.relays.get(deviceId)
    if (relay?.connected) return true
    if (this._getLanConnectionForDevice(deviceId)) return true
    return false
  }

  /** Get the LAN connectionId for a device, if it has an authenticated LAN connection. */
  private _getLanConnectionForDevice(deviceId: string): string | null {
    // After auth, rekeyClient() moves the WebSocket from "lan-N" to device.id
    // in LANServer.clients. Prefer device.id directly so send() finds the socket.
    if (this.lanDeviceMap.has(deviceId)) return deviceId
    for (const [connectionId, devId] of this.lanDeviceMap) {
      if (devId === deviceId) return connectionId
    }
    return null
  }

  private _lanAuthCtx(): LanAuthCtx {
    return {
      lan: this.lan,
      lanAuthPending: this.lanAuthPending,
      lanDeviceMap: this.lanDeviceMap,
      deviceSecrets: this.deviceSecrets,
      resetInboundSeq: (deviceId) => this.dedup.reset(deviceId),
      getPairedDevice: (id) => this.config.getPairedDevice?.(id) || null,
      recomputeState: () => this._recomputeState(),
      emit: (event, ...args) => { this.emit(event, ...args) },
    }
  }

  private _startLanAuth(connectionId: string): void {
    startLanAuth(this._lanAuthCtx(), connectionId)
  }

  private _handleLanAuthResponse(msg: WireMessage, connectionId: string): void {
    handleLanAuthResponse(this._lanAuthCtx(), msg, connectionId)
  }
}
