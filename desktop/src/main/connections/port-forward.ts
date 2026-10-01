/**
 * port-forward — the desktop end of a Port Forward (`@ion/shared/port-forward`).
 *
 * A forward is a loopback listener on this machine for one port on one
 * Environment's host. Every connection it accepts becomes a stream over that
 * Environment's Studio connection: this side picks the stream id, asks the
 * server to dial the port (`port.open`), and the bytes ride the broker's
 * binary channel either way.
 *
 * The listener takes the remote port's own number when it is free here, so a
 * page that calls `localhost:<port>` for its other services finds them at the
 * same addresses it would on the host. When the number is taken it takes any
 * free port and reports which.
 *
 * A forward outlives its Environment's connection dropping: the listener
 * stays, the streams in flight end, and new connections are refused until
 * the Environment is connected again.
 */
import net from 'net'
import { randomUUID } from 'crypto'
import { BinaryChannel } from '@ion/shared/studio-wire/channels'
import {
  PortStream, PORT_END_ABORT, PORT_FORWARD_CAPABILITY, decodePortCredit, encodePortCredit, isForwardablePort,
  type PortForward, type PortForwardStartResult, type PortOpenRequest,
} from '@ion/shared/port-forward'
import type { Broker } from './broker'
import { log as _log, warn as _warn, debug as _debug } from '../logger'

const TAG = 'port-forward'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug(TAG, msg, fields)
}

/** How many free ports are tried when the remote port's own number is taken here. */
const EPHEMERAL_ATTEMPTS = 5
/** Stream counts change many times during one page load; listeners hear the settled list. */
const CHANGE_COALESCE_MS = 100

interface Forward {
  environmentId: string
  remotePort: number
  localPort: number
  servers: net.Server[]
  streams: Map<string, PortStream>
}

function forwardKey(environmentId: string, remotePort: number): string {
  return `${environmentId}\u0000${remotePort}`
}

function errorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : ''
}

function listen(server: net.Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      server.on('error', (err) => warn('forward listener error', { listen_address: host, listen_port: port, error: err.message }))
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    })
  })
}

export class PortForwardManager {
  private readonly forwards = new Map<string, Forward>()
  private readonly starting = new Map<string, Promise<PortForwardStartResult>>()
  private readonly changeListeners = new Set<(forwards: PortForward[]) => void>()
  private changeTimer: ReturnType<typeof setTimeout> | null = null

  private attached = false

  constructor(private readonly broker: Broker) {}

  /** Listens to the broker from the first forward on; a process that never forwards a port never subscribes. */
  private attach(): void {
    if (this.attached) return
    this.attached = true
    this.broker.onBinary((environmentId, channel, streamId, payload) => this.onBinary(environmentId, channel, streamId, payload))
    this.broker.onPhase((environmentId, phase) => {
      // Any phase but `connected` means the connection the streams rode is
      // gone, and the server's ends went with it.
      if (phase.phase !== 'connected') this.dropStreams(environmentId, `the connection to ${environmentId} is ${phase.phase}`)
    })
  }

  /** Every forward, ordered by Environment then remote port. */
  list(): PortForward[] {
    return [...this.forwards.values()]
      .map((f) => ({ environmentId: f.environmentId, remotePort: f.remotePort, localPort: f.localPort, activeStreams: f.streams.size }))
      .sort((a, b) => a.environmentId.localeCompare(b.environmentId) || a.remotePort - b.remotePort)
  }

  onChange(cb: (forwards: PortForward[]) => void): () => void {
    this.changeListeners.add(cb)
    return () => this.changeListeners.delete(cb)
  }

  /** Forwards `remotePort` on `environmentId`'s host. Returns the existing forward when there is one. */
  start(environmentId: string, remotePort: number): Promise<PortForwardStartResult> {
    if (typeof environmentId !== 'string' || environmentId === '' || !isForwardablePort(remotePort)) {
      warn('forward refused: malformed request', { environment_id: String(environmentId), remote_port: String(remotePort) })
      return Promise.resolve({ ok: false, error: 'Enter a port between 1 and 65535.' })
    }
    const key = forwardKey(environmentId, remotePort)
    const existing = this.forwards.get(key)
    if (existing) {
      debug('forward already active', { environment_id: environmentId, remote_port: remotePort, local_port: existing.localPort })
      return Promise.resolve({ ok: true, forward: { environmentId, remotePort, localPort: existing.localPort, activeStreams: existing.streams.size } })
    }
    const capabilities = this.broker.serverCapabilities(environmentId)
    if (!capabilities) {
      warn('forward refused: the Environment is not connected', { environment_id: environmentId, remote_port: remotePort })
      return Promise.resolve({ ok: false, error: 'This Environment is not connected. Reconnect it, then forward the port again.' })
    }
    if (!capabilities.includes(PORT_FORWARD_CAPABILITY)) {
      warn('forward refused: the server does not forward ports', { environment_id: environmentId, remote_port: remotePort })
      return Promise.resolve({ ok: false, error: 'The Ion server on this Environment is too old to forward ports. Update it, then forward the port again.' })
    }
    const inFlight = this.starting.get(key)
    if (inFlight) return inFlight
    const started = this.open(environmentId, remotePort).finally(() => this.starting.delete(key))
    this.starting.set(key, started)
    return started
  }

  private async open(environmentId: string, remotePort: number): Promise<PortForwardStartResult> {
    this.attach()
    const forward: Forward = { environmentId, remotePort, localPort: 0, servers: [], streams: new Map() }
    try {
      forward.servers = await this.bind(forward, remotePort)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      warn('forward failed: no local port could be opened', { environment_id: environmentId, remote_port: remotePort, error: reason })
      return { ok: false, error: `Could not open a local port for ${remotePort}: ${reason}` }
    }
    this.forwards.set(forwardKey(environmentId, remotePort), forward)
    log('forward started', {
      environment_id: environmentId, remote_port: remotePort, local_port: forward.localPort,
      same_port: forward.localPort === remotePort, families: forward.servers.length,
    })
    this.changed()
    return { ok: true, forward: { environmentId, remotePort, localPort: forward.localPort, activeStreams: 0 } }
  }

  /**
   * Listens on both loopback families at one port number: the remote port's
   * own when both are free, else a free one. `localhost` resolves to either
   * family, so a number is only used when no other program holds it on the
   * other family.
   */
  private async bind(forward: Forward, preferredPort: number): Promise<net.Server[]> {
    let lastError: unknown = new Error('no free port')
    for (let attempt = 0; attempt <= EPHEMERAL_ATTEMPTS; attempt += 1) {
      const wanted = attempt === 0 ? preferredPort : 0
      const v4 = this.createServer(forward)
      let port: number
      try {
        port = await listen(v4, '127.0.0.1', wanted)
      } catch (err) {
        lastError = err
        debug('local port unavailable', { remote_port: forward.remotePort, wanted_port: wanted, family: 'ipv4', code: errorCode(err) })
        continue
      }
      const v6 = this.createServer(forward)
      try {
        await listen(v6, '::1', port)
        forward.localPort = port
        return [v4, v6]
      } catch (err) {
        if (errorCode(err) !== 'EADDRINUSE') {
          // No IPv6 loopback on this machine: nothing else can hold the number there either.
          log('forward listens on IPv4 loopback only', { remote_port: forward.remotePort, local_port: port, code: errorCode(err) })
          forward.localPort = port
          return [v4]
        }
        lastError = err
        debug('local port unavailable', { remote_port: forward.remotePort, wanted_port: port, family: 'ipv6', code: 'EADDRINUSE' })
        v4.close()
      }
    }
    throw lastError
  }

  private createServer(forward: Forward): net.Server {
    return net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => this.accept(forward, socket))
  }

  private accept(forward: Forward, socket: net.Socket): void {
    const { environmentId, remotePort } = forward
    const phase = this.broker.phaseOf(environmentId)?.phase
    if (phase !== 'connected') {
      warn('local connection refused: the Environment is not connected', { environment_id: environmentId, remote_port: remotePort, phase: phase ?? 'none' })
      socket.destroy()
      return
    }
    const streamId = randomUUID()
    const stream = new PortStream(
      socket,
      {
        data: (payload) => this.broker.sendBinary(environmentId, BinaryChannel.PORT_DATA, streamId, payload),
        credit: (bytes) => void this.broker.sendBinary(environmentId, BinaryChannel.PORT_CREDIT, streamId, encodePortCredit(bytes)),
        end: (aborted) => void this.broker.sendBinary(environmentId, BinaryChannel.PORT_END, streamId, aborted ? new Uint8Array([PORT_END_ABORT]) : new Uint8Array(0)),
      },
      (outcome) => {
        forward.streams.delete(streamId)
        debug('stream closed', {
          environment_id: environmentId, remote_port: remotePort, stream_id: streamId,
          outcome: outcome.outcome, reason: outcome.reason, bytes_sent: outcome.bytesSent, bytes_received: outcome.bytesReceived,
        })
        this.changed()
      },
    )
    // Registered before the request leaves: the server's first bytes can
    // arrive in the same read as its answer.
    forward.streams.set(streamId, stream)
    this.changed()
    const request: PortOpenRequest = { streamId, port: remotePort }
    this.broker.sendAction(environmentId, 'port.open', [request]).then(
      () => {
        debug('stream opened', { environment_id: environmentId, remote_port: remotePort, stream_id: streamId })
        stream.start()
      },
      (err: unknown) => {
        warn('stream refused by the server', { environment_id: environmentId, remote_port: remotePort, stream_id: streamId, error: err instanceof Error ? err.message : String(err) })
        stream.drop('the server did not open the port')
      },
    )
  }

  private onBinary(environmentId: string, channel: BinaryChannel, streamId: string, payload: Uint8Array): void {
    if (channel !== BinaryChannel.PORT_DATA && channel !== BinaryChannel.PORT_END && channel !== BinaryChannel.PORT_CREDIT) return
    const stream = this.findStream(environmentId, streamId)
    if (!stream) {
      // Ordinary at the end of a stream: the two ends finish independently.
      debug('frame for a stream that is not open; dropped', { environment_id: environmentId, stream_id: streamId, channel })
      return
    }
    if (channel === BinaryChannel.PORT_DATA) {
      stream.receiveData(payload)
    } else if (channel === BinaryChannel.PORT_END) {
      stream.receiveEnd(payload[0] === PORT_END_ABORT)
    } else {
      const bytes = decodePortCredit(payload)
      if (bytes === null) warn('malformed credit frame; dropped', { environment_id: environmentId, stream_id: streamId, byte_length: payload.length })
      else stream.receiveCredit(bytes)
    }
  }

  private findStream(environmentId: string, streamId: string): PortStream | undefined {
    for (const forward of this.forwards.values()) {
      if (forward.environmentId !== environmentId) continue
      const stream = forward.streams.get(streamId)
      if (stream) return stream
    }
    return undefined
  }

  private dropStreams(environmentId: string, reason: string): void {
    let dropped = 0
    for (const forward of this.forwards.values()) {
      if (forward.environmentId !== environmentId) continue
      for (const stream of [...forward.streams.values()]) {
        stream.drop(reason)
        dropped += 1
      }
    }
    if (dropped > 0) log('streams ended with their connection', { environment_id: environmentId, count: dropped, reason })
  }

  /** Stops one forward. Returns whether there was one. */
  stop(environmentId: string, remotePort: number): boolean {
    const key = forwardKey(environmentId, remotePort)
    const forward = this.forwards.get(key)
    if (!forward) {
      log('stop requested for a port that is not forwarded', { environment_id: environmentId, remote_port: remotePort })
      return false
    }
    this.forwards.delete(key)
    for (const server of forward.servers) server.close()
    for (const stream of [...forward.streams.values()]) stream.abort('the forward was stopped')
    log('forward stopped', { environment_id: environmentId, remote_port: remotePort, local_port: forward.localPort })
    this.changed()
    return true
  }

  /** Stops every forward to one Environment (it was disconnected or removed). */
  stopEnvironment(environmentId: string): void {
    for (const forward of [...this.forwards.values()]) {
      if (forward.environmentId === environmentId) this.stop(environmentId, forward.remotePort)
    }
  }

  stopAll(): void {
    for (const forward of [...this.forwards.values()]) this.stop(forward.environmentId, forward.remotePort)
  }

  private changed(): void {
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      const forwards = this.list()
      for (const cb of this.changeListeners) cb(forwards)
    }, CHANGE_COALESCE_MS)
  }
}
