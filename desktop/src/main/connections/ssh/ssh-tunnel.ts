/**
 * ssh-tunnel -- one loopback port forward per `via: 'ssh'` environment.
 *
 * `ensure()` reserves a local port, runs `ssh -N -L`, waits until the
 * server answers `/healthz` through it, and keeps the forward alive: when
 * the ssh process exits for any reason other than `stop()`, it is respawned
 * on the SAME local port after a short backoff, so the broker's own
 * reconnect (which dials that port) finds the forward back without anyone
 * re-resolving anything. `stop()` ends the forward for a removed
 * environment; `stopAll()` runs at quit.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import type { SshEnvironmentLeg } from '@ion/shared/types-environments'
import { sshBaseArgs, type SshSpawn } from './ssh-command'
import { log as _log, warn as _warn } from '../../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('ssh-tunnel', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('ssh-tunnel', msg, fields)
}

/** Ladder for respawning a dropped forward; the last step repeats forever. */
export const TUNNEL_RESTART_LADDER_MS = [1000, 2000, 4000, 8000, 15000]
const READY_TIMEOUT_MS = 20_000
const READY_POLL_MS = 500

export interface SshTunnelHandle {
  localPort: number
}

interface TunnelEntry {
  key: string
  leg: SshEnvironmentLeg
  localPort: number
  child: ChildProcess | null
  restarts: number
  restartTimer: ReturnType<typeof setTimeout> | null
  stopped: boolean
  /** The in-flight ensure(), so concurrent callers share one spawn. */
  starting: Promise<SshTunnelHandle> | null
}

export interface SshTunnelManagerOptions {
  spawn?: SshSpawn
  /** Injectable readiness probe (defaults to GET /healthz through the forward). */
  probe?: (localPort: number) => Promise<boolean>
  /** Injectable port reservation (defaults to binding port 0 on loopback). */
  reservePort?: () => Promise<number>
  /** Injectable clock for the restart ladder. */
  setTimeoutFn?: typeof setTimeout
}

async function defaultReservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('could not reserve a loopback port'))))
    })
  })
}

async function defaultProbe(localPort: number): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    try {
      const res = await fetch(`http://127.0.0.1:${localPort}/healthz`, { signal: controller.signal })
      return res.ok
    } finally {
      clearTimeout(timer)
    }
  } catch {
    // silent-ok: a refused connection is the expected answer while the forward is still coming up; the caller polls
    return false
  }
}

export class SshTunnelManager {
  private readonly entries = new Map<string, TunnelEntry>()
  private readonly spawn: SshSpawn
  private readonly probe: (localPort: number) => Promise<boolean>
  private readonly reservePort: () => Promise<number>
  private readonly setTimeoutFn: typeof setTimeout

  constructor(opts: SshTunnelManagerOptions = {}) {
    this.spawn = opts.spawn ?? (nodeSpawn as unknown as SshSpawn)
    this.probe = opts.probe ?? defaultProbe
    this.reservePort = opts.reservePort ?? defaultReservePort
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout
  }

  /** The live local port for a key, when its forward is up. */
  localPortOf(key: string): number | null {
    const entry = this.entries.get(key)
    return entry && !entry.stopped ? entry.localPort : null
  }

  /**
   * Opens (or reuses) the forward for `key`. Resolves once the server
   * answers through it. A second call while the first is still starting
   * shares the same promise.
   */
  ensure(key: string, leg: SshEnvironmentLeg): Promise<SshTunnelHandle> {
    const existing = this.entries.get(key)
    if (existing && !existing.stopped) {
      if (existing.starting) return existing.starting
      if (existing.child && existing.child.exitCode === null) return Promise.resolve({ localPort: existing.localPort })
    }
    const entry: TunnelEntry = existing && !existing.stopped
      ? existing
      : { key, leg, localPort: 0, child: null, restarts: 0, restartTimer: null, stopped: false, starting: null }
    this.entries.set(key, entry)
    entry.starting = this.start(entry).finally(() => { entry.starting = null })
    return entry.starting
  }

  private async start(entry: TunnelEntry): Promise<SshTunnelHandle> {
    if (!entry.localPort) entry.localPort = await this.reservePort()
    this.spawnForward(entry)
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (entry.stopped) throw new Error(`tunnel ${entry.key} was stopped while starting`)
      if (entry.child && entry.child.exitCode !== null) {
        throw new Error(`ssh forward to ${entry.leg.destination} exited with ${entry.child.exitCode} before the server answered`)
      }
      if (await this.probe(entry.localPort)) {
        log('tunnel ready', { key: entry.key, destination: entry.leg.destination, local_port: entry.localPort, remote_port: entry.leg.remotePort })
        return { localPort: entry.localPort }
      }
      await new Promise((r) => this.setTimeoutFn(r, READY_POLL_MS))
    }
    throw new Error(`ssh forward to ${entry.leg.destination} opened but the Studio server did not answer on its port ${entry.leg.remotePort} within ${READY_TIMEOUT_MS / 1000}s`)
  }

  private spawnForward(entry: TunnelEntry): void {
    const args = [
      ...sshBaseArgs({ destination: entry.leg.destination, port: entry.leg.port }),
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-L', `127.0.0.1:${entry.localPort}:127.0.0.1:${entry.leg.remotePort}`,
      entry.leg.destination,
    ]
    log('spawning ssh forward', { key: entry.key, destination: entry.leg.destination, local_port: entry.localPort, remote_port: entry.leg.remotePort, restarts: entry.restarts })
    let child: ChildProcess
    try {
      child = this.spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      warn('ssh forward spawn failed', { key: entry.key, error: err instanceof Error ? err.message : String(err) })
      this.scheduleRestart(entry)
      return
    }
    entry.child = child
    child.stdin?.end()
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim()
      if (text && !/post-quantum|store now, decrypt later|openssh\.com\/pq/i.test(text)) warn('ssh forward stderr', { key: entry.key, line: text.slice(0, 300) })
    })
    child.on('error', (err) => warn('ssh forward process error', { key: entry.key, error: err.message }))
    child.on('close', (code, signal) => {
      if (entry.child !== child) return
      if (entry.stopped) {
        log('ssh forward closed after stop', { key: entry.key, code, signal })
        return
      }
      warn('ssh forward dropped; restarting', { key: entry.key, code, signal, restarts: entry.restarts })
      this.scheduleRestart(entry)
    })
  }

  private scheduleRestart(entry: TunnelEntry): void {
    if (entry.stopped || entry.restartTimer) return
    const delay = TUNNEL_RESTART_LADDER_MS[Math.min(entry.restarts, TUNNEL_RESTART_LADDER_MS.length - 1)]
    entry.restarts += 1
    entry.restartTimer = this.setTimeoutFn(() => {
      entry.restartTimer = null
      if (entry.stopped) return
      this.spawnForward(entry)
    }, delay)
    log('ssh forward restart scheduled', { key: entry.key, delay_ms: delay, attempt: entry.restarts })
  }

  /** Re-keys an entry (the door opens the forward before it knows the environment id). */
  rekey(from: string, to: string): void {
    const entry = this.entries.get(from)
    if (!entry || from === to) return
    this.entries.delete(from)
    entry.key = to
    this.entries.set(to, entry)
    log('tunnel rekeyed', { from, to })
  }

  stop(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.stopped = true
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer)
      entry.restartTimer = null
    }
    if (entry.child && entry.child.exitCode === null) entry.child.kill()
    this.entries.delete(key)
    log('tunnel stopped', { key, destination: entry.leg.destination })
  }

  stopAll(): void {
    for (const key of [...this.entries.keys()]) this.stop(key)
  }
}
