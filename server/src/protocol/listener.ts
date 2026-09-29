/**
 * listener — attaches the Studio WebSocket server to the server's existing
 * HTTP listeners (manifest contract C3: "local (Unix socket / named pipe)
 * and TCP per `server.json.listen`").
 *
 * There is no separate port or socket for the Studio wire: `main.ts` already
 * starts `/healthz`/`/readyz` on a TCP `http.Server` and (per `listen.local`)
 * a local socket/named-pipe `http.Server` (`http/health.ts`). This module
 * upgrades WebSocket connections on those SAME servers via `ws`'s `server`
 * option, so one local socket answers both plain HTTP health probes and
 * `studio_hello` handshakes, and likewise for TCP.
 */
import { WebSocketServer } from 'ws'
import type { ConnectionSocket } from './connection-socket'
import { credentialsStore } from '../auth/credentials-store'
import { unsubscribeGitAll } from '../git/git-subscriptions'
import { decodeFrame } from '@ion/shared/studio-wire/codec'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { getEngineHostInfo, getEnterprisePolicy } from '../engine/engine-bridge-fs'
import type { HealthHandle } from '../http/health'
import { log as _log, warn as _warn, debug as _debug } from '../logger'
import { Connection, connectionRegistry, type ConnectionTransport } from './connection'
import { unregisterPresence } from './presence'
import { unsubscribeCorpusAll } from '../graph-view/corpus-subscriptions'
import { sendThinFirstPaint, noteThinConnectionClosed } from '../thin-view/thin-sync'
import { DEFAULT_BUFFER_CAP_BYTES } from './buffer'
import { handleHello, LocalOnlyAuthPolicy, type AuthPolicy } from './hello'
import { buildStudioSnapshot } from './snapshot'
import { attachConnectionToEvents } from './events'
import { handleAction } from './actions'
import { handleBodyRequest } from './bodies'
import { SealedSocket, wsCarrier } from './sealed-socket'
import { handleSnapshotRequest } from './snapshot-request'
import { handleBinaryFrame } from './terminal-channel'
import { abortInboundTransfersForConnection } from '../transfer/inbound-transfer'
import { handleCommandResult } from './commands'
import { installStudioCommandSenders } from './command-senders'
import { runAsPrincipal } from '../identity/request-principal'
import { registerPrincipal } from '../identity/principal-registry'
import { parseCookie, SESSION_COOKIE_NAME } from '../auth/session-cookie'
import { advertisedRelays } from '../auth/relay-advertise'
import { loggedDirectAddresses } from '../discovery/direct-addresses'
import { currentServerConfig } from '../config/current'
import { flushConnectionWindow } from './wire-latency-probe'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('studio-listener', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('studio-listener', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('studio-listener', msg, fields)
}

export interface StudioListenersOptions {
  environmentId: string
  label: string
  serverVersion: string
  authPolicy?: AuthPolicy
  bufferCapBytes?: number
}

export interface StudioListenersHandle {
  wssList: WebSocketServer[]
  close(): Promise<void>
}

/**
 * Best-effort engine version / enterprise-policy caches, refreshed on every
 * new connection's hello and read synchronously so `handleHello` never
 * blocks on an engine round trip. `cachedEngineVersion` starts `'unknown'`;
 * `cachedEnterprisePolicy` starts `null` (== "no policy") until the first
 * successful read.
 */
let cachedEngineVersion = 'unknown'
let cachedEnterprisePolicy: Awaited<ReturnType<typeof getEnterprisePolicy>> = null

function refreshEngineVersionCache(): void {
  getEngineHostInfo()
    .then((info) => {
      if (info.ok && info.data?.version) cachedEngineVersion = info.data.version
    })
    .catch((err: unknown) => warn('engine version refresh failed', { error: String(err) }))
  getEnterprisePolicy()
    .then((policy) => {
      cachedEnterprisePolicy = policy
    })
    .catch((err: unknown) => warn('enterprise policy refresh failed', { error: String(err) }))
}

/**
 * Runs `fn` with `conn`'s authenticated principal as the ambient identity
 * (`identity/request-principal.ts`) so anything downstream in the async call
 * graph -- tab creation in the store, the engine bridge -- can attribute
 * itself without a threaded parameter. A no-op wrapper when `conn.principal`
 * is unset, which only happens pre-hello.
 */
function withConnPrincipal(conn: Connection, fn: () => void): void {
  if (!conn.principal) {
    fn()
    return
  }
  runAsPrincipal({ principal: conn.principal, preferences: conn.preferences }, fn)
}

function routeMessage(conn: Connection, ws: ConnectionSocket, raw: unknown, isBinary: boolean, unsubscribe: { fn: (() => void) | null }, opts: ResolvedStudioListenerOptions): void {
  if (isBinary) {
    conn.latency.recordInbound()
    withConnPrincipal(conn, () => handleBinaryFrame(conn, raw as Buffer))
    return
  }

  conn.latency.recordInbound()
  let frame: StudioFrame
  try {
    frame = decodeFrame((raw as Buffer).toString('utf-8'))
  } catch (err) {
    conn.latency.recordDecodeError()
    warn('frame decode failed; closing connection', { connection_id: conn.id, error: String(err) })
    ws.close(1002, 'protocol error')
    return
  }

  if (frame.type === 'studio_hello') {
    void handleHello(conn, frame, {
      authPolicy: opts.authPolicy,
      credentials: credentialsStore(),
      registry: connectionRegistry,
      environmentId: opts.environmentId,
      label: opts.label,
      serverVersion: opts.serverVersion,
      engineVersion: () => cachedEngineVersion,
      buildSnapshot: buildStudioSnapshot,
      getEnterprisePolicy: () => cachedEnterprisePolicy,
      advertisedRelays: () => advertisedRelays(currentServerConfig()),
      directAddresses: () => loggedDirectAddresses(currentServerConfig().listen.tcp.port),
      allowUnsealedPaired: () => currentServerConfig().listen.tcp.allowUnsealedPaired,
    }).then((welcomed) => {
      if (!welcomed) return
      unsubscribe.fn = attachConnectionToEvents(conn)
      // Subscribed first, so nothing published while the first paint builds is missed.
      if (conn.view === 'thin') void sendThinFirstPaint(conn)
    })
    return
  }

  if (frame.type === 'studio_pong') {
    // Answers a probe this server sent, so it carries nothing to authorize and
    // is handled before the principal gate -- a probe sent to a connection
    // mid-reauth would otherwise be counted lost.
    const rtt = conn.latency.recordPong(frame.nonce, Date.now())
    if (rtt === null) {
      debug('pong for an unknown probe; ignoring', { connection_id: conn.id })
    }
    return
  }

  if (!conn.principal) {
    warn('frame received before a successful hello; dropping', { connection_id: conn.id, frame_type: frame.type })
    return
  }

  switch (frame.type) {
    case 'studio_action': {
      const startedAt = Date.now()
      withConnPrincipal(conn, () => void handleAction(conn, frame).finally(() => {
        conn.latency.recordAction(Date.now() - startedAt)
      }))
      return
    }
    case 'studio_body_request':
      withConnPrincipal(conn, () => void handleBodyRequest(conn, frame))
      return
    case 'studio_snapshot_request':
      withConnPrincipal(conn, () => {
        handleSnapshotRequest(conn, buildStudioSnapshot)
        // A thin connection's state is not in `studio_snapshot`; a resync re-sends its first paint.
        if (conn.view === 'thin') void sendThinFirstPaint(conn)
      })
      return
    case 'studio_command_result':
      handleCommandResult(frame)
      return
    case 'studio_reauth':
      void opts.authPolicy.authenticate(frame.credential, conn.transport, conn.sessionCookie).then((auth) => {
        if (auth.ok) {
          conn.principal = auth.principal
          conn.scopes = auth.scopes
          conn.authExpiresAt = auth.expiresAt ?? null
          registerPrincipal(auth.principal, auth.claims)
          log('reauth accepted', { connection_id: conn.id, subject: auth.principal.subject })
        } else {
          warn('reauth refused; closing connection', { connection_id: conn.id, reason: auth.reason ?? 'unauthorized' })
          conn.close('revoked', 'reauth credential was not accepted')
        }
      })
      return
    default:
      // Every remaining frame type (`studio_welcome`, `studio_refused`,
      // `studio_event`, `studio_command`, `studio_snapshot`,
      // `studio_environment_policy`, `studio_body`, `studio_close`) is
      // server-authored — a client should never send one. Dropped, not
      // fatal: a well-behaved client simply never sends these.
      warn('server-authored frame type received from a client; dropping', { connection_id: conn.id, frame_type: frame.type })
  }
}

/** The resolved listener options every admitted connection is routed with. */
export type ResolvedStudioListenerOptions = Required<Pick<StudioListenersOptions, 'environmentId' | 'label' | 'serverVersion' | 'authPolicy' | 'bufferCapBytes'>>

export interface AttachConnectionExtras {
  /** The `ion_session` cookie from the upgrade request (socket transports only). */
  sessionCookie?: string | null
  /** The paired client a relay channel belongs to (relay transport only; see `Connection.preVerifiedClientId`). */
  preVerifiedClientId?: string | null
  /** The paired client a sealed TCP socket was wrapped for (see `Connection.sealedClientId`). */
  sealedClientId?: string | null
}

/**
 * Admits one socket as a Studio connection: constructs the `Connection`,
 * routes every frame it sends, and tears down every per-connection
 * subscription when it closes. One implementation for the local socket, the
 * TCP listener, and a relay channel (`relay-listener.ts`), which is what
 * makes a relay-fed client indistinguishable downstream.
 */
export function attachConnection(socket: ConnectionSocket, transport: ConnectionTransport, opts: ResolvedStudioListenerOptions, extras: AttachConnectionExtras = {}): Connection {
  const conn = new Connection(socket, transport, opts.bufferCapBytes)
  // Captured once, from the raw upgrade request -- never re-read from a
  // studio_hello frame (see Connection.sessionCookie's doc).
  conn.sessionCookie = extras.sessionCookie ?? null
  conn.preVerifiedClientId = extras.preVerifiedClientId ?? null
  conn.sealedClientId = extras.sealedClientId ?? null
  const unsubscribe: { fn: (() => void) | null } = { fn: null }
  refreshEngineVersionCache()
  log('connection opened', { connection_id: conn.id, transport, pre_verified: !!conn.preVerifiedClientId, sealed: !!conn.sealedClientId })

  socket.on('pong', () => conn.markPongReceived())
  socket.on('message', (data, isBinary) => routeMessage(conn, socket, data, isBinary, unsubscribe, opts))
  socket.on('close', (code, reasonBuf) => {
    unsubscribe.fn?.()
    // Before it leaves the registry: whatever this connection measured since
    // its last window would otherwise go with it, and a short-lived client
    // would never report at all.
    flushConnectionWindow(conn)
    connectionRegistry.remove(conn)
    unregisterPresence(conn)
    conn.markClosed()
    // A thin connection counted as remote attention; it no longer does.
    if (conn.view === 'thin') noteThinConnectionClosed(conn)
    abortInboundTransfersForConnection(conn.id, 'connection closed')
    // Without this every dropped client leaks a retained GitRepository and
    // its file watcher for the lifetime of the process.
    unsubscribeGitAll(conn.id)
    // Same leak, other store: a Graph View subscription keeps a directory
    // scan warm and a watcher running until every reference is released.
    unsubscribeCorpusAll(conn.id)
    log('connection closed', { connection_id: conn.id, code, reason: reasonBuf.toString('utf-8') })
  })
  socket.on('error', (err) => warn('websocket error', { connection_id: conn.id, error: String(err) }))
  return conn
}

/** The clientId a TCP upgrade named in `?client=`, or null when it asked for a plain socket. */
export function sealedClientParam(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null
  try {
    const value = new URL(rawUrl, 'http://listener.invalid').searchParams.get('client')
    return value && value.length <= 128 ? value : null
  } catch {
    // silent-ok: an unparseable upgrade URL names no client; it is served as a plain socket.
    return null
  }
}

function attachWss(server: import('http').Server, transport: ConnectionTransport, opts: ResolvedStudioListenerOptions): WebSocketServer {
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws, req) => {
    const sessionCookie = parseCookie(req.headers.cookie, SESSION_COOKIE_NAME)
    // `?client=<clientId>` on the TCP listener asks for a sealed socket: the
    // client will seal every frame with its pairing secret, so the socket is
    // wrapped before the first frame is read. An unknown or revoked client
    // has no secret to seal with, and nothing it sends could ever open.
    const sealedFor = transport === 'tcp' ? sealedClientParam(req.url) : null
    if (sealedFor === null) {
      attachConnection(ws, transport, opts, { sessionCookie })
      return
    }
    const record = credentialsStore().get(sealedFor)
    const secret = record && record.revokedAt === null ? credentialsStore().secretFor(sealedFor) : null
    if (!secret) {
      warn('sealed connection refused: no usable pairing for the named client', { client_id: sealedFor, known: !!record, revoked: !!record && record.revokedAt !== null })
      ws.close(1008, 'unknown client')
      return
    }
    attachConnection(new SealedSocket(wsCarrier(ws), secret, sealedFor), transport, opts, { sessionCookie, sealedClientId: sealedFor })
  })
  wss.on('error', (err) => warn('WebSocketServer error', { transport, error: String(err) }))
  return wss
}

/**
 * How often the heartbeat pings every registered connection. A connection
 * that has not answered the previous ping by the next tick is terminated and
 * unregistered, so this is also the worst-case delay before a client that
 * lost its socket silently can reclaim its own clientId.
 *
 * 30s sits under the common 60-100s idle timeouts at CDNs and reverse
 * proxies, so the ping traffic doubles as keepalive and the socket is far
 * less likely to be dropped in the first place.
 */
const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Ping every registered connection and drop the ones that stopped answering.
 *
 * Without this, a socket an intermediary dropped without a close frame stays
 * in the registry forever: events are written into it and lost, and the real
 * client is refused its own clientId on every reconnect. Exported for tests,
 * which drive it directly rather than waiting on a timer.
 */
export function sweepConnectionLiveness(): void {
  for (const conn of connectionRegistry.all()) {
    if (conn.isClosed) {
      connectionRegistry.remove(conn)
      unregisterPresence(conn)
      continue
    }
    if (!conn.heartbeat()) {
      warn('connection missed its heartbeat; terminating and unregistering', {
        connection_id: conn.id,
        client_id: conn.clientId,
      })
      conn.terminate()
      connectionRegistry.remove(conn)
      unregisterPresence(conn)
    }
  }
}

/**
 * Attach the Studio wire to `health`'s existing listeners. Call once at boot
 * after `startHealth()`. Idempotent per `HealthHandle` (a second call on the
 * same handle would double-attach — callers should not do that; there is no
 * internal guard because a server process starts health exactly once).
 */
/** Fills the optional listener options with their defaults. */
export function resolveStudioListenerOptions(options: StudioListenersOptions): ResolvedStudioListenerOptions {
  return {
    environmentId: options.environmentId,
    label: options.label,
    serverVersion: options.serverVersion,
    authPolicy: options.authPolicy ?? new LocalOnlyAuthPolicy(),
    bufferCapBytes: options.bufferCapBytes ?? DEFAULT_BUFFER_CAP_BYTES,
  }
}

export function startStudioListeners(health: HealthHandle, options: StudioListenersOptions): StudioListenersHandle {
  const opts = resolveStudioListenerOptions(options)
  const wssList: WebSocketServer[] = []
  if (health.localServer) {
    wssList.push(attachWss(health.localServer, 'local', opts))
    log('Studio wire attached to local listener', { environment_id: opts.environmentId })
  }
  if (health.tcpServer) {
    wssList.push(attachWss(health.tcpServer, 'tcp', opts))
    log('Studio wire attached to TCP listener', { environment_id: opts.environmentId })
  }
  if (wssList.length === 0) {
    warn('startStudioListeners called with neither a local nor a TCP server available')
  }
  installStudioCommandSenders(opts.environmentId)
  const heartbeat = setInterval(sweepConnectionLiveness, HEARTBEAT_INTERVAL_MS)
  // Never hold the process open on the heartbeat alone.
  heartbeat.unref()
  log('connection heartbeat started', { interval_ms: HEARTBEAT_INTERVAL_MS })
  return {
    wssList,
    close(): Promise<void> {
      clearInterval(heartbeat)
      for (const conn of connectionRegistry.all()) conn.close('shutdown')
      return Promise.all(wssList.map((wss) => new Promise<void>((resolve) => wss.close(() => resolve())))).then(() => undefined)
    },
  }
}
