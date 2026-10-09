/**
 * broker — the Electron main process's registry of `EnvironmentConnection`s
 * keyed by environment id (spec 12). This IS the "transport broker": it owns
 * one WebSocket per environment (local, TCP, or relay — the caller supplies
 * an `open()` attempt built from the matching `transport-*.ts`), performs
 * the `studio_hello`/`studio_welcome` handshake, retries with backoff on
 * failure (including a failure to resolve the route or credential, which is
 * part of the attempt), and relays every frame after the handshake UNCHANGED — the broker
 * never interprets a `studio_action` payload (nonfunctional requirement).
 *
 * `sendAction` is the one exception: it is a convenience built entirely out
 * of `send`/`onFrame` (encode a `studio_action`, correlate the matching
 * `studio_action_result` by `id`) for main-process callers like
 * `token-source.ts` that need a request/response call rather than a raw
 * frame relay. It does not special-case the action name or its payload.
 */
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import type { BinaryChannel } from '@ion/shared/studio-wire/channels'
import { StudioActionFailure } from '@ion/shared/studio-wire/action-failure'
import { log as _log, warn as _warn, debug as _debug } from '../logger'
import type { ConnectionPhase } from './phases'
import { ClientWireLatency } from '@ion/shared/client-wire-latency'
import { IpcHopMeter } from './ipc-hop'
import { ACTION_TIMEOUT_MS, EnvironmentConnection, MAX_PENDING_FRAMES, type ConnectionTarget } from './environment-connection'

export type { ConnectionAttempt, ConnectionTarget } from './environment-connection'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('connections-broker', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('connections-broker', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('connections-broker', msg, fields)
}

export class Broker extends EventEmitter {
  private readonly connections = new Map<string, EnvironmentConnection>()
  /**
   * This client's own view of wire latency: how long an action takes from
   * leaving here to its result arriving. The server measures the network and
   * its own work; only this end can measure what a person waits through.
   */
  readonly latency = new ClientWireLatency((tag, msg, fields) => _log(tag, msg, this.ipcHop.decorate(fields)))
  /**
   * The renderer's extra wait on top of the wire (`ipc-hop.ts`): paired per
   * frame id against `latency`'s figure and folded into the same window line
   * as `ipc_hop_p50_ms`.
   */
  readonly ipcHop = new IpcHopMeter()
  /**
   * Frames sent to an Environment before `connect()` has been called for it.
   *
   * The Studio renderer boots and fires its first actions (settings read,
   * questions state, terminal activity, resource catalog, presence) in the
   * same tick the window reports ready -- a few milliseconds before the main
   * process asks this broker to connect the LOCAL Environment. `send()` used
   * to look the connection up and silently do nothing when it was absent, so
   * every one of those actions timed out at 30 seconds and the Studio window
   * stayed behind the splash on "Workspace ready" for that long on every
   * launch. Held here and handed to the connection the moment it exists; the
   * connection's own queue then holds them until the wire is welcomed.
   */
  private readonly preConnect = new Map<string, StudioFrame[]>()

  connect(target: ConnectionTarget): void {
    this.connections.get(target.environmentId)?.disconnect()
    const conn = new EnvironmentConnection(
      target,
      (environmentId, frame) => {
        if (frame.type === 'studio_action_result') {
          this.latency.noteActionResult(environmentId, frame.id)
          this.ipcHop.noteMainResult(environmentId, frame.id)
        }
        this.emit('frame', environmentId, frame)
      },
      (environmentId, phase) => this.emit('phase', environmentId, phase),
      (environmentId, channel, key, payload) => this.emit('binary', environmentId, channel, key, payload),
    )
    this.connections.set(target.environmentId, conn)
    conn.connect()
    const early = this.preConnect.get(target.environmentId)
    if (early && early.length > 0) {
      this.preConnect.delete(target.environmentId)
      log('handing frames sent before connect to the new connection', { environment_id: target.environmentId, count: early.length })
      for (const frame of early) conn.send(frame)
    }
  }

  disconnect(environmentId: string): void {
    this.connections.get(environmentId)?.disconnect()
    this.connections.delete(environmentId)
    this.ipcHop.forget(environmentId)
    const early = this.preConnect.get(environmentId)
    if (early && early.length > 0) {
      warn('dropping frames queued for an environment that was disconnected before it connected', { environment_id: environmentId, count: early.length })
      this.preConnect.delete(environmentId)
    }
  }

  disconnectAll(): void {
    for (const id of [...this.connections.keys()]) this.disconnect(id)
  }

  /** Re-arms the backoff ladder for one environment and reconnects immediately (the tray/Studio "Restart" action). */
  restart(environmentId: string): void {
    this.connections.get(environmentId)?.restart()
  }

  /** Sends a frame UNCHANGED to the given environment's connection, or holds it until `connect()` creates one. No interpretation of its payload. */
  send(environmentId: string, frame: StudioFrame): void {
    // Every frame this desktop sends passes here -- the renderer's through
    // `ipc/studio-bridge.ts`, the main process's through `sendAction` -- so
    // this is the one place that sees what a person actually waits through.
    if (frame.type === 'studio_action') {
      this.latency.noteActionSent(environmentId, frame.id, this.connections.get(environmentId)?.transportKind ?? 'unknown')
      this.ipcHop.noteSent(environmentId, frame.id)
    }
    const conn = this.connections.get(environmentId)
    if (conn) {
      conn.send(frame)
      return
    }
    const queue = this.preConnect.get(environmentId) ?? []
    if (queue.length >= MAX_PENDING_FRAMES) {
      const dropped = queue.shift()
      warn('pre-connect frame queue is full; dropped the oldest', { environment_id: environmentId, dropped_frame_type: dropped?.type ?? 'unknown', queued: queue.length })
    }
    queue.push(frame)
    this.preConnect.set(environmentId, queue)
    debug('queued a frame for an environment with no connection yet', { environment_id: environmentId, frame_type: frame.type, queued: queue.length })
  }

  /** Sends one binary frame (spec 15: transfer.export/import archive chunks) to the given environment's connection. Returns false when there is no open connection. */
  sendBinary(environmentId: string, channel: BinaryChannel, key: string, payload: Uint8Array): boolean {
    return this.connections.get(environmentId)?.sendBinary(channel, key, payload) ?? false
  }

  /**
   * Re-deliver an already-connected Environment's welcome, for a window that
   * attached after it arrived. The local Environment is connected at boot,
   * before any window exists, and a window asking to connect it again keeps
   * that socket (`environment-connect.ts`), so without this the window never
   * sees the local welcome: the Personal preferences it declares there, its
   * Account settings, its presence identity, and its policy all stay empty.
   */
  replayWelcome(environmentId: string, reason: string): boolean {
    const conn = this.connections.get(environmentId)
    const replayed = conn?.replayWelcome() ?? false
    if (replayed) log('replayed the live welcome and requested a fresh snapshot', { environment_id: environmentId, reason })
    else warn('no live welcome to replay; listeners wait for the next one', { environment_id: environmentId, reason, has_connection: !!conn })
    return replayed
  }

  phaseOf(environmentId: string): ConnectionPhase | undefined {
    return this.connections.get(environmentId)?.phase
  }

  /** The capabilities an Environment's server advertised in its welcome, or null while it is not connected. */
  serverCapabilities(environmentId: string): readonly string[] | null {
    return this.connections.get(environmentId)?.serverCapabilities ?? null
  }

  /**
   * Re-emit an Environment's current phase, for a window that attached after
   * the transition was pushed. The local Environment connects at boot before
   * any window exists; a window's own connect request then keeps that socket
   * (`environment-connect.ts`) and, with nothing re-emitted, its registry
   * stayed on the `connecting` it set for itself: the title bar reported the
   * machine offline for hours while every frame flowed.
   */
  replayPhase(environmentId: string): boolean {
    const conn = this.connections.get(environmentId)
    if (!conn) return false
    log('replayed the current phase', { environment_id: environmentId, phase: conn.phase.phase })
    this.emit('phase', environmentId, conn.phase)
    return true
  }

  /** Every Environment this broker holds a connection for, whatever its phase. */
  environmentIds(): string[] {
    return [...this.connections.keys()]
  }

  allPhases(): Record<string, ConnectionPhase> {
    const out: Record<string, ConnectionPhase> = {}
    for (const [id, conn] of this.connections) out[id] = conn.phase
    return out
  }

  onFrame(cb: (environmentId: string, frame: StudioFrame) => void): () => void {
    this.on('frame', cb)
    return () => this.off('frame', cb)
  }

  onPhase(cb: (environmentId: string, phase: ConnectionPhase) => void): () => void {
    this.on('phase', cb)
    return () => this.off('phase', cb)
  }

  /** Every binary frame (channel/key/payload) relayed from any environment (spec 15). Never interpreted here — the transfer flow owns what the bytes mean. */
  onBinary(cb: (environmentId: string, channel: BinaryChannel, key: string, payload: Uint8Array) => void): () => void {
    this.on('binary', cb)
    return () => this.off('binary', cb)
  }

  /**
   * Convenience request/response over `send`/`onFrame`: encodes a
   * `studio_action`, waits for the matching `studio_action_result` by id,
   * and resolves/rejects. Used by main-process callers (token-source.ts,
   * spec 15's transfer orchestrator) that need a call, not a raw relay — the
   * renderer's `host.action` instead goes through the IPC bridge and does its
   * own correlation on its side.
   *
   * `timeoutMs` defaults to `ACTION_TIMEOUT_MS` but is overridable: a
   * `transfer.import` reply doesn't resolve on the server until every byte of
   * the archive has streamed in AND been processed (see
   * `server/src/transfer/actions.ts`'s module doc), which for a large archive
   * takes far longer than the 30s default tuned for ordinary actions.
   */
  sendAction(environmentId: string, action: string, args: unknown[], timeoutMs: number = ACTION_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timeout = setTimeout(() => {
        off()
        this.latency.noteActionTimeout(environmentId, id)
        reject(new Error(`studio_action '${action}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const off = this.onFrame((envId, frame) => {
        if (envId !== environmentId || frame.type !== 'studio_action_result' || frame.id !== id) return
        clearTimeout(timeout)
        off()
        if (frame.ok) {
          resolve(frame.value)
        } else {
          const failure = frame.refusal ?? frame.error
          reject(new StudioActionFailure(failure?.message ?? `studio_action '${action}' failed`, failure?.code))
        }
      })
      this.send(environmentId, { type: 'studio_action', id, action, args })
    })
  }
}
