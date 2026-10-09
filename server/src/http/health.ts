import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { connect } from 'net'
import { existsSync, unlinkSync } from 'fs'
import { log as _log, warn as _warn, error as _error } from '../logger'
import { withSpan } from '../tracing/op-span'
import { parseTraceparent } from '@ion/shared/trace-context'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('health', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('health', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _error('health', msg, fields)
}

/** `/readyz` failure reasons (manifest C14). */
export type ReadinessReason = 'state_file_corrupt' | 'engine_incompatible' | 'engine_unreachable' | 'tenancy_conflict'

export interface ReadinessState {
  ready: boolean
  reason?: ReadinessReason
  detail?: string
}

export interface HealthOptions {
  /** TCP port to listen on (server.json's `listen.tcp.port`, default 7331 per manifest C5). Omit to skip the TCP listener. */
  port?: number
  /** Host to bind the TCP listener to. Defaults to all interfaces, matching `listen.tcp.host` in C5. */
  host?: string
  /**
   * Unix domain socket path (or, on win32, a named pipe path) for the
   * local-only listener (manifest 06 "`/healthz`, `/readyz` per manifest
   * C14 on the TCP listener and the local socket's HTTP"). Omit to skip the
   * socket listener. `server/src/protocol/listener.ts` (child 07, the
   * Studio wire) is the caller: it passes `dataDir()/studio.sock` here and
   * attaches the Studio WebSocket server to this SAME `http.Server` via
   * `HealthHandle.localServer`, so one local socket answers both plain
   * `/healthz` HTTP requests and `studio_hello` WebSocket upgrades.
   */
  socketPath?: string
  /**
   * Called when the local socket is already owned by a LIVE process (the
   * probe in `listenLocal` connected). The bind that follows will fail
   * EADDRINUSE; the caller decides what a second instance means. `main.ts`
   * treats it as fatal: two Studio servers on one data dir both adopt every
   * tab against the engine, and the desktop connects to whichever bound
   * first -- once, an orphan from a previous desktop running older code.
   */
  onLocalSocketOwned?: (socketPath: string) => void
  /**
   * Additional exact-path routes served on the SAME `http.Server` instances
   * as `/healthz`/`/readyz` (child 08's `GET /auth/config`, manifest C6).
   * Checked before the `/healthz`/`/readyz`/404 fallthrough. `startStudioListeners`
   * (`protocol/listener.ts`) attaches a WebSocket upgrade handler to these
   * same servers via `HealthHandle.tcpServer`/`localServer` -- this is the
   * "one local socket answers both plain HTTP and studio_hello" pattern
   * extended to a second plain-HTTP route rather than a second `http.Server`.
   */
  routes?: Record<string, (req: IncomingMessage, res: ServerResponse) => void>
  /**
   * Handler invoked for any request that matched none of `routes` and isn't
   * `/healthz`/`/readyz` -- child 11's static web-bundle route
   * (`http/static.ts`) attaches here rather than getting its own exact-path
   * entry in `routes`, since it serves an arbitrary asset tree under `/`
   * rather than one fixed path. Defaults to the plain 404 JSON body when
   * omitted, matching the pre-child-11 behavior.
   */
  notFound?: (req: IncomingMessage, res: ServerResponse) => void
}

export interface HealthHandle {
  /** Every `http.Server` this call started, in the order given in `opts` (TCP, then socket). */
  servers: Server[]
  /** The TCP listener from this call, or null when `opts.port` was omitted. */
  tcpServer: Server | null
  /** The local socket/named-pipe listener from this call, or null when `opts.socketPath` was omitted. */
  localServer: Server | null
  /** Replace the current readiness state. Boot phases call this as each gate passes or fails. */
  setReadiness(state: ReadinessState): void
  /** Read the current readiness state (used by tests and by callers deciding whether to proceed past health). */
  getReadiness(): ReadinessState
  /** Closes every listener. Resolves once all have closed. */
  close(): Promise<void>
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function makeRequestHandler(
  getReadiness: () => ReadinessState,
  routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void>,
  notFound?: (req: IncomingMessage, res: ServerResponse) => void,
) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? ''
    // Route on the pathname only -- a query string is request data a
    // handler parses itself (`new URL(req.url, ...)`), never a routing key.
    // `/auth/login?returnTo=/foo` must still hit the exact `/auth/login`
    // entry `routes` registers.
    const pathname = url.split('?')[0]
    // One `http.request` span per request, static assets included, from
    // receipt to the response's end. Ambient while the route runs, so a
    // route's own span (`log.ingest`) is its child.
    void withSpan('http.request', { kind: 'server', parent: requestTraceparent(req), attrs: { method: req.method ?? '', path: pathname } }, (_span, ctx) =>
      new Promise<void>((resolve) => {
        const end = (outcome: string): void => {
          ctx.annotate({ status: res.statusCode, outcome })
          if (outcome === 'aborted') ctx.fail('connection closed before the response ended')
          resolve()
        }
        res.once('finish', () => end('finished'))
        res.once('close', () => end(res.writableFinished ? 'finished' : 'aborted'))
        dispatch(req, res, pathname)
      }))
  }

  function dispatch(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    const route = routes[pathname]
    if (route) {
      route(req, res)
      return
    }
    if (pathname === '/healthz') {
      writeJson(res, 200, { ok: true })
      return
    }
    if (pathname === '/readyz') {
      const readiness = getReadiness()
      if (readiness.ready) {
        writeJson(res, 200, { ready: true })
      } else {
        writeJson(res, 503, { ready: false, reason: readiness.reason, detail: readiness.detail })
      }
      return
    }
    if (notFound) {
      notFound(req, res)
      return
    }
    writeJson(res, 404, { error: 'not_found' })
  }
}

/** The caller's `traceparent` header when it is one, so a browser's fetch span parents this request. */
function requestTraceparent(req: IncomingMessage): string | undefined {
  const header = req.headers.traceparent
  const value = Array.isArray(header) ? header[0] : header
  return parseTraceparent(value) ? value : undefined
}

/**
 * Binds the local listener, clearing a socket file left behind by a previous
 * process that died without closing it.
 *
 * A Unix domain socket is a filesystem entry the kernel does NOT remove when
 * its owner exits abruptly (SIGKILL, an OOM kill, a force-deleted container).
 * The next boot's `listen()` then fails `EADDRINUSE` against a socket nobody
 * is answering on, and because that error is logged rather than thrown the
 * process stays up having silently lost its local wire entirely.
 *
 * Deleting the file unconditionally would be worse: it would steal the socket
 * out from under a genuinely live peer, which is the case `EADDRINUSE` exists
 * to report. So the file is probed first, and a successful connect is the only
 * thing that counts as a live owner — any connect failure means nothing is
 * answering there and the entry can go. A live owner keeps the socket and the
 * bind fails loudly, exactly as it always did.
 *
 * Windows named pipes are not filesystem entries and the OS releases them when
 * their owner exits, so this whole problem is unix-only.
 */
function listenLocal(socket: Server, socketPath: string, onOwned?: (socketPath: string) => void): void {
  if (process.platform === 'win32' || !existsSync(socketPath)) {
    socket.listen(socketPath)
    return
  }
  const probe = connect(socketPath)
  const settle = (stale: boolean, detail: string): void => {
    probe.destroy()
    if (stale) {
      try {
        unlinkSync(socketPath)
        log('removed stale local socket', { socketPath, detail })
      } catch (err) {
        // Not fatal on its own: listen() below reports the real outcome.
        warn('stale local socket could not be removed', { socketPath, error: String(err) })
      }
    } else {
      warn('local socket is owned by a live process; binding will fail', { socketPath, detail })
      onOwned?.(socketPath)
    }
    socket.listen(socketPath)
  }
  probe.once('connect', () => settle(false, 'probe connected'))
  // Any failure to connect means nothing is serving this path, whatever the
  // reason: ECONNREFUSED for an abandoned socket, ENOTSOCK for a leftover
  // regular file, ENOENT if it vanished since the existsSync above. Only a
  // successful connect proves a live owner, so that is the sole non-stale
  // verdict. The unlink is best-effort either way and `listen()` below is
  // what reports the true outcome.
  probe.once('error', (err: NodeJS.ErrnoException) => settle(true, String(err.code ?? err)))
}

/**
 * Starts the `/healthz` + `/readyz` HTTP endpoints (manifest C14) on plain
 * `http.Server` instances -- this package carries no HTTP framework
 * dependency, matching `remote/lan-server.ts`'s use of the Node builtin.
 *
 * `/healthz` is 200 as long as the process is answering requests at all,
 * independent of readiness -- it distinguishes "the process is dead/hung"
 * from "the process is up but not ready to serve the store/engine wire".
 * `/readyz` reflects whatever `setReadiness()` was last called with; `main.ts`
 * calls it as each boot phase (state files, engine version, engine
 * reachability) resolves.
 */
export function startHealth(opts: HealthOptions = {}): HealthHandle {
  let readiness: ReadinessState = { ready: false, reason: 'engine_unreachable', detail: 'server booting' }
  const handler = makeRequestHandler(() => readiness, opts.routes ?? {}, opts.notFound)
  const servers: Server[] = []
  let tcpServer: Server | null = null
  let localServer: Server | null = null

  if (typeof opts.port === 'number') {
    const tcp = createServer(handler)
    tcp.on('error', (err) => error('tcp health listener error', { port: opts.port, error: String(err) }))
    tcp.listen(opts.port, opts.host)
    tcp.once('listening', () => log('tcp health listener started', { port: opts.port, bind_host: opts.host ?? '(all interfaces)' }))
    servers.push(tcp)
    tcpServer = tcp
  }

  if (opts.socketPath) {
    const socket = createServer(handler)
    socket.on('error', (err) => error('socket health listener error', { socketPath: opts.socketPath, error: String(err) }))
    socket.once('listening', () => log('socket health listener started', { socketPath: opts.socketPath }))
    listenLocal(socket, opts.socketPath, opts.onLocalSocketOwned)
    servers.push(socket)
    localServer = socket
  }

  if (servers.length === 0) {
    warn('startHealth called with neither port nor socketPath; no listener started')
  }

  return {
    servers,
    tcpServer,
    localServer,
    setReadiness(state: ReadinessState): void {
      readiness = state
      log('readiness updated', { ready: state.ready, reason: state.reason, detail: state.detail })
    },
    getReadiness(): ReadinessState {
      return readiness
    },
    close(): Promise<void> {
      return Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve())
            }),
        ),
      ).then(() => undefined)
    },
  }
}
