/**
 * Local WebSocket server for direct LAN connections.
 *
 * Advertises via Bonjour/mDNS as _ion._tcp and accepts connections
 * from the iOS companion app on the local network.
 *
 * Supports multiple simultaneous clients (one per paired device).
 */

import { EventEmitter } from 'events'
import { createServer, type Server } from 'http'
import { execSync, spawn, type ChildProcess } from 'child_process'
import { hostname } from 'os'
import WebSocket, { WebSocketServer } from 'ws'
import { log as _log } from '../logger'
import type { WireMessage } from './protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('LANServer', msg, fields)
}

const DEFAULT_PORT = 19837

export interface LANServerOptions {
  port?: number
}

/**
 * Events:
 *  - 'message' (data: WireMessage, connectionId: string) -- incoming message from iOS client
 *  - 'raw-client-connected' (ws: WebSocket, connectionId: string) -- new client, before auth
 *  - 'client-disconnected' (connectionId: string, code: number, reason: string) -- client left
 *  - 'pair-request' -- pairing request from iOS
 */
// Per-IP exponential backoff for failed auth attempts. Stops a stale
// device on the LAN from reconnecting in a tight loop and flooding the log.
// Backoff schedule: 1s, 5s, 30s, 5min cap. Reset on first successful auth.
const AUTH_BACKOFF_STEPS_MS: number[] = [1_000, 5_000, 30_000, 300_000]

interface AuthFailureRecord {
  failCount: number
  blockUntil: number
  // Last time we logged a block message for this IP. Used to throttle log
  // output to one line per cooldown window.
  lastLoggedAt: number
}

export class LANServer extends EventEmitter {
  private httpServer: Server | null = null
  private wss: WebSocketServer | null = null
  private clients: Map<string, WebSocket> = new Map()
  private clientIps: Map<string, string> = new Map()
  private port: number
  private dnssdProc: ChildProcess | null = null
  private nextId = 0
  private failedAuth: Map<string, AuthFailureRecord> = new Map()

  constructor(options: LANServerOptions = {}) {
    super()
    this.port = options.port || DEFAULT_PORT
  }

  /** Returns ms remaining until this IP can attempt auth again, or 0 if not blocked. */
  private blockedRemaining(ip: string): number {
    const rec = this.failedAuth.get(ip)
    if (!rec) return 0
    const remaining = rec.blockUntil - Date.now()
    if (remaining <= 0) return 0
    return remaining
  }

  /** Record an auth failure from this IP. Bumps failCount and extends blockUntil. */
  recordAuthFailure(ip: string): void {
    if (!ip) return
    const now = Date.now()
    const rec = this.failedAuth.get(ip) ?? { failCount: 0, blockUntil: 0, lastLoggedAt: 0 }
    rec.failCount += 1
    const stepIdx = Math.min(rec.failCount - 1, AUTH_BACKOFF_STEPS_MS.length - 1)
    rec.blockUntil = now + AUTH_BACKOFF_STEPS_MS[stepIdx]
    this.failedAuth.set(ip, rec)
  }

  /** Clear backoff state for this IP after a successful auth. */
  recordAuthSuccess(ip: string): void {
    if (!ip) return
    this.failedAuth.delete(ip)
  }

  /** Look up the originating IP for a connection (set on connect). */
  getClientIp(connectionId: string): string | undefined {
    return this.clientIps.get(connectionId)
  }

  get connected(): boolean {
    return this.clients.size > 0
  }

  /** Get the number of connected clients. */
  get clientCount(): number {
    return this.clients.size
  }

  /** Check if a specific client is connected and open. */
  hasClient(connectionId: string): boolean {
    const ws = this.clients.get(connectionId)
    return ws !== undefined && ws.readyState === WebSocket.OPEN
  }

  /** Re-key a client from one connectionId to another (e.g. temp -> deviceId after auth). */
  rekeyClient(oldId: string, newId: string): void {
    const ws = this.clients.get(oldId)
    if (!ws) return
    const ip = this.clientIps.get(oldId)
    this.clients.delete(oldId)
    this.clientIps.delete(oldId)
    // If there's already a client with newId, close the old one (latest wins per device).
    const existing = this.clients.get(newId)
    if (existing) {
      log('lan_server: replacing existing client', { device_id: newId })
      try { existing.close() } catch { /* ignore */ }
      this.clientIps.delete(newId)
    }
    this.clients.set(newId, ws)
    if (ip) this.clientIps.set(newId, ip)
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer((req, res) => {
        // Only WebSocket upgrade requests are handled by wss.
        res.writeHead(404)
        res.end()
      })

      this.wss = new WebSocketServer({ server: this.httpServer })

      this.wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress || 'unknown'

        // Route /pair connections to the pairing handler.
        if (req.url === '/pair') {
          log('lan_server: pairing connection', { ip })
          this._handlePairingConnection(ws, ip)
          return
        }

        // Reject connections from IPs in auth-failure cooldown without
        // running the handshake. This stops a stale device from reconnecting
        // every ~500ms and flooding the log.
        const remaining = this.blockedRemaining(ip)
        if (remaining > 0) {
          const rec = this.failedAuth.get(ip)
          const now = Date.now()
          // Log at most once per cooldown window to keep the noise floor low.
          if (rec && now - rec.lastLoggedAt > 60_000) {
            log('lan_server: auth-blocked', { ip, fail_count: rec.failCount, remaining_s: Math.ceil(remaining / 1000) })
            rec.lastLoggedAt = now
          }
          try { ws.close(1008, `auth cooldown ${Math.ceil(remaining / 1000)}s`) } catch { /* ignore */ }
          return
        }

        const connectionId = `lan-${this.nextId++}`
        this.clients.set(connectionId, ws)
        this.clientIps.set(connectionId, ip)
        log('lan_server: client connected', { ip, connection_id: connectionId })
        this.emit('raw-client-connected', ws, connectionId)

        ws.on('message', (raw: Buffer | string) => {
          try {
            const wire = JSON.parse(raw.toString()) as WireMessage
            this.emit('message', wire, connectionId)
          } catch (err) {
            log('lan_server: parse error', { error: (err as Error).message })
          }
        })

        ws.on('close', (code: number, reason: Buffer) => {
          if (this.clients.get(connectionId) === ws) {
            this.clients.delete(connectionId)
            this.clientIps.delete(connectionId)
          }
          // Also check if the ws was re-keyed to a different id.
          for (const [id, client] of this.clients) {
            if (client === ws) {
              this.clients.delete(id)
              this.clientIps.delete(id)
              log('lan_server: client disconnected (authenticated)', { device_id: id, code, reason: reason.toString() })
              this.emit('client-disconnected', id, code, reason.toString())
              return
            }
          }
          log('lan_server: client disconnected (unauthenticated)', { connection_id: connectionId, code, reason: reason.toString() })
          this.emit('client-disconnected', connectionId, code, reason.toString())
        })

        ws.on('error', (err) => {
          log('lan_server: client error', { connection_id: connectionId, error: err.message })
        })
      })

      this.httpServer.listen(this.port, () => {
        log('lan_server: listening', { port: this.port })
        this._advertiseBonjour()
        resolve(this.port)
      })

      this.httpServer.on('error', (err) => {
        log('lan_server: server error', { error: err.message })
        reject(err)
      })
    })
  }

  /** Send a WireMessage to a specific client or broadcast to all. */
  send(message: WireMessage, connectionId?: string): void {
    if (connectionId) {
      const ws = this.clients.get(connectionId)
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(JSON.stringify(message))
      } catch (err) {
        log('lan_server: send error', { connection_id: connectionId, error: (err as Error).message })
      }
    } else {
      // Broadcast to all connected clients.
      const data = JSON.stringify(message)
      for (const [id, ws] of this.clients) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(data)
          } catch (err) {
            log('lan_server: sendAll error', { device_id: id, error: (err as Error).message })
          }
        }
      }
    }
  }

  /** Send a raw string to a specific client (for auth handshake messages). */
  sendRaw(data: string, connectionId: string): void {
    const ws = this.clients.get(connectionId)
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(data)
    } catch (err) {
      log('lan_server: sendRaw error', { connection_id: connectionId, error: (err as Error).message })
    }
  }

  /** Forcibly disconnect a specific client. */
  disconnectClient(connectionId: string, code: number, reason: string): void {
    const ws = this.clients.get(connectionId)
    if (ws) {
      try { ws.close(code, reason) } catch { /* ignore */ }
      this.clients.delete(connectionId)
      // Removing from `clients` first means the ws 'close' handler's rekey
      // scan won't find this socket, so its clientIps entry would leak for
      // the life of the process — delete it here.
      this.clientIps.delete(connectionId)
      this.emit('client-disconnected', connectionId, code, reason)
    }
  }

  async stop(): Promise<void> {
    this._unadvertiseBonjour()

    for (const [_id, ws] of this.clients) {
      try { ws.close() } catch { /* ignore */ }
    }
    this.clients.clear()
    this.failedAuth.clear()

    if (this.wss) {
      this.wss.close()
      this.wss = null
    }

    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => {
          this.httpServer = null
          log('stopped')
          resolve()
        })
      } else {
        resolve()
      }
    })
  }

  /**
   * Handle a /pair WebSocket connection for key exchange.
   *
   * Protocol:
   *  1. iOS sends: { type: "pair_request", code: string, publicKey: base64, deviceName: string }
   *  2. Ion emits 'pair-request' event; the main process validates the code
   *     and calls completePairing() to send the response.
   *  3. Ion sends: { type: "pair_response", publicKey: base64, relayUrl?, relayApiKey? }
   *     OR: { type: "pair_error", message: string }
   */
  private _handlePairingConnection(ws: WebSocket, ip = ''): void {
    ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'pair_request') {
          log('lan_server: pair request', { device_name: msg.deviceName, code: msg.code })
          this.emit('pair-request', {
            code: msg.code,
            publicKey: msg.publicKey,
            deviceName: msg.deviceName,
            recovery: !!msg.recovery,
            respond: (response: Record<string, unknown>) => {
              // A successful pairing (response carries the desktop public key)
              // proves the peer at this IP is legitimate — clear any auth
              // cooldown accrued from its previous (now-revoked) identity.
              // Without this, the just-paired device's /ws auth connection is
              // rejected by the cooldown gate (close 1008) and the client
              // sees an immediate auth failure right after entering the PIN.
              if (response.publicKey) {
                this.recordAuthSuccess(ip)
                log('lan_server: pair success, cleared auth cooldown', { ip })
              }
              try {
                ws.send(JSON.stringify(response))
              } catch (err) {
                log('lan_server: pair response send error', { error: (err as Error).message })
              }
              // Close the pairing connection after responding.
              setTimeout(() => ws.close(), 500)
            },
            reject: (message: string) => {
              try {
                ws.send(JSON.stringify({ type: 'pair_error', message }))
              } catch {}
              ws.close()
            },
          })
        }
      } catch (err) {
        log('lan_server: pair parse error', { error: (err as Error).message })
        ws.close()
      }
    })

    ws.on('error', (err) => {
      log('lan_server: pair connection error', { error: err.message })
    })

    // Timeout: close if no pair_request within 30 seconds.
    const timeout = setTimeout(() => {
      log('pair connection timed out')
      ws.close()
    }, 30000)

    ws.on('close', () => {
      clearTimeout(timeout)
    })
  }

  private _advertiseBonjour(): void {
    // Use macOS dns-sd to register through the system's mDNSResponder.
    // This is the only reliable way to be visible to Apple's NWBrowser.
    //
    // Kill any orphaned dns-sd processes from prior app instances first.
    // When the app is force-killed or crashes, _unadvertiseBonjour never
    // runs and the old dns-sd child lives on. Hundreds of stale registrations
    // confuse mDNSResponder and make the service undiscoverable on iOS.
    this._killOrphanedDnssd()

    const name = hostname().replace(/\.local$/, '')
    log('lan_server: bonjour spawning dns-sd', { name, port: this.port })
    try {
      this.dnssdProc = spawn('/usr/bin/dns-sd', [
        '-R', name, '_ion._tcp', 'local', String(this.port),
      ], { stdio: 'pipe' })

      this.dnssdProc.stdout?.on('data', (data: Buffer) => {
        log('lan_server: dns-sd stdout', { data: data.toString().trim() })
      })

      this.dnssdProc.stderr?.on('data', (data: Buffer) => {
        log('lan_server: dns-sd stderr', { data: data.toString().trim() })
      })

      this.dnssdProc.on('error', (err) => {
        log('lan_server: dns-sd spawn error', { error: err.message })
        this.dnssdProc = null
      })

      this.dnssdProc.on('exit', (code, signal) => {
        log('lan_server: dns-sd exited', { code, signal })
        this.dnssdProc = null
      })

      log('lan_server: bonjour advertising', { name, port: this.port, pid: this.dnssdProc.pid })
    } catch (err) {
      log('lan_server: bonjour unavailable', { error: (err as Error).message })
    }
  }

  /**
   * Kill orphaned dns-sd processes from previous app instances.
   * Spares the process we own (this.dnssdProc) if one exists.
   */
  private _killOrphanedDnssd(): void {
    try {
      const myPid = this.dnssdProc?.pid
      const raw = execSync(
        'pgrep -f "dns-sd -R .* _ion._tcp"',
        { encoding: 'utf8', timeout: 3000 },
      ).trim()
      if (!raw) return
      const pids = raw.split('\n').map(Number).filter(Boolean)
      let killed = 0
      for (const pid of pids) {
        if (pid === myPid) continue
        try {
          process.kill(pid, 'SIGTERM')
          killed++
        } catch { /* already dead */ }
      }
      if (killed > 0) {
        log('lan_server: bonjour killed orphaned dns-sd', { count: killed })
      }
    } catch {
      // pgrep returns exit code 1 when no matches — expected on fresh start.
    }
  }

  private _unadvertiseBonjour(): void {
    if (this.dnssdProc) {
      this.dnssdProc.kill()
      this.dnssdProc = null
    }
  }
}
