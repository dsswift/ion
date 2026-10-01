/**
 * Connection — one Studio wire connection (manifest contract C3).
 *
 * Wraps a `ws` WebSocket with the state a hello/action/event/command
 * exchange needs: identity (`id`), the resolved principal and scopes, the
 * declared capabilities (`graph`, `browser`, `terminal`, ...), the
 * negotiated protocol version, and a bounded send buffer.
 *
 * `ConnectionRegistry` is the single source of truth for "which connections
 * exist right now" — `hello.ts` uses it for the `duplicate_client` check,
 * `events.ts` uses it to fan a `studio_event` out to every connection,
 * `commands.ts` uses it to find a connection with a given capability.
 */
import type { ConnectionSocket } from './connection-socket'
import { encodeFrame, encodeBinary } from '@ion/shared/studio-wire/codec'
import type { StudioFrame, StudioCloseReason, StudioPrincipalSummary, Scope, StudioClientKind, StudioView } from '@ion/shared/studio-wire/types'
import type { BinaryChannel } from '@ion/shared/studio-wire/channels'
import { BoundedQueue, DEFAULT_BUFFER_CAP_BYTES } from './buffer'
import { log as _log, warn as _warn, debug as _debug } from '../logger'
import { WireLatencyMeter } from './wire-latency'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('studio-protocol', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('studio-protocol', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('studio-protocol', msg, fields)
}

/** `relay`: an E2E channel through a relay server (`relay-listener.ts`); the pairing secret is the identity. */
export type ConnectionTransport = 'local' | 'tcp' | 'relay'

let nextConnectionSeq = 1

export class Connection {
  readonly id: string
  readonly transport: ConnectionTransport
  readonly connectedAt: number = Date.now()

  clientId: string | null = null
  clientKind: StudioClientKind | null = null
  /**
   * The `credentials.json` client whose `paired` credential admitted this
   * connection, over any transport. Null for every other door. This is what
   * says a paired device is attached right now (`relay-listener.ts` rings a
   * phone only when none of its connections is).
   */
  pairedClientId: string | null = null
  /**
   * Whether this client acts on an intercept for the tab it has focused
   * (`presence.focus`'s options). False until the client says otherwise, so a
   * client that never reports it is only ever shown a banner.
   */
  interceptEnabled = false
  /** The view negotiated at hello. `mirror` until a hello says otherwise, so an unadmitted connection is never treated as thin. */
  view: StudioView = 'mirror'
  /**
   * Thin connections only: the working directories of the tabs in the last
   * snapshot built for this connection's principal (`thin-view/thin-sync.ts`).
   * `events.ts` delivers a thin event that names a `directory` and no tab (git
   * state) only to a connection whose own tabs live there.
   */
  thinDirectories: ReadonlySet<string> = new Set()
  capabilities: string[] = []
  protocolVersion: number | null = null

  principal: StudioPrincipalSummary | null = null
  scopes: Scope[] = []
  /**
   * The Personal preferences this client declared (`preferences.declare`).
   * They belong to the client and live here only as long as the connection
   * does; every action it runs sees them as the ambient request preferences.
   */
  preferences: import('@ion/shared/settings-registry').PersonalPreferences = {}

  /** Bearer-token expiry, set on hello/reauth when a token carries one. Reserved for child 08. */
  authExpiresAt: number | null = null

  /**
   * The `ion_session` cookie value from this connection's WebSocket upgrade
   * request, or null when absent (every non-browser client, and a browser
   * tab with no session yet). Set once by `protocol/listener.ts` right
   * after construction, from the raw HTTP upgrade request -- never
   * re-derived from a `studio_hello` frame, since a cookie cannot be forged
   * into a frame payload the way a claimed credential can.
   */
  sessionCookie: string | null = null

  /**
   * Set by `relay-listener.ts` for a connection fed by a relay channel: the
   * client whose pairing secret opened every envelope on it. The secret IS
   * the proof there (no nonce round trip exists over a relay), so `hello.ts`
   * admits a `paired` credential naming this clientId without an HMAC check.
   * Null on every socket-fed connection, which keeps the nonce path intact.
   */
  preVerifiedClientId: string | null = null

  /**
   * Set by `listener.ts` for a TCP connection whose frames are sealed: the
   * paired client whose secret the socket was wrapped with at upgrade time.
   * Unlike a relay channel this does NOT replace the nonce proof -- a TCP
   * client can fetch `/auth/config`, so the HMAC is still checked -- but the
   * hello must name this same client, since no other client's frames could
   * have opened on this socket. Null on every unsealed connection.
   */
  sealedClientId: string | null = null

  readonly buffer: BoundedQueue

  /**
   * This connection's latency counters. The server is the only place that can
   * see how long a frame waited between entering the queue and leaving the
   * socket, so the send path below feeds it directly.
   */
  readonly latency = new WireLatencyMeter()

  private readonly ws: ConnectionSocket
  private closed = false

  /** The last answer queued by `answerInTurn`; the next one starts after it. */
  private answerTail: Promise<void> = Promise.resolve()
  /** Resolvers of `sendAnswer` calls whose frame has not left the socket yet. */
  private readonly pendingAnswers = new Set<(sent: boolean) => void>()

  /** Newest-wins keys with a frame still on its way to the socket. */
  private readonly latestInFlight = new Set<string>()
  /** Per newest-wins key, the newest frame waiting for the one in flight. */
  private readonly latestWaiting = new Map<string, StudioFrame>()

  constructor(ws: ConnectionSocket, transport: ConnectionTransport, bufferCapBytes: number = DEFAULT_BUFFER_CAP_BYTES) {
    this.ws = ws
    this.transport = transport
    this.id = `conn-${nextConnectionSeq++}-${Math.random().toString(36).slice(2, 8)}`
    this.buffer = new BoundedQueue(bufferCapBytes)
  }

  get isClosed(): boolean {
    return this.closed
  }

  hasCapability(capability: string): boolean {
    return this.capabilities.includes(capability)
  }

  /**
   * Send one JSON frame. Returns `false` (and closes the connection with
   * `slow_client`) when this send pushed the bounded queue over its cap —
   * callers should stop sending to a connection once this returns false.
   */
  send(frame: StudioFrame, onSent?: () => void): boolean {
    if (this.closed) return false
    const text = encodeFrame(frame)
    const bytes = Buffer.byteLength(text, 'utf-8')
    const overflowed = this.buffer.push(bytes)
    if (overflowed) {
      warn('send buffer overflow; closing connection', {
        connection_id: this.id,
        buffered_bytes: this.buffer.size,
        cap_bytes: this.buffer.cap,
      })
      this.close('slow_client', `send buffer exceeded ${this.buffer.cap} bytes`)
      return false
    }
    this.latency.recordSend(bytes, this.buffer.size)
    const queuedAt = Date.now()
    this.ws.send(text, (err) => {
      this.buffer.drain(bytes)
      // The callback fires once the socket has taken the frame, so this is
      // the real time it spent queued behind everything ahead of it.
      this.latency.recordSendComplete(Date.now() - queuedAt)
      if (err) warn('frame send failed', { connection_id: this.id, error: String(err) })
      onSent?.()
    })
    return true
  }

  /**
   * Send a frame whose payload is a full snapshot that replaces the previous
   * one under `key`. At most one such frame per key is on its way to the
   * socket; a newer frame waits for it and replaces any frame already waiting.
   * A client that reads slower than snapshots are produced receives the newest
   * one, rather than every stale copy queuing until the send buffer overflows.
   */
  sendLatest(key: string, frame: StudioFrame): boolean {
    if (this.closed) return false
    if (this.latestInFlight.has(key)) {
      if (this.latestWaiting.has(key)) debug('superseded an unsent snapshot', { connection_id: this.id, key })
      this.latestWaiting.set(key, frame)
      return true
    }
    this.latestInFlight.add(key)
    return this.send(frame, () => {
      this.latestInFlight.delete(key)
      const next = this.latestWaiting.get(key)
      if (!next) return
      this.latestWaiting.delete(key)
      this.sendLatest(key, next)
    })
  }

  /** Send one binary frame (terminal data/resize, or a file chunk). */
  sendBinary(channel: BinaryChannel, key: string, payload: Uint8Array): boolean {
    if (this.closed) return false
    const encoded = encodeBinary(channel, key, payload)
    const overflowed = this.buffer.push(encoded.byteLength)
    if (overflowed) {
      warn('send buffer overflow on binary frame; closing connection', {
        connection_id: this.id,
        buffered_bytes: this.buffer.size,
        cap_bytes: this.buffer.cap,
      })
      this.close('slow_client', `send buffer exceeded ${this.buffer.cap} bytes`)
      return false
    }
    this.latency.recordSend(encoded.byteLength, this.buffer.size)
    const queuedAt = Date.now()
    this.ws.send(Buffer.from(encoded), (err) => {
      this.buffer.drain(encoded.byteLength)
      this.latency.recordSendComplete(Date.now() - queuedAt)
      if (err) warn('binary frame send failed', { connection_id: this.id, error: String(err) })
    })
    return true
  }

  /**
   * Sends one binary frame and resolves once it has left the socket: `true`
   * when it was written, `false` when the send failed or the connection is
   * closed. For a sender that waits on each frame before it produces the next
   * (a Port Forward stream reads its socket only after the last chunk left).
   * That wait is what bounds these frames, so they are not counted against
   * the push cap: a slow link slows the stream, and never costs the client
   * its connection.
   */
  sendBinaryPaced(channel: BinaryChannel, key: string, payload: Uint8Array): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    const encoded = Buffer.from(encodeBinary(channel, key, payload))
    return new Promise<boolean>((resolve) => {
      try {
        this.ws.send(encoded, (err) => {
          if (err) warn('paced binary frame send failed', { connection_id: this.id, channel, key, error: String(err) })
          resolve(!err)
        })
      } catch (err) {
        warn('paced binary frame send threw', { connection_id: this.id, channel, key, error: String(err) })
        resolve(false)
      }
    })
  }

  /**
   * Runs `answer` once every answer queued before it on this connection has
   * finished. An answer is work the CLIENT asked for (a conversation's
   * history, say), as opposed to the events the server pushes on its own.
   *
   * A client may ask for many large answers at once: a phone that just
   * connected asks for the history of every conversation it has not loaded.
   * Built and sent together, those answers sit in memory at the same moment
   * and swamp the send buffer, and the client is closed as `slow_client`
   * for nothing but its own request. In turn, each answer is built only
   * after the previous one left the socket, so the client receives them as
   * fast as its link carries them and the server holds one at a time. An
   * answer that throws does not stall the ones behind it.
   */
  answerInTurn(answer: () => Promise<void>): Promise<void> {
    const queuedAt = Date.now()
    const run = this.answerTail.then(async () => {
      if (this.closed) return
      const waitedMs = Date.now() - queuedAt
      if (waitedMs > 0) debug('answer started after earlier answers', { connection_id: this.id, waited_ms: waitedMs })
      await answer()
    })
    this.answerTail = run.catch((err: unknown) => {
      warn('answer failed; the next answer proceeds', { connection_id: this.id, error: String(err) })
    })
    return run
  }

  /**
   * Sends one answer frame and resolves once it has left the socket: `true`
   * when it was written, `false` when the send failed or the connection
   * closed first. Used from inside `answerInTurn`, whose pacing is what
   * bounds these frames, so they are not counted against the push cap; a
   * client that stops reading stalls its own answers, while the events the
   * server pushes still trip `slow_client` as before.
   */
  sendAnswer(frame: StudioFrame): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    const text = encodeFrame(frame)
    const bytes = Buffer.byteLength(text, 'utf-8')
    const startedAt = Date.now()
    return new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (sent: boolean): void => {
        if (settled) return
        settled = true
        this.pendingAnswers.delete(settle)
        resolve(sent)
      }
      this.pendingAnswers.add(settle)
      try {
        this.ws.send(text, (err) => {
          if (err) {
            warn('answer frame send failed', { connection_id: this.id, frame_type: frame.type, bytes, error: String(err) })
            settle(false)
            return
          }
          debug('answer frame left the socket', { connection_id: this.id, frame_type: frame.type, bytes, elapsed_ms: Date.now() - startedAt })
          settle(true)
        })
      } catch (err) {
        warn('answer frame send threw', { connection_id: this.id, frame_type: frame.type, bytes, error: String(err) })
        settle(false)
      }
    })
  }

  /** Resolves every answer still waiting on the socket as unsent. */
  private releasePendingAnswers(): void {
    if (this.pendingAnswers.size === 0) return
    log('connection closed with answers unsent', { connection_id: this.id, pending: this.pendingAnswers.size })
    for (const settle of [...this.pendingAnswers]) settle(false)
  }

  /** Send `studio_close` and terminate the underlying socket. Idempotent. */
  close(reason: StudioCloseReason, detail?: string): void {
    if (this.closed) return
    this.closed = true
    this.releasePendingAnswers()
    this.latestWaiting.clear()
    log('connection closing', { connection_id: this.id, reason, detail, client_id: this.clientId })
    try {
      this.ws.send(encodeFrame({ type: 'studio_close', reason, detail }))
    } catch (err) {
      warn('failed to send studio_close before terminating', { connection_id: this.id, error: String(err) })
    }
    this.ws.close()
  }

  /** Mark closed without sending `studio_close` (the socket already closed on its own). */
  markClosed(): void {
    this.closed = true
    this.releasePendingAnswers()
    this.latestWaiting.clear()
  }

  /**
   * Liveness state for the heartbeat in `protocol/listener.ts`.
   *
   * A socket dropped by an intermediary (an idle timeout at a CDN or reverse
   * proxy) or by a sleeping client never delivers a close event, so nothing
   * else in this process ever learns the peer is gone. The registry would go
   * on believing in the connection, `events.ts` would go on writing frames
   * into it, and `hello.ts` would go on refusing the real client its own
   * clientId -- which is exactly how one browser ends up holding half a
   * conversation and another browser the other half.
   */
  private awaitingPong = false

  /** Records a `pong`, clearing the outstanding heartbeat. */
  markPongReceived(): void {
    this.awaitingPong = false
  }

  /**
   * Sends one heartbeat ping. Returns `false` when the PREVIOUS ping was
   * never answered -- the peer is gone and the caller should terminate and
   * unregister this connection.
   */
  heartbeat(): boolean {
    if (this.awaitingPong) return false
    this.awaitingPong = true
    try {
      this.ws.ping()
    } catch (err) {
      warn('heartbeat ping failed; treating the peer as gone', { connection_id: this.id, error: String(err) })
      return false
    }
    return true
  }

  /**
   * Drop the socket without the closing handshake. Used when the peer has
   * already stopped answering, where `close()`'s `studio_close` frame would
   * only block on a socket nobody is reading.
   */
  terminate(): void {
    this.closed = true
    this.releasePendingAnswers()
    try {
      this.ws.terminate()
    } catch (err) {
      warn('terminate failed', { connection_id: this.id, error: String(err) })
    }
  }
}

/**
 * All live connections. A `Map` keyed by connection id, with the lookups
 * `hello.ts`/`events.ts`/`commands.ts` need — id membership, capability
 * search, and the `duplicate_client` clientId check.
 */
export class ConnectionRegistry {
  private readonly byId = new Map<string, Connection>()
  private readonly removeListeners: Array<(conn: Connection) => void> = []

  add(conn: Connection): void {
    this.byId.set(conn.id, conn)
  }

  remove(conn: Connection): void {
    if (!this.byId.delete(conn.id)) return
    for (const listener of this.removeListeners) {
      try {
        listener(conn)
      } catch (err) {
        warn('connection remove listener failed', { connection_id: conn.id, error: String(err) })
      }
    }
  }

  /** Call `listener` each time a registered connection is removed, by any path. */
  onRemove(listener: (conn: Connection) => void): void {
    this.removeListeners.push(listener)
  }

  all(): Connection[] {
    return [...this.byId.values()]
  }

  /** A connection already registered under this `clientId` (for `duplicate_client`). */
  findByClientId(clientId: string): Connection | undefined {
    return this.all().find((c) => c.clientId === clientId && !c.isClosed)
  }

  /** A connection advertising `capability`, most recently connected first. */
  findByCapability(capability: string): Connection | undefined {
    return this.all()
      .filter((c) => !c.isClosed && c.hasCapability(capability))
      .sort((a, b) => b.connectedAt - a.connectedAt)[0]
  }
}

/** The process-wide registry. One server process is one environment (manifest C3). */
export const connectionRegistry = new ConnectionRegistry()
