/**
 * Outbound WebSocket client to the relay server.
 *
 * Connects to: wss://relay.example.com/v1/channel/{channelId}?role=ion
 * Auth: Authorization: Bearer {apiKey}  (PSK mode)
 *       Authorization: Bearer {await getCredential()}  (OIDC mode)
 *
 * Handles reconnection with exponential backoff. Wire sequence numbering is
 * owned by RemoteTransport (per-device counters); this client only ships
 * pre-built frames.
 */

import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { log as _log, error as _errorLog } from '../logger'
import type { WireMessage, RelayControlMessage } from './protocol'
import {
  classifyCredentialError,
  classifyCloseCode,
  UNKNOWN_FAILURE_ESCALATE_AFTER,
  type RelayFailure,
} from './relay-failure'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RelayClient', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _errorLog('RelayClient', msg, fields)
}

const BACKOFF_BASE = 1000
const BACKOFF_MAX = 30000
const JITTER_MAX = 1000

/** Close code sent by the relay when the bearer token is rejected or expired. */
const CLOSE_CODE_TOKEN_EXPIRED = 4401

export interface RelayClientOptions {
  relayUrl: string
  /**
   * Static pre-shared key (PSK mode). Used when getCredential is not set.
   * Mutually exclusive with getCredential in practice; if both are present
   * getCredential takes precedence.
   */
  apiKey: string
  channelId: string
  /**
   * OIDC credential factory (OIDC mode). When present, called before each
   * connect attempt to mint a fresh bearer token. On failure the connect is
   * deferred to the next backoff window — no tight loop. When absent, the
   * static apiKey is used.
   */
  getCredential?: () => Promise<string>
}

/**
 * Events:
 *  - 'message' (data: WireMessage) -- incoming message from peer
 *  - 'control' (msg: RelayControlMessage) -- relay control frames
 *  - 'connected' -- WebSocket open
 *  - 'disconnected' -- WebSocket closed
 */
export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null
  private options: RelayClientOptions
  private reconnectAttempt = 0
  /**
   * Set when a failure cannot be fixed by retrying. While latched, no
   * reconnect is scheduled — the loop that produced one attempt every ~14
   * seconds for an unsigned-in user is exactly what this stops. Cleared by
   * retry(), which the settings UI and a credential change both call.
   */
  private permanentFailure: RelayFailure | null = null
  /** Consecutive unknown-class failures, for escalation. */
  private unknownFailureCount = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionallyClosed = false
  private _connected = false

  constructor(options: RelayClientOptions) {
    super()
    this.options = options
  }

  get connected(): boolean {
    return this._connected
  }

  connect(): void {
    this.intentionallyClosed = false
    void this._doConnect()
  }

  private async _doConnect(): Promise<void> {
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }

    const { relayUrl, apiKey, channelId, getCredential } = this.options

    // Resolve bearer token: OIDC credential factory or static PSK.
    let bearer: string
    if (getCredential) {
      try {
        bearer = await getCredential()
      } catch (err) {
        this._handleFailure(classifyCredentialError(err as Error), 'credential')
        return
      }
    } else {
      bearer = apiKey
    }

    // Normalize URL: ensure wss:// or ws:// prefix and /v1/channel/ path.
    let base = relayUrl.replace(/\/$/, '')
    if (!base.startsWith('ws://') && !base.startsWith('wss://')) {
      // Convert https:// to wss:// or http:// to ws://
      base = base.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://')
    }
    const url = `${base}/v1/channel/${channelId}?role=ion`

    log('relay_client: connecting', { url: url.replace(/\/v1\/channel\/.*/, '/v1/channel/***'), auth_mode: getCredential ? 'oidc' : 'psk' })

    this.ws = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${bearer}`,
      },
    })

    this.ws.on('open', () => {
      log('connected')
      this._connected = true
      this.reconnectAttempt = 0
      this.permanentFailure = null
      this.unknownFailureCount = 0
      this.emit('connected')
    })

    this.ws.on('message', (raw: Buffer | string) => {
      try {
        const data = JSON.parse(raw.toString())

        // Check for relay control frames.
        if (typeof data.type === 'string' && data.type.startsWith('relay:')) {
          this.emit('control', data as RelayControlMessage)
          return
        }

        this.emit('message', data as WireMessage)
      } catch (err) {
        log('relay_client: parse error', { error: (err as Error).message })
      }
    })

    this.ws.on('close', (code, reason) => {
      log('relay_client: disconnected', { code, reason: reason?.toString() || '' })
      this._connected = false
      this.ws = null
      this.emit('disconnected')

      if (code === CLOSE_CODE_TOKEN_EXPIRED) {
        // Token rejected or expired. The backoff handles reconnect timing;
        // on the next _doConnect, getCredential() will mint a fresh token.
        log('relay_client: token expired (4401), reconnecting via backoff')
      }

      this._handleFailure(classifyCloseCode(code, reason?.toString() || ''), 'close')
    })

    this.ws.on('error', (err) => {
      log('relay_client: error', { error: err.message })
      // 'close' event will follow, triggering reconnect.
    })
  }

  send(message: WireMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log('send failed: not connected')
      return
    }

    try {
      this.ws.send(JSON.stringify(message))
    } catch (err) {
      log('relay_client: send error', { error: (err as Error).message })
    }
  }

  disconnect(): void {
    this.intentionallyClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    this._connected = false
  }

  updateOptions(options: Partial<RelayClientOptions>): void {
    Object.assign(this.options, options)
  }

  /**
   * Route a failure by class.
   *
   * Permanent failures latch and emit 'failed' instead of scheduling a
   * reconnect: retrying a missing sign-in or a rejected scope cannot succeed,
   * and doing it forever hides the actual problem behind a spinner. Transient
   * failures keep the existing backoff. Unknown failures keep retrying —
   * misclassifying a transient as permanent is the worse mistake — but
   * escalate to ERROR once they stop looking like a blip.
   */
  private _handleFailure(failure: RelayFailure, source: 'credential' | 'close'): void {
    if (this.intentionallyClosed) return

    if (failure.class === 'permanent') {
      this.permanentFailure = failure
      error('relay_client: permanent failure, not retrying', {
        source, reason: failure.reason, detail: failure.detail,
      })
      this.emit('failed', failure)
      return
    }

    if (failure.class === 'unknown') {
      this.unknownFailureCount++
      if (this.unknownFailureCount >= UNKNOWN_FAILURE_ESCALATE_AFTER) {
        error('relay_client: unclassified failure persisting, still retrying', {
          source, reason: failure.reason, detail: failure.detail, attempts: this.unknownFailureCount,
        })
        this.unknownFailureCount = 0
      }
    } else {
      this.unknownFailureCount = 0
    }

    this._scheduleReconnect()
  }

  /**
   * Clear a permanent latch and reconnect now.
   *
   * Called after the operator signs in or edits the relay config, and by an
   * explicit Reconnect action. Without this a permanent failure would be
   * terminal for the process lifetime, which trades one bad behaviour
   * (retrying forever) for another (never retrying).
   */
  retry(): void {
    if (!this.permanentFailure) return
    log('relay_client: clearing permanent failure, retrying', { reason: this.permanentFailure.reason })
    this.permanentFailure = null
    this.unknownFailureCount = 0
    this.reconnectAttempt = 0
    void this._doConnect()
  }

  /** The latched permanent failure, if any. Drives the UI's reason line. */
  getFailure(): RelayFailure | null {
    return this.permanentFailure
  }

  private _scheduleReconnect(): void {
    const delay = Math.min(
      BACKOFF_BASE * Math.pow(2, this.reconnectAttempt),
      BACKOFF_MAX
    ) + Math.random() * JITTER_MAX

    log('relay_client: reconnecting', { delay_ms: Math.round(delay), attempt: this.reconnectAttempt + 1 })
    this.reconnectAttempt++

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this._doConnect()
    }, delay)
  }
}
