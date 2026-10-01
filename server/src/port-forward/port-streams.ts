/**
 * port-streams — the server end of a Port Forward (`@ion/shared/port-forward`).
 *
 * A client asks for a stream to a port on this host (`port.open`). The server
 * dials that port on loopback, and from then on the stream's bytes travel as
 * `PORT_*` binary frames keyed by the stream id the client chose. Streams
 * belong to the connection that opened them and end with it.
 *
 * Only loopback is dialed. A Port Forward reaches what a Terminal on this
 * host could already reach at `localhost`, and nothing else.
 */
import net from 'net'
import { BinaryChannel } from '@ion/shared/studio-wire/channels'
import { PortStream, decodePortCredit, encodePortCredit, isForwardablePort, PORT_END_ABORT } from '@ion/shared/port-forward'
import { connectionRegistry } from '../protocol/connection'
import { log as _log, warn as _warn, debug as _debug } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('port-forward', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('port-forward', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('port-forward', msg, fields)
}

/** What a stream needs from the connection that carries it. `Connection` satisfies it. */
export interface PortStreamCarrier {
  readonly id: string
  sendBinaryPaced(channel: BinaryChannel, key: string, payload: Uint8Array): Promise<boolean>
}

/** A page loads from several origins at once, a handful of connections each; this is far above that and still bounds what one client can hold open. */
export const MAX_PORT_STREAMS_PER_CONNECTION = 256
const DIAL_TIMEOUT_MS = 5_000

export type PortOpenOutcome = { ok: true } | { ok: false; code: string; message: string }

/** Per connection, each stream by id. `null` while its port is still being dialed. */
const streamsByConnection = new Map<string, Map<string, PortStream | null>>()
let removalHooked = false

function dial(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, allowHalfOpen: true })
    const onError = (err: Error): void => {
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }
    const timer = setTimeout(() => onError(new Error(`no answer within ${DIAL_TIMEOUT_MS}ms`)), DIAL_TIMEOUT_MS)
    socket.once('error', onError)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.off('error', onError)
      resolve(socket)
    })
  })
}

/** A service may listen on either loopback family, so both are tried. */
async function dialLoopback(port: number): Promise<net.Socket> {
  try {
    return await dial('127.0.0.1', port)
  } catch (v4) {
    try {
      return await dial('::1', port)
    } catch (v6) {
      throw new Error(`127.0.0.1: ${v4 instanceof Error ? v4.message : String(v4)}; ::1: ${v6 instanceof Error ? v6.message : String(v6)}`)
    }
  }
}

/** Dials `port` on loopback for `conn` and starts the stream `streamId`. */
export async function openPortStream(conn: PortStreamCarrier, streamId: unknown, port: unknown): Promise<PortOpenOutcome> {
  if (typeof streamId !== 'string' || streamId === '' || !isForwardablePort(port)) {
    warn('port stream refused: malformed request', { connection_id: conn.id })
    return { ok: false, code: 'bad_request', message: 'port.open needs a streamId and a port between 1 and 65535' }
  }
  if (!removalHooked) {
    removalHooked = true
    connectionRegistry.onRemove((removed) => closePortStreamsForConnection(removed.id, 'connection closed'))
  }
  const streams = streamsByConnection.get(conn.id) ?? new Map<string, PortStream | null>()
  streamsByConnection.set(conn.id, streams)
  if (streams.has(streamId)) {
    warn('port stream refused: id already in use', { connection_id: conn.id, stream_id: streamId, port })
    return { ok: false, code: 'stream_exists', message: `stream ${streamId} is already open` }
  }
  if (streams.size >= MAX_PORT_STREAMS_PER_CONNECTION) {
    warn('port stream refused: connection is at its stream limit', { connection_id: conn.id, stream_id: streamId, port, open_streams: streams.size })
    return { ok: false, code: 'too_many_streams', message: `this connection already has ${streams.size} port streams open` }
  }
  streams.set(streamId, null)

  let socket: net.Socket
  try {
    socket = await dialLoopback(port)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    streamsByConnection.get(conn.id)?.delete(streamId)
    log('port stream not opened: nothing answered on the port', { connection_id: conn.id, stream_id: streamId, port, reason })
    return { ok: false, code: 'connect_failed', message: `nothing answered on port ${port} of this host (${reason})` }
  }
  // The client gave up, or its connection ended, while the port was being dialed.
  const current = streamsByConnection.get(conn.id)
  if (!current || current.get(streamId) !== null) {
    socket.destroy()
    log('port stream abandoned while dialing', { connection_id: conn.id, stream_id: streamId, port })
    return { ok: false, code: 'cancelled', message: 'the stream was abandoned before the port answered' }
  }

  const stream = new PortStream(
    socket,
    {
      data: (payload) => conn.sendBinaryPaced(BinaryChannel.PORT_DATA, streamId, payload),
      credit: (bytes) => void conn.sendBinaryPaced(BinaryChannel.PORT_CREDIT, streamId, encodePortCredit(bytes)),
      end: (aborted) => void conn.sendBinaryPaced(BinaryChannel.PORT_END, streamId, aborted ? new Uint8Array([PORT_END_ABORT]) : new Uint8Array(0)),
    },
    (outcome) => {
      const open = streamsByConnection.get(conn.id)
      open?.delete(streamId)
      if (open?.size === 0) streamsByConnection.delete(conn.id)
      log('port stream closed', {
        connection_id: conn.id, stream_id: streamId, port,
        outcome: outcome.outcome, reason: outcome.reason, bytes_sent: outcome.bytesSent, bytes_received: outcome.bytesReceived,
      })
    },
  )
  current.set(streamId, stream)
  stream.start()
  log('port stream opened', { connection_id: conn.id, stream_id: streamId, port, open_streams: current.size })
  return { ok: true }
}

/** One inbound `PORT_*` frame from the connection `connectionId`. */
export function handlePortFrame(connectionId: string, channel: BinaryChannel, streamId: string, payload: Uint8Array): void {
  const streams = streamsByConnection.get(connectionId)
  const stream = streams?.get(streamId)
  if (stream === undefined) {
    // Ordinary at the end of a stream: the two ends finish independently, and
    // a frame sent just before the other end closed arrives just after.
    debug('port frame for a stream that is not open; dropped', { connection_id: connectionId, stream_id: streamId, channel })
    return
  }
  if (stream === null) {
    if (channel === BinaryChannel.PORT_END) {
      streams?.delete(streamId)
      log('port stream cancelled by the client while dialing', { connection_id: connectionId, stream_id: streamId })
    } else {
      warn('port frame arrived before its stream opened; dropped', { connection_id: connectionId, stream_id: streamId, channel })
    }
    return
  }
  if (channel === BinaryChannel.PORT_DATA) {
    stream.receiveData(payload)
  } else if (channel === BinaryChannel.PORT_END) {
    stream.receiveEnd(payload[0] === PORT_END_ABORT)
  } else if (channel === BinaryChannel.PORT_CREDIT) {
    const bytes = decodePortCredit(payload)
    if (bytes === null) warn('malformed port credit frame; dropped', { connection_id: connectionId, stream_id: streamId, byte_length: payload.length })
    else stream.receiveCredit(bytes)
  }
}

/** Ends every stream `connectionId` holds. Nothing is sent: the connection is gone. */
export function closePortStreamsForConnection(connectionId: string, reason: string): void {
  const streams = streamsByConnection.get(connectionId)
  if (!streams) return
  streamsByConnection.delete(connectionId)
  log('closing port streams for a connection', { connection_id: connectionId, count: streams.size, reason })
  for (const stream of streams.values()) stream?.drop(reason)
}

/** How many streams `connectionId` holds, dialing ones included. */
export function portStreamCount(connectionId: string): number {
  return streamsByConnection.get(connectionId)?.size ?? 0
}
