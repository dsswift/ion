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
import { watchSocketLiveness } from '@ion/shared/socket-liveness'

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
/**
 * How long a session must have stayed open for its 4401 to be an ordinary
 * expiry. The relay validates the token at the upgrade and closes with 4401
 * when that token's lifetime ends, so a session that outlived this was opened
 * with a fresh token; only one that expired almost at once was opened with a
 * token the engine served from a stale cache.
 */
const TOKEN_FRESH_SESSION_MS = 60_000

/** The `trust` payload of a `relay_announce` frame (manifest C7). */
export type RelayAnnounceTrust =
  | { issuer: string; audience: string; scope: string; /** The one subject allowed to join. */ subject?: string }
  | { pairing: true; expiresAt: number }

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
  /**
   * Join as a multi-client server (`multi=1`): the relay keeps every client
   * of the channel's pairing connected at once, names each with
   * `relay:peer-joined` / `relay:peer-left`, and stamps each client frame
   * with its `peer`. A relay that predates this ignores the flag and keeps
   * one client.
   */
  multiClient?: boolean
  /** A rejected bearer needs one cache-bypassing credential refresh. */
  onCredentialRejected?: () => void
  /**
   * Server-announced trust (manifest C7, child 08): when set, sent as
   * `{"type":"relay_announce","trust":...}` -- the ion peer's FIRST text
   * frame after every WebSocket upgrade (including reconnects, since the
   * relay clears a channel's announced trust when its ion peer disconnects).
   * Omitted entirely (no announce frame sent) when this is undefined, which
   * is what a `server.json` with no `oidc` block produces -- the relay then
   * validates joins against its own org-wide OIDC/PSK, unchanged.
   */
  announceTrust?: RelayAnnounceTrust
  /** Liveness ping interval (`socket-liveness.ts`); the default suits production, tests shorten it. */
  heartbeatIntervalMs?: number
}

/**
 * Events:
 *  - 'message' (data: WireMessage) -- incoming message from peer
 *  - 'control' (msg: RelayControlMessage) -- relay control frames
 *  - 'connected' -- WebSocket open
 *  - 'disconnected' -- WebSocket closed
 */
/**
 * Every `RelayClient` that has been constructed and not yet disconnected.
 *
 * A relay socket does not survive the host going to sleep: the TCP connection
 * is gone when the machine resumes and the socket sits there believing it is
 * connected until something makes it redial. The `desktop_*` transport knew
 * that and renewed its own relays on `lifecycle.systemWake`; the Studio relay
 * clients -- the environment channel and the per-pairing channels -- had no
 * such path, so a phone's relay stayed dead after the Mac woke.
 *
 * The registry lives on the class rather than at each construction site so
 * that a new producer of relay clients is covered by existing, not by
 * remembering to register.
 */
const liveRelayClients = new Set<RelayClient>()

/**
 * Redial every live relay socket. `connect()` closes whatever socket the
 * client is holding first, so this is safe on one that believes it is still
 * connected -- which after a wake is exactly the case that needs it.
 * Returns how many were renewed, for the caller's log line.
 */
export function renewRelayClientsAfterWake(): number {
  for (const client of liveRelayClients) client.connect()
  return liveRelayClients.size
}

/** The live-client count. For tests and for a diagnostics read-out. */
export function liveRelayClientCount(): number {
  return liveRelayClients.size
}

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
   * Consecutive 4401 (token-expired) closes of sessions that did not last
   * TOKEN_FRESH_SESSION_MS. When the engine returns a cached stale token,
   * every reconnect mints the same nearly-expired credential and the relay
   * closes with 4401 again. After TOKEN_EXPIRED_ESCALATE_AFTER of those in a
   * row, escalate to permanent so the operator sees the failure instead of a
   * silent retry loop. Reset on any non-4401 close, and on the 4401 of a
   * session that lasted: a token expiring on schedule is how every healthy
   * OIDC session ends, and counting it took a server off the relay for good
   * after that many token lifetimes.
   */
  private tokenExpiredCount = 0

  /** When the open socket opened, in epoch ms; 0 while there is none. */
  private openedAt = 0

  /**
   * Stops the open socket's liveness check. A socket stranded by a network
   * change looks open here while the relay has dropped it, so the relay has
   * no ion peer and a phone's hello goes nowhere; the check finds that and
   * terminates the socket, whose close reconnects.
   */
  private stopLiveness: (() => void) | null = null

  constructor(options: RelayClientOptions) {
    super()
    this.options = options
    liveRelayClients.add(this)
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

    this._stopHeartbeat()
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
    const url = `${base}/v1/channel/${channelId}?role=ion${this.options.multiClient ? '&multi=1' : ''}`

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
      if (this.options.announceTrust) {
        const trust = this.options.announceTrust
        try {
          ws.send(JSON.stringify({ type: 'relay_announce', trust }))
          log('relay_client: relay_announce sent', 'pairing' in trust ? { pairing: true, expires_at: trust.expiresAt } : { issuer: trust.issuer, audience: trust.audience })
        } catch (err) {
          error('relay_client: relay_announce send failed', { error: (err as Error).message })
        }
      }
      log('connected')
      this._startHeartbeat(ws, gen)
      this._connected = true
      this.openedAt = Date.now()
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
      const sessionMs = this.openedAt ? Date.now() - this.openedAt : 0
      this.openedAt = 0
      this._stopHeartbeat()
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

      if (code === CLOSE_CODE_TOKEN_EXPIRED && sessionMs >= TOKEN_FRESH_SESSION_MS) {
        log('relay_client: token reached its expiry after a full session, reconnecting with a fresh one', { session_ms: sessionMs, cleared_count: this.tokenExpiredCount })
        this.tokenExpiredCount = 0
      } else if (code === CLOSE_CODE_TOKEN_EXPIRED) {
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
        log('relay_client: token expired (4401) soon after connecting, reconnecting via backoff', { session_ms: sessionMs, consecutive_4401: this.tokenExpiredCount })
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

  /**
   * Sends one message to the relay. `cb`, when given, fires once the message
   * has left this socket, or with the error that stopped it: a caller that
   * paces its sends on delivery (`sealed-socket.ts`) needs the real moment,
   * not the moment the message was queued.
   */
  send(message: WireMessage, cb?: (err?: Error) => void): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log('send failed: not connected')
      cb?.(new Error('relay client is not connected'))
      return
    }

    try {
      this.ws.send(JSON.stringify(message), (err) => {
        if (err) log('relay_client: send error', { error: err.message })
        cb?.(err ?? undefined)
      })
    } catch (err) {
      log('relay_client: send error', { error: (err as Error).message })
      cb?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  disconnect(): void {
    liveRelayClients.delete(this)
    this.intentionallyClosed = true
    this.generation++
    this._stopHeartbeat()
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

  private _startHeartbeat(ws: WebSocket, gen: number): void {
    this._stopHeartbeat()
    this.stopLiveness = watchSocketLiveness(ws, {
      intervalMs: this.options.heartbeatIntervalMs,
      onDead: () => error('relay_client: relay stopped answering pings; dropping the socket to reconnect', { generation: gen }),
      onPingError: (err) => log('relay_client: heartbeat ping failed', { error: String(err), generation: gen }),
    })
  }

  private _stopHeartbeat(): void {
    this.stopLiveness?.()
    this.stopLiveness = null
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
