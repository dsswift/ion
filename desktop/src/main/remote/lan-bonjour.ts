/**
 * Bonjour/mDNS advertisement for the desktop's LAN server.
 *
 * Registers `_ion._tcp` with the system mDNS responder so the iOS companion
 * app can discover this desktop on the local network. Owns the `dns-sd` child
 * process, the stale-registration sweep, and the recovery ladder that
 * re-registers when that child dies or fails to start.
 *
 * Extracted from lan-server.ts, which owns the WebSocket side. The two are
 * separable: this module needs only the port it should advertise.
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { hostname } from 'os'
import { log as _log } from '../logger'

// Tag stays 'LANServer' (not a new tag matching this filename) so operator
// `jq`/LogQL filters on tag=="LANServer" keep matching after the extraction.
// A pure refactor must not change what lands in ~/.ion/desktop.jsonl.
function log(msg: string, fields?: Record<string, unknown>): void {
  _log('LANServer', msg, fields)
}

/**
 * Escape POSIX-ERE metacharacters so a literal string can be embedded in a
 * `pgrep -f` pattern. A hostname is usually inert, but an unescaped `.` is a
 * wildcard and would widen the orphan sweep beyond the service we own.
 */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Escalating delays before re-registering the Bonjour service after the dns-sd
// child dies unexpectedly. Same const-array + clamped-index shape as the auth
// backoff in lan-server.ts. The first step is short because the common cause
// (an external process killing our registration) is instantly recoverable, and
// a desktop that is invisible on mDNS cannot be discovered or paired at all.
const READVERTISE_BACKOFF_STEPS_MS: number[] = [1_000, 5_000, 30_000]

/**
 * Why a re-registration was scheduled. Carried into the log line so an
 * operator reading desktop.jsonl can tell a killed child apart from a child
 * that never started — the two arrive on different code paths and have
 * different causes (external SIGTERM vs. fd exhaustion / missing binary).
 */
type ReadvertiseReason = 'exit' | 'spawn-error' | 'spawn-threw'

export interface BonjourAdvertiserOptions {
  /** TCP port to advertise as the service's port. */
  port: number
  /**
   * When false, every mDNS side effect is skipped: no sweep, no spawn, no
   * respawn. Advertising is machine-global state, so tests opt out rather than
   * mutating the developer's live Bonjour environment.
   */
  advertise: boolean
}

/**
 * Owns the `dns-sd -R` child that publishes `_ion._tcp`.
 *
 * Lifecycle: `start()` sweeps stale registrations then spawns the child;
 * `stop()` tears it down. Between those, an unexpected loss of the child is
 * recovered automatically on an escalating ladder.
 */
export class BonjourAdvertiser {
  private port: number
  private advertise: boolean
  private dnssdProc: ChildProcess | null = null
  /**
   * True when we killed the dns-sd child ourselves (stop / unadvertise). The
   * exit handler reads this to tell a deliberate teardown apart from an
   * unexpected death, and only respawns for the latter.
   */
  private intentionalStop = false
  private readvertiseTimer: ReturnType<typeof setTimeout> | null = null
  /** Consecutive unexpected dns-sd deaths; indexes the backoff ladder. */
  private readvertiseAttempt = 0
  /**
   * Whether the current spawn generation has already armed a respawn.
   *
   * A single failed spawn can signal twice: Node documents that `'exit'` may
   * or may not follow `'error'`. Both paths schedule recovery, so without this
   * flag one failure would arm the timer twice and double-advance the backoff
   * ladder (jumping 1s -> 30s after two real failures instead of three).
   * Reset before each spawn.
   */
  private respawnScheduled = false

  constructor(options: BonjourAdvertiserOptions) {
    this.port = options.port
    this.advertise = options.advertise
  }

  /** Register the service, sweeping any stale registration of it first. */
  start(): void {
    this._advertiseBonjour()
  }

  /** Deregister and stay down: no respawn follows a deliberate stop. */
  stop(): void {
    this._unadvertiseBonjour()
  }

  private _advertiseBonjour(): void {
    if (!this.advertise) {
      log('lan_server: bonjour advertisement disabled by option', { port: this.port })
      return
    }

    // Use macOS dns-sd to register through the system's mDNSResponder.
    // This is the only reliable way to be visible to Apple's NWBrowser.
    //
    // Kill any orphaned dns-sd processes from prior instances of *this* service
    // first. When the app is force-killed or crashes, _unadvertiseBonjour never
    // runs and the old dns-sd child lives on. Stale registrations confuse
    // mDNSResponder and make the service undiscoverable on iOS.
    this._killOrphanedDnssd()

    // A fresh spawn supersedes any pending respawn attempt.
    this._clearReadvertiseTimer()
    // Clear before spawning: everything from here until an explicit
    // stop()/unadvertise is an unexpected death and must be recovered.
    this.intentionalStop = false
    // New spawn generation: this child has not scheduled a respawn yet.
    this.respawnScheduled = false

    const name = this._serviceName()
    log('lan_server: bonjour spawning dns-sd', { name, port: this.port })
    try {
      this.dnssdProc = spawn('/usr/bin/dns-sd', [
        '-R', name, '_ion._tcp', 'local', String(this.port),
      ], { stdio: 'pipe' })

      this.dnssdProc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString().trim()
        log('lan_server: dns-sd stdout', { data: text })
        // mDNSResponder confirmed the registration — the ladder starts from
        // the top again on the next unexpected death.
        if (text.includes('Name now registered')) {
          if (this.readvertiseAttempt > 0) {
            log('lan_server: bonjour registration confirmed, backoff reset', {
              name,
              port: this.port,
              after_attempts: this.readvertiseAttempt,
            })
          }
          this.readvertiseAttempt = 0
        }
      })

      this.dnssdProc.stderr?.on('data', (data: Buffer) => {
        log('lan_server: dns-sd stderr', { data: data.toString().trim() })
      })

      this.dnssdProc.on('error', (err) => {
        log('lan_server: dns-sd spawn error', { error: err.message })
        this.dnssdProc = null
        // A spawn that never started emits 'error' and (usually) no 'exit', so
        // this path must schedule recovery itself. ENOENT, EACCES, EMFILE and
        // EAGAIN all land here, and the transient ones are exactly what the
        // ladder exists for — without this the desktop stays invisible on mDNS
        // until the whole app restarts.
        this._scheduleReadvertise('spawn-error', { error: err.message })
      })

      this.dnssdProc.on('exit', (code, signal) => {
        log('lan_server: dns-sd exited', { code, signal })
        this.dnssdProc = null
        if (this.intentionalStop) {
          // stop() / _unadvertiseBonjour() killed it. Staying down is correct.
          log('lan_server: dns-sd exit was an intentional stop, not respawning')
          return
        }
        // Anything else (external SIGTERM, mDNSResponder restart, a dns-sd
        // crash) leaves the desktop invisible on mDNS. Recover.
        this._scheduleReadvertise('exit', { exit_code: code, exit_signal: signal })
      })

      log('lan_server: bonjour advertising', { name, port: this.port, pid: this.dnssdProc.pid })
    } catch (err) {
      log('lan_server: bonjour unavailable', { error: (err as Error).message })
      // spawn() can throw synchronously (bad arguments, resource limits) rather
      // than emitting 'error'. Same consequence as any other failure to
      // register, so it takes the same recovery path.
      this.dnssdProc = null
      this._scheduleReadvertise('spawn-threw', { error: (err as Error).message })
    }
  }

  /** Bonjour service instance name: the short hostname. */
  private _serviceName(): string {
    return hostname().replace(/\.local$/, '')
  }

  /**
   * Schedule a re-registration after an unexpected loss of the advertisement,
   * using the escalating ladder. Without this the desktop stays undiscoverable
   * until the whole app restarts.
   *
   * `reason` records which path detected the loss; `detail` carries the
   * path-specific context (exit code/signal, or the spawn error message).
   */
  private _scheduleReadvertise(
    reason: ReadvertiseReason,
    detail: Record<string, unknown>,
  ): void {
    if (!this.advertise) {
      log('lan_server: bonjour respawn skipped, advertisement disabled')
      return
    }
    if (this.respawnScheduled) {
      // Second signal for the same dead child (e.g. 'error' then 'exit').
      // Recovery is already armed; arming again would double-advance the ladder.
      log('lan_server: bonjour respawn already scheduled for this spawn', {
        reason,
        attempt: this.readvertiseAttempt,
      })
      return
    }
    this._clearReadvertiseTimer()

    const stepIdx = Math.min(this.readvertiseAttempt, READVERTISE_BACKOFF_STEPS_MS.length - 1)
    const delayMs = READVERTISE_BACKOFF_STEPS_MS[stepIdx]
    this.readvertiseAttempt += 1
    this.respawnScheduled = true
    log('lan_server: bonjour scheduling respawn after unexpected dns-sd exit', {
      reason,
      attempt: this.readvertiseAttempt,
      delay_ms: delayMs,
      port: this.port,
      ...detail,
    })

    this.readvertiseTimer = setTimeout(() => {
      this.readvertiseTimer = null
      if (this.intentionalStop) {
        log('lan_server: bonjour respawn cancelled, server stopped')
        return
      }
      log('lan_server: bonjour respawning dns-sd', { attempt: this.readvertiseAttempt, port: this.port })
      this._advertiseBonjour()
    }, delayMs)
    // Do not hold the event loop open purely for a respawn attempt.
    this.readvertiseTimer.unref?.()
  }

  private _clearReadvertiseTimer(): void {
    if (this.readvertiseTimer) {
      clearTimeout(this.readvertiseTimer)
      this.readvertiseTimer = null
    }
  }

  /**
   * Kill orphaned dns-sd processes left behind by previous instances of *this*
   * exact service — same instance name, same service type, same port.
   *
   * The scoping is load-bearing. An earlier version matched
   * `dns-sd -R .* _ion._tcp` (no port, unescaped `.`), which also matched the
   * registration owned by a live, healthy Ion process on a different port —
   * so starting any second LANServer (notably one built by the test suite)
   * SIGTERMed the running app's advertisement and left the desktop
   * undiscoverable on mDNS.
   *
   * Uses spawnSync rather than execSync: execSync goes through `/bin/sh -c`,
   * whose own command line contains the pattern and therefore matches it.
   */
  private _killOrphanedDnssd(): void {
    const myPid = this.dnssdProc?.pid
    const pattern = `dns-sd -R ${escapeRegex(this._serviceName())} _ion\\._tcp local ${this.port}`
    const result = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8', timeout: 3000 })

    if (result.error) {
      log('lan_server: bonjour orphan sweep failed to run pgrep', {
        pattern,
        error: result.error.message,
      })
      return
    }

    const raw = (result.stdout || '').trim()
    if (!raw) {
      // pgrep exits 1 with no output when nothing matches — the normal case
      // on a clean start.
      log('lan_server: bonjour orphan sweep found no stale registrations', { pattern })
      return
    }

    const pids = raw.split('\n').map(Number).filter(Boolean).filter((pid) => pid !== myPid)
    if (pids.length === 0) {
      log('lan_server: bonjour orphan sweep matched only our own child', { pattern, my_pid: myPid })
      return
    }

    log('lan_server: bonjour orphan sweep found candidates', { pattern, pids })
    let killed = 0
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM')
        killed++
      } catch (err) {
        log('lan_server: bonjour orphan already gone', { pid, error: (err as Error).message })
      }
    }
    log('lan_server: bonjour killed orphaned dns-sd', { count: killed, port: this.port })
  }

  private _unadvertiseBonjour(): void {
    // Set before the kill: the exit handler fires asynchronously and must see
    // that this teardown was deliberate, or it will schedule a respawn.
    this.intentionalStop = true
    this._clearReadvertiseTimer()
    this.readvertiseAttempt = 0
    if (this.dnssdProc) {
      log('lan_server: bonjour unadvertising', { pid: this.dnssdProc.pid, port: this.port })
      this.dnssdProc.kill()
      this.dnssdProc = null
    }
  }
}
