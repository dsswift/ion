/**
 * sealed-socket -- one socket whose every frame is an end-to-end envelope.
 *
 * A paired client and this server share a secret from pairing. `SealedSocket`
 * presents the plain `ConnectionSocket` surface `Connection` expects while
 * sealing every outbound frame and opening every inbound one with that secret
 * (`@ion/shared/studio-wire/relay-envelope`, AES-256-GCM). Text and binary
 * frames both travel sealed.
 *
 * Two carriers move the envelopes, and they are the only difference between
 * the two sealed transports:
 *
 *  - a relay channel (`relayCarrier`), where the relay forwards ciphertext it
 *    cannot read;
 *  - a plain TCP WebSocket (`wsCarrier`), where nothing else protects the
 *    session: the listener speaks `ws://`, so without the envelope every
 *    event, message body, and terminal byte would cross the LAN in cleartext.
 *
 * One sealing implementation for both, so the two cannot drift apart in what
 * they protect or in how they treat a frame that fails to open: it is dropped
 * and logged, never delivered.
 */
import { EventEmitter } from 'events'
import type { WebSocket } from 'ws'
import { sealRelayFrame, openRelayFrame } from '@ion/shared/studio-wire/relay-envelope'
import type { ConnectionSocket } from './connection-socket'
import type { RelayClient } from '../remote/relay-client'
import type { WireMessage } from '../remote/protocol-envelope'
import { warn as _warn } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('sealed-socket', msg, fields)
}

/** What moves envelope text for a `SealedSocket`. */
export interface EnvelopeCarrier {
  /** Names the carrier in logs: `relay` or `tcp`. */
  readonly kind: 'relay' | 'tcp'
  sendEnvelope(text: string, cb?: (err?: Error) => void): void
  onEnvelope(listener: (text: string) => void): void
  onClosed(listener: (code: number, reason: string) => void): void
  onError(listener: (err: Error) => void): void
  close(code: number, reason: string): void
  terminate(): void
  /** Probes liveness; `onPong` fires when the peer (or the carrier's own keepalive) answers. */
  ping(onPong: () => void): void
}

/**
 * A relay channel as a carrier. The `RelayClient` is owned by the relay
 * listener and outlives any one `Connection`, so closing the sealed socket
 * does not close the channel; and the client keeps its own WebSocket alive
 * with the relay, so a heartbeat is answered locally -- a dead channel
 * surfaces as `disconnected` instead, and relay latency is never mistaken for
 * a vanished peer.
 */
export function relayCarrier(relay: RelayClient): EnvelopeCarrier {
  return {
    kind: 'relay',
    sendEnvelope(text, cb) {
      try {
        relay.send(JSON.parse(text) as WireMessage, cb)
      } catch (err) {
        cb?.(err instanceof Error ? err : new Error(String(err)))
      }
    },
    onEnvelope: (listener) => { relay.on('message', (message: unknown) => listener(JSON.stringify(message))) },
    onClosed: (listener) => { relay.on('disconnected', () => listener(1006, 'relay channel disconnected')) },
    onError: () => { /* the RelayClient logs and reconnects on its own errors */ },
    close: () => { /* the channel belongs to the relay listener, not to this socket */ },
    terminate: () => { /* as above */ },
    ping: (onPong) => queueMicrotask(onPong),
  }
}

/** A plain WebSocket as a carrier: envelopes ride as text frames. */
export function wsCarrier(ws: WebSocket): EnvelopeCarrier {
  let pong: (() => void) | null = null
  ws.on('pong', () => pong?.())
  return {
    kind: 'tcp',
    sendEnvelope: (text, cb) => ws.send(text, cb),
    onEnvelope: (listener) => {
      ws.on('message', (data: Buffer | string, isBinary: boolean) => {
        // An envelope is always text. A raw binary frame on a sealed socket
        // was not sealed by anyone, so it is not delivered.
        if (isBinary) {
          warn('unsealed binary frame dropped on a sealed tcp socket')
          return
        }
        listener(data.toString())
      })
    },
    onClosed: (listener) => { ws.on('close', (code: number, reason: Buffer) => listener(code, reason.toString('utf-8'))) },
    onError: (listener) => { ws.on('error', listener) },
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
    ping: (onPong) => {
      pong = onPong
      ws.ping()
    },
  }
}

export class SealedSocket extends EventEmitter implements ConnectionSocket {
  private closed = false

  constructor(private readonly carrier: EnvelopeCarrier, private readonly sharedSecret: Buffer, private readonly clientId: string) {
    super()
    carrier.onEnvelope((text) => this.onEnvelope(text))
    carrier.onClosed((code, reason) => this.emitClose(code, reason))
    carrier.onError((err) => this.emit('error', err))
  }

  private onEnvelope(text: string): void {
    const opened = openRelayFrame(text, this.sharedSecret)
    if (!opened) {
      warn('frame dropped: not an envelope for this client, or failed to open', { client_id: this.clientId, carrier: this.carrier.kind })
      return
    }
    this.emit('message', opened.bytes, opened.isBinary)
  }

  send(data: string | Buffer, cb?: (err?: Error) => void): void {
    if (this.closed) {
      cb?.(new Error('sealed socket is closed'))
      return
    }
    try {
      this.carrier.sendEnvelope(sealRelayFrame(typeof data === 'string' ? data : new Uint8Array(data), this.sharedSecret), cb)
    } catch (err) {
      cb?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  close(code = 1000, reason = ''): void {
    this.carrier.close(code, reason)
    this.emitClose(code, reason)
  }

  terminate(): void {
    this.carrier.terminate()
    this.emitClose(1006, 'terminated')
  }

  ping(): void {
    this.carrier.ping(() => this.emit('pong'))
  }

  private emitClose(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', code, Buffer.from(reason))
  }
}
