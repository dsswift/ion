/**
 * Local WebSocket server for direct LAN connections.
 *
 * Advertises via Bonjour/mDNS as _coda._tcp and accepts connections
 * from the iOS companion app on the local network.
 *
 * Supports multiple simultaneous clients (one per paired device).
 */

import { EventEmitter } from 'events'
import { createServer, type Server } from 'http'
import { spawn, type ChildProcess } from 'child_process'
import { hostname } from 'os'
import WebSocket, { WebSocketServer } from 'ws'
import { log as _log } from '../logger'
import type { WireMessage } from './protocol'

function log(msg: string): void {
  _log('LANServer', msg)
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
export class LANServer extends EventEmitter {
  private httpServer: Server | null = null
  private wss: WebSocketServer | null = null
  private clients: Map<string, WebSocket> = new Map()
  private port: number
  private dnssdProc: ChildProcess | null = null
  private nextId = 0

  constructor(options: LANServerOptions = {}) {
    super()
    this.port = options.port || DEFAULT_PORT
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
    this.clients.delete(oldId)
    // If there's already a client with newId, close the old one (latest wins per device).
    const existing = this.clients.get(newId)
    if (existing) {
      log(`replacing existing client for ${newId}`)
      try { existing.close() } catch { /* ignore */ }
    }
    this.clients.set(newId, ws)
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
        // Route /pair connections to the pairing handler.
        if (req.url === '/pair') {
          log(`pairing connection from ${req.socket.remoteAddress}`)
          this._handlePairingConnection(ws)
          return
        }

        const connectionId = `lan-${this.nextId++}`
        this.clients.set(connectionId, ws)
        log(`client connected from ${req.socket.remoteAddress} (${connectionId})`)
        this.emit('raw-client-connected', ws, connectionId)

        ws.on('message', (raw: Buffer | string) => {
          try {
            const wire = JSON.parse(raw.toString()) as WireMessage
            this.emit('message', wire, connectionId)
          } catch (err) {
            log(`parse error: ${(err as Error).message}`)
          }
        })

        ws.on('close', (code: number, reason: Buffer) => {
          if (this.clients.get(connectionId) === ws) {
            this.clients.delete(connectionId)
          }
          // Also check if the ws was re-keyed to a different id.
          for (const [id, client] of this.clients) {
            if (client === ws) {
              this.clients.delete(id)
              log(`client disconnected ${id} (code=${code} reason=${reason.toString()})`)
              this.emit('client-disconnected', id, code, reason.toString())
              return
            }
          }
          log(`client disconnected ${connectionId} (code=${code} reason=${reason.toString()})`)
          this.emit('client-disconnected', connectionId, code, reason.toString())
        })

        ws.on('error', (err) => {
          log(`client error (${connectionId}): ${err.message}`)
        })
      })

      this.httpServer.listen(this.port, () => {
        log(`listening on port ${this.port}`)
        this._advertiseBonjour()
        resolve(this.port)
      })

      this.httpServer.on('error', (err) => {
        log(`server error: ${err.message}`)
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
        log(`send error (${connectionId}): ${(err as Error).message}`)
      }
    } else {
      // Broadcast to all connected clients.
      const data = JSON.stringify(message)
      for (const [id, ws] of this.clients) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(data)
          } catch (err) {
            log(`send error (${id}): ${(err as Error).message}`)
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
      log(`sendRaw error (${connectionId}): ${(err as Error).message}`)
    }
  }

  /** Forcibly disconnect a specific client. */
  disconnectClient(connectionId: string, code: number, reason: string): void {
    const ws = this.clients.get(connectionId)
    if (ws) {
      try { ws.close(code, reason) } catch { /* ignore */ }
      this.clients.delete(connectionId)
      this.emit('client-disconnected', connectionId, code, reason)
    }
  }

  async stop(): Promise<void> {
    this._unadvertiseBonjour()

    for (const [id, ws] of this.clients) {
      try { ws.close() } catch { /* ignore */ }
    }
    this.clients.clear()

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
   *  2. CODA emits 'pair-request' event; the main process validates the code
   *     and calls completePairing() to send the response.
   *  3. CODA sends: { type: "pair_response", publicKey: base64, relayUrl?, relayApiKey? }
   *     OR: { type: "pair_error", message: string }
   */
  private _handlePairingConnection(ws: WebSocket): void {
    ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'pair_request') {
          log(`pair request from ${msg.deviceName}: code=${msg.code}`)
          this.emit('pair-request', {
            code: msg.code,
            publicKey: msg.publicKey,
            deviceName: msg.deviceName,
            recovery: !!msg.recovery,
            respond: (response: Record<string, unknown>) => {
              try {
                ws.send(JSON.stringify(response))
              } catch (err) {
                log(`pair response send error: ${(err as Error).message}`)
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
        log(`pair parse error: ${(err as Error).message}`)
        ws.close()
      }
    })

    ws.on('error', (err) => {
      log(`pair connection error: ${err.message}`)
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
    const name = hostname().replace(/\.local$/, '')
    log(`Bonjour: spawning dns-sd -R ${name} _coda._tcp local ${this.port}`)
    try {
      this.dnssdProc = spawn('/usr/bin/dns-sd', [
        '-R', name, '_coda._tcp', 'local', String(this.port),
      ], { stdio: 'pipe' })

      this.dnssdProc.stdout?.on('data', (data: Buffer) => {
        log(`dns-sd stdout: ${data.toString().trim()}`)
      })

      this.dnssdProc.stderr?.on('data', (data: Buffer) => {
        log(`dns-sd stderr: ${data.toString().trim()}`)
      })

      this.dnssdProc.on('error', (err) => {
        log(`dns-sd spawn error: ${err.message}`)
        this.dnssdProc = null
      })

      this.dnssdProc.on('exit', (code, signal) => {
        log(`dns-sd exited: code=${code} signal=${signal}`)
        this.dnssdProc = null
      })

      log(`Bonjour: advertising ${name}._coda._tcp on port ${this.port} (pid=${this.dnssdProc.pid})`)
    } catch (err) {
      log(`Bonjour unavailable: ${(err as Error).message}`)
    }
  }

  private _unadvertiseBonjour(): void {
    if (this.dnssdProc) {
      this.dnssdProc.kill()
      this.dnssdProc = null
    }
  }
}
