/**
 * Port Forward — a loopback port on a client's machine that reaches a
 * loopback port on an Environment's host, carried over the Studio connection
 * the client already holds to that Environment.
 *
 * The client listens locally. Each connection it accepts becomes one stream:
 * the client picks a stream id, asks the server to dial the port
 * (`port.open`), and the two ends exchange the stream's bytes as binary
 * frames keyed by that id (`BinaryChannel.PORT_*`).
 *
 * Both ends run the same `PortStream`, each over its own socket. A stream
 * never sends more than the other end has said it can take: every stream
 * starts with `PORT_STREAM_WINDOW_BYTES` of credit in each direction, the
 * sender stops reading its socket when the credit is spent, and the receiver
 * grants more only after its own socket has taken the bytes. A slow reader at
 * either end therefore slows the writer at the far end, instead of filling
 * the Studio connection the rest of the client depends on.
 */

/** The `studio_welcome` capability a server that answers `port.*` advertises. */
export const PORT_FORWARD_CAPABILITY = 'port-forward'

/** Bytes a stream may send before the receiver grants more. */
export const PORT_STREAM_WINDOW_BYTES = 256 * 1024

/** Delivered bytes a receiver collects before it grants them back. */
const CREDIT_GRANT_BYTES = PORT_STREAM_WINDOW_BYTES / 4

/** The one-byte `PORT_END` payload that means "abandoned", not "finished". */
export const PORT_END_ABORT = 1

export function isForwardablePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536
}

export function encodePortCredit(bytes: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, bytes)
  return out
}

/** The byte count a `PORT_CREDIT` payload grants, or null when it is malformed. */
export function decodePortCredit(payload: Uint8Array): number | null {
  if (payload.length !== 4) return null
  return new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0)
}

/** `port.open` argument: dial `port` on the server's loopback for the stream `streamId`. */
export interface PortOpenRequest {
  streamId: string
  port: number
}

/** One TCP port something on an Environment's host is listening on (`port.listeners`). */
export interface PortListener {
  port: number
  pid: number | null
  processName: string | null
  /** The conversation whose Terminal owns the listening process, when one does and the caller may see it. */
  tabId: string | null
  /** The Web Application URL confirmed for this port, when there is one. */
  url: string | null
}

/** One active Port Forward on this client. */
export interface PortForward {
  environmentId: string
  remotePort: number
  /** The loopback port on this machine. The remote port's own number when it was free here. */
  localPort: number
  activeStreams: number
}

export type PortForwardStartResult = { ok: true; forward: PortForward } | { ok: false; error: string }

/** The same URL, pointed at the local end of a Port Forward. */
export function forwardedUrl(url: string, forward: Pick<PortForward, 'localPort'>): string {
  const parsed = new URL(url)
  parsed.hostname = 'localhost'
  parsed.port = String(forward.localPort)
  return parsed.toString()
}

/** The port a loopback `http(s)` URL names, or null when it is not a loopback URL. */
export function loopbackUrlPort(url: string): number | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // silent-ok: a string that is not a URL names no port; the caller treats null as "not forwardable".
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(parsed.hostname)) return null
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  return isForwardablePort(port) ? port : null
}

/**
 * What a stream needs from its socket. A `net.Socket` satisfies it. The
 * socket must be half-open capable (`allowHalfOpen`): one direction finishing
 * must not close the other, or a peer that stops sending before it has read
 * its answer loses the answer.
 */
export interface PortStreamSocket {
  pause(): unknown
  resume(): unknown
  write(data: Uint8Array, cb?: (err?: Error | null) => void): boolean
  end(): unknown
  destroy(): unknown
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown
  on(event: 'end' | 'close', listener: () => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
}

/** How a stream reaches the other end. */
export interface PortStreamWire {
  /** Sends bytes. Resolves (or returns) false when the connection can no longer carry the stream. A promise holds further reads until it settles. */
  data(payload: Uint8Array): boolean | Promise<boolean>
  credit(bytes: number): void
  end(aborted: boolean): void
}

export interface PortStreamOutcome {
  /** `completed`: both directions finished. `aborted`: anything else. */
  outcome: 'completed' | 'aborted'
  reason: string
  bytesSent: number
  bytesReceived: number
}

export class PortStream {
  private sendWindow = PORT_STREAM_WINDOW_BYTES
  private uncredited = 0
  private sending = false
  private started = false
  private localEnded = false
  private remoteEnded = false
  private closed = false
  private bytesSent = 0
  private bytesReceived = 0

  constructor(
    private readonly socket: PortStreamSocket,
    private readonly wire: PortStreamWire,
    private readonly onClosed: (outcome: PortStreamOutcome) => void,
  ) {
    socket.on('error', (err) => this.finish('aborted', `socket error: ${err.message}`, true))
    socket.on('close', () => {
      if (this.localEnded && this.remoteEnded) this.finish('completed', 'both directions finished', false)
      else this.finish('aborted', 'socket closed before both directions finished', true)
    })
  }

  /** Starts reading the socket. Bytes from the other end are written from construction on. */
  start(): void {
    if (this.started || this.closed) return
    this.started = true
    this.socket.on('data', (chunk) => this.sendChunk(chunk))
    this.socket.on('end', () => {
      if (this.closed) return
      this.localEnded = true
      this.wire.end(false)
    })
    this.socket.resume()
  }

  private sendChunk(chunk: Uint8Array): void {
    if (this.closed) return
    // Paused until this chunk has left and there is credit for another.
    this.socket.pause()
    this.sending = true
    this.sendWindow -= chunk.length
    this.bytesSent += chunk.length
    const sent = this.wire.data(chunk)
    if (typeof sent === 'boolean') this.afterSend(sent)
    else sent.then((ok) => this.afterSend(ok), () => this.afterSend(false))
  }

  private afterSend(ok: boolean): void {
    this.sending = false
    if (!ok) {
      this.finish('aborted', 'the connection stopped carrying the stream', false)
      return
    }
    this.resumeIfClear()
  }

  private resumeIfClear(): void {
    if (this.closed || !this.started || this.sending || this.sendWindow <= 0) return
    this.socket.resume()
  }

  /** `PORT_DATA` from the other end. */
  receiveData(payload: Uint8Array): void {
    if (this.closed || this.remoteEnded) return
    this.bytesReceived += payload.length
    this.socket.write(payload, (err) => {
      if (err || this.closed) return
      this.uncredited += payload.length
      if (this.uncredited < CREDIT_GRANT_BYTES) return
      this.wire.credit(this.uncredited)
      this.uncredited = 0
    })
  }

  /** `PORT_CREDIT` from the other end. */
  receiveCredit(bytes: number): void {
    this.sendWindow += bytes
    this.resumeIfClear()
  }

  /** `PORT_END` from the other end. */
  receiveEnd(aborted: boolean): void {
    if (this.closed) return
    if (aborted) {
      this.finish('aborted', 'the other end abandoned the stream', false)
      return
    }
    this.remoteEnded = true
    this.socket.end()
  }

  /** Ends the stream from this side and tells the other end. */
  abort(reason: string): void {
    this.finish('aborted', reason, true)
  }

  /** Ends the stream when there is no connection left to tell. */
  drop(reason: string): void {
    this.finish('aborted', reason, false)
  }

  private finish(outcome: PortStreamOutcome['outcome'], reason: string, tellPeer: boolean): void {
    if (this.closed) return
    this.closed = true
    if (tellPeer) this.wire.end(true)
    this.socket.destroy()
    this.onClosed({ outcome, reason, bytesSent: this.bytesSent, bytesReceived: this.bytesReceived })
  }
}
