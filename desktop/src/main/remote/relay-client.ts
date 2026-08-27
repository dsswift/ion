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
  CLOSE_CODE_TOKEN_EXPIRED,
  UNKNOWN_FAILURE_ESCALATE_AFTER,
  type RelayFailure,
} from './relay-failure'
import { classifyRelayRejection } from './relay-rejection'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RelayClient', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _errorLog('RelayClient', msg, fields)
}

const BACKOFF_BASE = 1000
const BACKOFF_MAX = 30000
const JITTER_MAX = 1000
const TOKEN_EXPIRED_ESCALATE_AFTER = 5

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
   * deferred to the next backoff window -- no tight loop. When absent, the
   * static apiKey is used.
   */
  getCredential?: () => Promise<string>
  /** A rejected bearer needs one cache-bypassing credential refresh. */
  onCredentialRejected?: () => void
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
   * reconnect is scheduled -- the loop that produced one attempt every ~14
   * seconds for an unsigned-in user is exactly what this stops. Cleared by
   * retry(), which the settings UI and a credential change both call.
   */
  private permanentFailure: RelayFailure | null = null
  /** Consecutive unknown-class failures, for escalation. */
  private unknownFailureCount = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionallyClosed = false
  private _connected = false

  /**
   * Monotonically increasing generation counter. Incremented at the start of
   * each _doConnect and by disconnect(); callbacks capture the generation and
   * bail when it no longer matches, preventing a stale socket's
   * close/open/message events from mutating the state of a newer connection.
   */
  private generation = 0

  /**
   * Consecutive 4401 (token-expired) close codes. When the engine returns a
   * cached stale token, every reconnect mints the same expired credential and
   * the relay closes with 4401 again. After TOKEN_EXPIRED_ESCALATE_AFTER
   * consecutive 4401s, escalate to permanent so the operator sees the failure
   * instead of a silent retry loop. Reset on any non-4401 close.
   */
  private tokenExpiredCount = 0

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
    const gen = ++this.generation

    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }

    const { relayUrl, apiKey, channelId, getCredential } = this.options
    let upgradeStatus: number | undefined

    // Resolve bearer token: OIDC credential factory or static PSK.
    let bearer: string
    if (getCredential) {
      try {
        bearer = await getCredential()
      } catch (err) {
        if (this.intentionallyClosed || gen !== this.generation) return
        this._handleFailure(classifyCredentialError(err as Error), 'credential')
        return
      }
    } else {
      bearer = apiKey
    }

    // Guard: disconnect() or a newer _doConnect() fired while awaiting credential.
    if (this.intentionallyClosed || gen !== this.generation) {
      log('relay_client: connect abandoned after credential', {
        intentionally_closed: this.intentionallyClosed,
        generation_stale: gen !== this.generation,
      })
      return
    }

    // Normalize URL: ensure wss:// or ws:// prefix and /v1/channel/ path.
    let base = relayUrl.replace(/\/$/, '')
    if (!base.startsWith('ws://') && !base.startsWith('wss://')) {
      // Convert https:// to wss:// or http:// to ws://
      base = base.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://')
    }
    const url = `${base}/v1/channel/${channelId}?role=ion`

    log('relay_client: connecting', { url: url.replace(/\/v1\/channel\/.*/, '/v1/channel/***'), auth_mode: getCredential ? 'oidc' : 'psk', generation: gen })

    const ws = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${bearer}`,
      },
    })
    this.ws = ws

    // HTTP auth failures happen before the WebSocket upgrade. The following
    // close event reports 1006, so capture the structured status here instead
    // of guessing from ws's error text.
    ws.on('unexpected-response', (request, response) => {
      if (gen !== this.generation) {
        response.resume()
        return
      }
      upgradeStatus = response.statusCode
      log('relay_client: upgrade rejected', { http_status: upgradeStatus, generation: gen })

      // Registering this listener transfers cleanup responsibility from ws to
      // us. Without it a rollout's temporary 404 leaves the client in a
      // half-open CONNECTING state: no close callback runs, no backoff is
      // scheduled, and iOS finds no desktop peer through relay. Drain and
      // destroy the rejected HTTP exchange, then invalidate any late socket
      // callbacks before routing this failure through the normal policy.
      response.resume()
      request.destroy()
      this.generation++
      this.ws = null
      this._connected = false
      this.emit('disconnected')

      const rejection = classifyRelayRejection(1006, upgradeStatus)
      if (rejection.kind === 'identity_mismatch') {
        this._handleFailure(rejection.failure, 'close')
      } else {
        if (rejection.kind === 'expired') this.options.onCredentialRejected?.()
        this._handleFailure(
          rejection.kind === 'expired'
            ? { class: 'transient', reason: 'credential_rejected' }
            : { class: 'transient', reason: 'upgrade_rejected', detail: `Relay upgrade returned HTTP ${upgradeStatus}` },
          'close',
        )
      }
    })

    ws.on('open', () => {
      if (gen !== this.generation) {
        log('relay_client: stale open callback ignored', { stale_gen: gen, current_gen: this.generation })
        return
      }
      log('connected')
      this._connected = true
      this.reconnectAttempt = 0
      this.permanentFailure = null
      this.unknownFailureCount = 0
      this.emit('connected')
    })

    ws.on('message', (raw: Buffer | string) => {
      if (gen !== this.generation) return
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

    ws.on('close', (code, reason) => {
      if (gen !== this.generation) {
        log('relay_client: stale close callback ignored', { stale_gen: gen, current_gen: this.generation, code })
        return
      }
      log('relay_client: disconnected', { code, reason: reason?.toString() || '' })
      this._connected = false
      this.ws = null
      this.emit('disconnected')

      const rejection = classifyRelayRejection(code, upgradeStatus)
      if (rejection.kind === 'identity_mismatch') {
        this._handleFailure(rejection.failure, 'close')
        return
      }
      if (rejection.kind === 'expired') {
        this.options.onCredentialRejected?.()
        log('relay_client: credential rejected, requesting forced refresh', {
          close_code: code,
          http_status: upgradeStatus ?? 'none',
          generation: gen,
        })
      }

      if (code === CLOSE_CODE_TOKEN_EXPIRED) {
        this.tokenExpiredCount++
        if (this.tokenExpiredCount >= TOKEN_EXPIRED_ESCALATE_AFTER) {
          error('relay_client: repeated token expiry, escalating to permanent', {
            consecutive_4401: this.tokenExpiredCount,
          })
          this._handleFailure({
            class: 'permanent',
            reason: 'token_stale',
            detail: `Token rejected ${this.tokenExpiredCount} consecutive times. The credential may be cached and stale.`,
          }, 'close')
          return
        }
        log('relay_client: token expired (4401), reconnecting via backoff')
      } else {
        this.tokenExpiredCount = 0
      }

      this._handleFailure(classifyCloseCode(code, reason?.toString() || ''), 'close')
    })

    ws.on('error', (err) => {
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
    this.generation++
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
   * failures keep the existing backoff. Unknown failures keep retrying --
   * misclassifying a transient as permanent is the worse mistake -- but
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
    this.tokenExpiredCount = 0
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
