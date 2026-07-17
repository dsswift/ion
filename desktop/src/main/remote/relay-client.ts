/**
 * Outbound WebSocket client to the relay server.
 *
 * Connects to: wss://relay.example.com/v1/channel/{channelId}?role=ion
 * Auth: Authorization: Bearer {apiKey}
 *
 * Handles reconnection with exponential backoff. Wire sequence numbering is
 * owned by RemoteTransport (per-device counters); this client only ships
 * pre-built frames.
 */

import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { log as _log } from '../logger'
import type { WireMessage, RelayControlMessage } from './protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RelayClient', msg, fields)
}

const BACKOFF_BASE = 1000
const BACKOFF_MAX = 30000
const JITTER_MAX = 1000

export interface RelayClientOptions {
  relayUrl: string
  apiKey: string
  channelId: string
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
    this._doConnect()
  }

  private _doConnect(): void {
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }

    const { relayUrl, apiKey, channelId } = this.options

    // Normalize URL: ensure wss:// or ws:// prefix and /v1/channel/ path.
    let base = relayUrl.replace(/\/$/, '')
    if (!base.startsWith('ws://') && !base.startsWith('wss://')) {
      // Convert https:// to wss:// or http:// to ws://
      base = base.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://')
    }
    const url = `${base}/v1/channel/${channelId}?role=ion`

    log('relay_client: connecting', { url: url.replace(/\/v1\/channel\/.*/, '/v1/channel/***') })

    this.ws = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    })

    this.ws.on('open', () => {
      log('connected')
      this._connected = true
      this.reconnectAttempt = 0
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

      if (!this.intentionallyClosed) {
        this._scheduleReconnect()
      }
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

  private _scheduleReconnect(): void {
    const delay = Math.min(
      BACKOFF_BASE * Math.pow(2, this.reconnectAttempt),
      BACKOFF_MAX
    ) + Math.random() * JITTER_MAX

    log('relay_client: reconnecting', { delay_ms: Math.round(delay), attempt: this.reconnectAttempt + 1 })
    this.reconnectAttempt++

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this._doConnect()
    }, delay)
  }
}
