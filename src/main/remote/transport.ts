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
import { RelayClient, type RelayClientOptions } from './relay-client'
import { LANServer, type LANServerOptions } from './lan-server'
import { encrypt, decrypt, createAuthNonce, verifyAuthProof } from './crypto'
import { log as _log } from '../logger'
import type {
  TransportState,
  WireMessage,
  RemoteEvent,
  RemoteCommand,
  AuthChallenge,
  AuthResponse,
  AuthResult,
  PairedDevice,
} from './protocol'

function log(msg: string): void {
  _log('RemoteTransport', msg)
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
 *  - 'device-unpaired' (deviceId: string) -- iOS client sent unpair close code
 *  - 'pair-request' -- pairing request from LAN
 */
export class RemoteTransport extends EventEmitter {
  private relays: Map<string, RelayClient> = new Map()    // deviceId -> relay
  private deviceSecrets: Map<string, Buffer> = new Map()   // deviceId -> shared secret
  private lastReceivedSeq: Map<string, number> = new Map() // deviceId -> last seq
  private lan: LANServer | null = null
  private _state: TransportState = 'disconnected'
  private config: RemoteTransportConfig
  private seq = 0
  private static readonly MAX_QUEUE_SIZE = 500
  private static readonly HEARTBEAT_INTERVAL_MS = 15_000
  private sendQueue: Array<{ event: RemoteEvent; push: boolean }> = []
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  // LAN auth tracking per pending connection
  private lanAuthPending: Map<string, { nonce: string; timeout: ReturnType<typeof setTimeout> }> = new Map()
  // connectionId -> deviceId mapping for authenticated LAN clients
  private lanDeviceMap: Map<string, string> = new Map()

  // Critical event types that must never be dropped
  private static readonly CRITICAL_TYPES = new Set([
    'permission_request', 'snapshot', 'tab_created', 'tab_closed',
    'conversation_history', 'heartbeat', 'terminal_snapshot',
  ])

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
    log(`LAN config: port=${this.config.lanPort}`)
    this.lan = new LANServer({ port: this.config.lanPort })

    // Raw connection: start auth handshake before emitting peer-connected.
    this.lan.on('raw-client-connected', (_ws: any, connectionId: string) => {
      log(`LAN raw client connected (${connectionId}), starting auth handshake`)
      this._startLanAuth(connectionId)
    })

    this.lan.on('client-disconnected', (connectionId: string, code: number, _reason: string) => {
      const deviceId = this.lanDeviceMap.get(connectionId)
      this.lanDeviceMap.delete(connectionId)

      // Clean up any pending auth for this connection.
      const pending = this.lanAuthPending.get(connectionId)
      if (pending) {
        clearTimeout(pending.timeout)
        this.lanAuthPending.delete(connectionId)
      }

      this._recomputeState()

      // Close code 4000 = iOS-initiated unpair.
      if (code === 4000 && deviceId) {
        log(`device ${deviceId} sent unpair close code`)
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
      log(`LAN server failed to start: ${(err as Error).message}`)
    }
  }

  /** Create a relay connection for a specific paired device. */
  private _connectRelayForDevice(device: PairedDevice): void {
    if (this.relays.has(device.id)) {
      log(`relay already exists for device ${device.id}, skipping`)
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
      log(`relay connected for device ${device.id}`)
      this._recomputeState()
    })

    relay.on('disconnected', () => {
      log(`relay disconnected for device ${device.id}`)
      this._recomputeState()
    })

    relay.on('message', (msg: WireMessage) => {
      // In lan_preferred mode with this device connected via LAN, ignore relay data.
      const lanConnectionId = this._getLanConnectionForDevice(device.id)
      if (lanConnectionId && this.lan?.hasClient(lanConnectionId)) return
      this._handleIncoming(msg, device.id)
    })

    relay.on('control', (ctrl) => {
      if (ctrl.type === 'relay:peer-reconnected') {
        // Reset dedup counter so the reconnected peer's seq=1 isn't
        // dropped against the previous session's high-water mark.
        this.lastReceivedSeq.set(device.id, 0)
        this.emit('peer-connected')
      } else if (ctrl.type === 'relay:peer-disconnected') {
        // Only emit if this device has no LAN connection either.
        if (!this._getLanConnectionForDevice(device.id)) {
          this.emit('peer-disconnected')
        }
      }
    })

    this.relays.set(device.id, relay)
    relay.connect()
  }

  /** Send a remote event to all connected iOS devices via their preferred transport. */
  send(event: RemoteEvent, push = false): void {
    // If queue is full, apply backpressure
    if (this.sendQueue.length >= RemoteTransport.MAX_QUEUE_SIZE) {
      const isCritical = RemoteTransport.CRITICAL_TYPES.has(event.type)
      if (!isCritical) {
        log(`backpressure: dropping ${event.type} (queue full)`)
        return
      }
      // For critical messages, drop the oldest non-critical message
      const dropIdx = this.sendQueue.findIndex(m => !RemoteTransport.CRITICAL_TYPES.has(m.event.type))
      if (dropIdx >= 0) this.sendQueue.splice(dropIdx, 1)
    }

    this.sendQueue.push({ event, push })
    this._drainQueue()
  }

  private _drainQueue(): void {
    while (this.sendQueue.length > 0) {
      const item = this.sendQueue[0]
      const sent = this._sendToAll(item.event, item.push)
      if (sent) {
        this.sendQueue.shift()
      } else {
        break
      }
    }
  }

  /** Encrypt and send an event to all connected devices. Returns true if sent to at least one. */
  private _sendToAll(event: RemoteEvent, push: boolean): boolean {
    const plaintext = JSON.stringify(event)
    let sentAny = false

    // Send to each device via its preferred transport.
    for (const [deviceId, secret] of this.deviceSecrets) {
      const msg: WireMessage = {
        seq: ++this.seq,
        ts: Date.now(),
        deviceId,
      } as WireMessage

      // Encrypt per-device.
      if (secret && secret.length === 32) {
        try {
          const { nonce, ciphertext } = encrypt(plaintext, secret)
          ;(msg as any).nonce = nonce
          ;(msg as any).ciphertext = ciphertext
        } catch (err) {
          log(`encrypt failed for device ${deviceId}: ${(err as Error).message}`)
          continue
        }
        ;(msg as any).push = push || undefined
      } else {
        ;(msg as any).payload = plaintext
        ;(msg as any).push = push || undefined
      }

      // Prefer LAN if this device has an authenticated LAN connection.
      const lanConnectionId = this._getLanConnectionForDevice(deviceId)
      if (lanConnectionId && this.lan?.hasClient(lanConnectionId)) {
        this.lan.send(msg, lanConnectionId)
        sentAny = true
      } else {
        // Fall back to relay.
        const relay = this.relays.get(deviceId)
        if (relay?.connected) {
          relay.send(msg)
          sentAny = true
        }
      }
    }

    return sentAny
  }

  async stop(): Promise<void> {
    this._stopHeartbeat()

    for (const [, relay] of this.relays) {
      relay.disconnect()
    }
    this.relays.clear()
    this.deviceSecrets.clear()
    this.lastReceivedSeq.clear()

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
    log(`adding device ${device.id} (${device.name})`)
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
    log(`removing device ${deviceId}`)
    const relay = this.relays.get(deviceId)
    if (relay) {
      relay.disconnect()
      this.relays.delete(deviceId)
    }
    this.deviceSecrets.delete(deviceId)
    this.lastReceivedSeq.delete(deviceId)

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
    log(`disconnecting device ${deviceId} (code=${code} reason=${reason})`)
    // Disconnect LAN client for this device.
    const lanConnectionId = this._getLanConnectionForDevice(deviceId)
    if (lanConnectionId) {
      this.lan?.disconnectClient(lanConnectionId, code, reason)
      this.lanDeviceMap.delete(lanConnectionId)
    }
    this._recomputeState()
  }

  /** Send to a specific device only (e.g. unpair notification). */
  sendToDevice(deviceId: string, event: RemoteEvent, push = false): void {
    const secret = this.deviceSecrets.get(deviceId)
    if (!secret) return

    const plaintext = JSON.stringify(event)
    const msg: WireMessage = {
      seq: ++this.seq,
      ts: Date.now(),
      deviceId,
    } as WireMessage

    if (secret.length === 32) {
      try {
        const { nonce, ciphertext } = encrypt(plaintext, secret)
        ;(msg as any).nonce = nonce
        ;(msg as any).ciphertext = ciphertext
      } catch (err) {
        log(`encrypt failed for device ${deviceId}: ${(err as Error).message}`)
        return
      }
      ;(msg as any).push = push || undefined
    } else {
      ;(msg as any).payload = plaintext
      ;(msg as any).push = push || undefined
    }

    const lanConnectionId = this._getLanConnectionForDevice(deviceId)
    if (lanConnectionId && this.lan?.hasClient(lanConnectionId)) {
      this.lan.send(msg, lanConnectionId)
    } else {
      const relay = this.relays.get(deviceId)
      if (relay?.connected) {
        relay.send(msg)
      }
    }
  }

  private _handleIncoming(msg: WireMessage, deviceId: string): void {
    const lastSeq = this.lastReceivedSeq.get(deviceId) || 0

    // Dedup: drop if seq <= lastReceivedSeq
    if (msg.seq <= lastSeq) {
      log(`dedup: dropping msg seq=${msg.seq} from ${deviceId} (last=${lastSeq})`)
      return
    }

    // Gap detection
    if (msg.seq > lastSeq + 1) {
      log(`seq gap from ${deviceId}: expected ${lastSeq + 1}, got ${msg.seq}`)
    }

    this.lastReceivedSeq.set(deviceId, msg.seq)

    // Centralized decryption using per-device secret.
    const secret = this.deviceSecrets.get(deviceId)
    let payload: string | undefined
    if (secret && msg.nonce && msg.ciphertext) {
      payload = decrypt(msg.nonce, msg.ciphertext, secret)
      if (payload === null) {
        log(`decryption failed for seq=${msg.seq} from ${deviceId}`)
        return
      }
    } else if (secret && msg.payload) {
      // Shared secret is set but message is plaintext -- reject it.
      log(`rejecting plaintext message seq=${msg.seq} from ${deviceId} (encryption required)`)
      return
    } else {
      payload = msg.payload
    }

    if (!payload) {
      log(`no payload in message seq=${msg.seq} from ${deviceId}`)
      return
    }

    try {
      const cmd = JSON.parse(payload) as RemoteCommand
      this.emit('command', cmd, deviceId)
    } catch (err) {
      log(`incoming parse error: ${(err as Error).message}`)
    }
  }

  private _startHeartbeat(): void {
    this._stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat', seq: this.seq, ts: Date.now(), buffered: this.sendQueue.length })
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
    log(`state: ${old} → ${state}`)
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
    for (const [connectionId, devId] of this.lanDeviceMap) {
      if (devId === deviceId) return connectionId
    }
    return null
  }

  // ─── LAN Auth Handshake ───

  private _startLanAuth(connectionId: string): void {
    const nonce = createAuthNonce()

    const challenge: AuthChallenge = {
      type: 'auth_challenge',
      nonce,
    }
    this.lan?.sendRaw(JSON.stringify(challenge), connectionId)

    // Timeout: if no valid auth_response within 10 seconds, close.
    const timeout = setTimeout(() => {
      if (this.lanAuthPending.has(connectionId)) {
        log(`LAN auth timed out for ${connectionId}`)
        this.lanAuthPending.delete(connectionId)
        this.lan?.disconnectClient(connectionId, 4003, 'auth timeout')
      }
    }, 10_000)

    this.lanAuthPending.set(connectionId, { nonce, timeout })
  }

  private _handleLanAuthResponse(msg: WireMessage, connectionId: string): void {
    let authResp: AuthResponse | null = null
    try {
      if (msg.payload) {
        const parsed = JSON.parse(msg.payload)
        if (parsed.type === 'auth_response') {
          authResp = parsed as AuthResponse
        }
      }
    } catch { /* not valid JSON */ }

    if (!authResp) {
      log('LAN auth: received non-auth message during handshake, ignoring')
      return
    }

    const pending = this.lanAuthPending.get(connectionId)
    if (!pending) {
      log(`LAN auth: no active nonce for ${connectionId}`)
      this._sendAuthResult(connectionId, false, 'no active challenge')
      return
    }

    // Look up the device by ID.
    const device = this.config.getPairedDevice?.(authResp.deviceId)
    if (!device) {
      log(`LAN auth: unknown device ${authResp.deviceId}`)
      this._sendAuthResult(connectionId, false, 'unknown device')
      this.lan?.disconnectClient(connectionId, 4003, 'unknown device')
      return
    }

    // Verify the HMAC proof.
    const secret = Buffer.from(device.sharedSecret, 'base64')
    const valid = verifyAuthProof(pending.nonce, authResp.proof, secret)
    if (!valid) {
      log(`LAN auth: invalid proof from ${authResp.deviceId}`)
      this._sendAuthResult(connectionId, false, 'invalid proof')
      this.lan?.disconnectClient(connectionId, 4003, 'invalid proof')
      return
    }

    // Auth succeeded.
    clearTimeout(pending.timeout)
    this.lanAuthPending.delete(connectionId)

    // Re-key LAN client from temp connectionId to deviceId.
    this.lan?.rekeyClient(connectionId, device.id)
    this.lanDeviceMap.set(device.id, device.id)

    // Store secret (may already exist from relay, but update in case of re-pair).
    this.deviceSecrets.set(device.id, secret)

    // Reset dedup counter for new LAN session.
    this.lastReceivedSeq.set(device.id, 0)

    log(`LAN auth: device ${authResp.deviceId} (${device.name}) authenticated`)
    this._sendAuthResult(device.id, true)

    this._recomputeState()
    this.emit('peer-connected')
  }

  private _sendAuthResult(connectionId: string, success: boolean, reason?: string): void {
    const result: AuthResult = { type: 'auth_result', success, reason }
    this.lan?.sendRaw(JSON.stringify(result), connectionId)
  }
}
