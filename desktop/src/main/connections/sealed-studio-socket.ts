/**
 * sealed-studio-socket -- a WebSocket whose every frame is an end-to-end
 * envelope, wearing the small socket surface the broker drives.
 *
 * A paired client and its server share a secret from pairing. Every frame
 * either way is an AES-256-GCM envelope (`@ion/shared/studio-wire/
 * relay-envelope`) sealed with it. Two transports use this one class:
 *
 *  - a relay channel (`transport-relay.ts`), where the relay forwards
 *    ciphertext it cannot read;
 *  - a direct TCP connection (`transport-tcp.ts`), where nothing else
 *    protects the session: the server's listener speaks `ws://`, so without
 *    the envelope the whole conversation crosses the LAN in cleartext.
 *
 * A frame that fails to open is dropped and logged, never delivered.
 */
import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { sealRelayFrame, openRelayFrame } from '@ion/shared/studio-wire/relay-envelope'
import { keepSocketAlive } from './socket-keepalive'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('connections-sealed-socket', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('connections-sealed-socket', msg, fields)
}

/** What the broker needs from a socket; a `ws` WebSocket satisfies it, and so does `SealedStudioSocket`. */
export interface StudioSocketLike {
  readonly readyState: number
  readonly OPEN: number
  send(data: string | Uint8Array): void
  /**
   * Sends one frame with a W3C traceparent beside it, on transports that
   * have somewhere to put it (a relay envelope). Optional: a plain socket
   * has no envelope and sends the frame as `send` would.
   */
  sendTraced?(data: string, traceparent: string): void
  close(code?: number, reason?: string): void
  once(event: 'open', listener: () => void): this
  once(event: 'close', listener: (code: number, reason: Buffer) => void): this
  once(event: 'error', listener: (err: Error) => void): this
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): this
}

export interface SealedStudioSocketOptions {
  /** Names the far end in logs (a relay url, a server url). Never a secret. */
  label: string
  /** A relay speaks a few plaintext `relay:*` control frames to the joining side; they are not envelopes. */
  skipRelayControlFrames?: boolean
}

export class SealedStudioSocket extends EventEmitter implements StudioSocketLike {
  readonly OPEN = WebSocket.OPEN
  private closedByCaller = false

  constructor(private readonly ws: WebSocket, private readonly sharedSecret: Buffer, private readonly options: SealedStudioSocketOptions) {
    super()
    keepSocketAlive(ws, options.label)
    ws.once('open', () => this.emit('open'))
    ws.on('message', (raw: Buffer | string) => this.onRaw(raw))
    ws.once('close', (code: number, reason: Buffer) => this.emit('close', code, reason))
    ws.once('error', (err: Error) => {
      // Closing a socket that has not opened yet makes `ws` report the
      // aborted handshake as an error. The caller asked for that close, so
      // it is not a failure to report -- and with no listener left it would
      // surface as an uncaught exception in the main process.
      if (this.closedByCaller) {
        log('sealed socket closed before it opened', { peer: options.label })
        return
      }
      this.emit('error', err)
    })
  }

  get readyState(): number {
    return this.ws.readyState
  }

  private onRaw(raw: Buffer | string): void {
    const text = raw.toString()
    if (this.options.skipRelayControlFrames && /^\s*\{\s*"type"\s*:\s*"relay:/.test(text)) {
      log('relay control frame', { peer: this.options.label, head: text.slice(0, 60) })
      return
    }
    const opened = openRelayFrame(text, this.sharedSecret)
    if (!opened) {
      warn('frame dropped: not an envelope for this pairing, or failed to open', { peer: this.options.label })
      return
    }
    this.emit('message', opened.bytes, opened.isBinary)
  }

  send(data: string | Uint8Array): void {
    this.ws.send(sealRelayFrame(data, this.sharedSecret))
  }

  /** The traceparent rides the outer envelope, in plaintext, for the relay's `relay.forward` span. */
  sendTraced(data: string, traceparent: string): void {
    this.ws.send(sealRelayFrame(data, this.sharedSecret, undefined, traceparent))
  }

  close(code?: number, reason?: string): void {
    this.closedByCaller = true
    this.ws.close(code, reason)
  }
}
