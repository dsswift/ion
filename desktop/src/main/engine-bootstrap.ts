/**
 * First-launch engine bootstrap.
 *
 * Ensures the engine daemon is installed and current every time the desktop
 * starts, dispatching to the platform's supervisor (engine-supervisor.ts):
 * a launchd LaunchAgent on darwin, a per-user Scheduled Task on win32.
 * Elsewhere there is no supervisor mechanism and this logs a WARN and
 * returns.
 *
 * Shared steps (idempotent, platform-independent):
 *   1. Locate the bundled engine binary and hash its content (sha256).
 *   2. On a Windows supervisor with a changed hash, stop the task first —
 *      a running .exe cannot be overwritten.
 *   3. Copy the binary to its installed path if missing or content-changed.
 *   4. Run `ion install-assets` to install the extension SDK.
 *   5. Register/refresh the supervisor definition.
 *   6. Start (or force-restart) the engine under supervision.
 *   7. Verify the daemon actually came up via a real connect probe.
 *
 * This single module serves both install routes (source build and packaged
 * install) so they cannot drift.
 */

import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log, error as _error, warn as _warn } from './logger'
import { resolveEngineAddress, describeEngineAddress, probeEngine } from './engine-address'
import { supervisorFor, type SupervisorOpts } from './engine-supervisor'
import { findPlistTemplate, PLIST_LABEL, PLIST_FILENAME } from './engine-supervisor-launchd'
import { ENGINE_HOST_NAME, binaryName, findBundledBinary, findBundledHost, hashBinary, installBinary } from './engine-binary-install'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('bootstrap', msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error('bootstrap', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('bootstrap', msg, fields)
}

/**
 * Timing knobs for the install-and-verify sequence. Injectable so tests can
 * exercise the retry/verify paths without real multi-second waits; production
 * callers use the defaults.
 */
export interface DaemonReadinessOpts {
  /** Timeout for each supervisor command invocation. */
  kickstartTimeoutMs?: number
  /** Attempts per supervisor-start round (the underlying command can
   *  transiently hang or refuse while a just-stopped definition is still
   *  tearing down). */
  kickstartAttempts?: number
  /** Settle delay between attempts. */
  kickstartSettleMs?: number
  /** Total budget for one socket-readiness wait. */
  socketWaitMs?: number
  /** Poll interval for the socket-readiness wait. */
  socketPollMs?: number
}

const READINESS_DEFAULTS: Required<DaemonReadinessOpts> = {
  kickstartTimeoutMs: 10000,
  kickstartAttempts: 3,
  kickstartSettleMs: 1000,
  socketWaitMs: 15000,
  socketPollMs: 500,
}

function toSupervisorOpts(opts: Required<DaemonReadinessOpts>): SupervisorOpts {
  return {
    commandTimeoutMs: opts.kickstartTimeoutMs,
    attempts: opts.kickstartAttempts,
    settleMs: opts.kickstartSettleMs,
    stopWaitMs: opts.socketWaitMs,
    stopPollMs: opts.socketPollMs,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll the engine daemon address until it accepts a connection or the
 * budget runs out. This is the fetching primitive — "the supervisor command
 * returned 0" only proves the OS accepted the start request, not that the
 * engine bound its address. Each probe opens and immediately closes a real
 * connection.
 */
export async function waitForEngineSocket(opts: Required<DaemonReadinessOpts>): Promise<boolean> {
  const deadline = Date.now() + opts.socketWaitMs
  const started = Date.now()
  const addr = resolveEngineAddress()
  for (;;) {
    const ok = await probeEngine(addr)
    if (ok) {
      log('engine_bootstrap: engine socket reachable', { elapsed_ms: Date.now() - started })
      return true
    }
    if (Date.now() >= deadline) return false
    await sleep(opts.socketPollMs)
  }
}

/**
 * Ensure the engine daemon is installed and current under its platform
 * supervisor. Called once at desktop startup, before the bridge connects.
 *
 * Exported for testing. In production, call from app-lifecycle.ts.
 */
export async function ensureEngineDaemon(readiness: DaemonReadinessOpts = {}): Promise<void> {
  const sup = supervisorFor()
  if (!sup) {
    warn('unsupported platform for engine supervision', { platform: process.platform })
    return
  }
  const opts: Required<DaemonReadinessOpts> = { ...READINESS_DEFAULTS, ...readiness }
  const supOpts = toSupervisorOpts(opts)

  const home = homedir()
  const ionBinDir = join(home, '.ion', 'bin')
  const destBinary = join(ionBinDir, binaryName())
  const srcBinary = findBundledBinary()

  let binaryUpdated = false

  if (!srcBinary) {
    log('WARNING: bundled engine binary not found, skipping binary install')
  } else if (srcBinary === destBinary) {
    log('Engine binary is already at daemon path, skipping copy')
  } else {
    const srcHash = hashBinary(srcBinary)
    const destHash = existsSync(destBinary) ? hashBinary(destBinary) : null
    const changed = !(destHash && srcHash && destHash === srcHash)

    if (!changed) {
      log('engine_bootstrap: binary hash match, skipping copy', { hash: srcHash!.slice(0, 12) })
    } else {
      // A running .exe cannot be overwritten on Windows — the supervisor
      // must be stopped before the copy. On darwin the staging+rename copy
      // below works fine against a running daemon (it swaps the inode, it
      // does not touch the one launchd currently has open), so this is a
      // Windows-only precondition.
      if (sup.name === 'schtasks') {
        await sup.stop(supOpts)
      }
      log('engine_bootstrap: binary content differs, copying', {
        reason: destHash ? 'hash_mismatch' : 'missing',
        src_hash: srcHash ? srcHash.slice(0, 12) : null,
        dest_hash: destHash ? destHash.slice(0, 12) : null,
        src: srcBinary,
      })
      installBinary(srcBinary, destBinary, ionBinDir)
      binaryUpdated = true
    }
  }

  // The Windows host launcher is installed beside the engine, because the
  // task's <Exec> runs it and it resolves the engine as its sibling. It is
  // copied on the same hash-compared terms as the engine so a stale host is
  // replaced, and its absence is never fatal — the supervisor falls back to
  // running the engine directly and says so.
  const srcHost = findBundledHost()
  if (srcHost) {
    const destHost = join(ionBinDir, ENGINE_HOST_NAME)
    const srcHostHash = hashBinary(srcHost)
    const destHostHash = existsSync(destHost) ? hashBinary(destHost) : null
    if (destHostHash && srcHostHash && destHostHash === srcHostHash) {
      log('engine_bootstrap: host hash match, skipping copy', { hash: srcHostHash.slice(0, 12) })
    } else {
      // Same Windows precondition as the engine copy: a running .exe cannot
      // be overwritten, and the host runs for as long as the engine does.
      await sup.stop(supOpts)
      log('engine_bootstrap: host content differs, copying', {
        reason: destHostHash ? 'hash_mismatch' : 'missing',
        src_hash: srcHostHash ? srcHostHash.slice(0, 12) : null,
        dest_hash: destHostHash ? destHostHash.slice(0, 12) : null,
        src: srcHost,
      })
      installBinary(srcHost, destHost, ionBinDir)
      binaryUpdated = true
    }
  } else if (process.platform === 'win32') {
    log('WARNING: bundled engine host launcher not found; the engine will run with a visible console window')
  }

  // install-assets must run from srcBinary (the bundled binary), not
  // destBinary (the installed copy). The command resolves its asset root by
  // walking up from the executable directory looking for an adjacent
  // extensions/ tree, which exists next to srcBinary but not next to
  // destBinary.
  if (!srcBinary) {
    log('WARNING: bundled engine binary not found, skipping install-assets')
  } else {
    try {
      const output = execFileSync(srcBinary, ['install-assets'], { encoding: 'utf-8', timeout: 30000 })
      log('engine_bootstrap: install-assets done', { msg: output.trim().split('\n').pop() || 'done' })
    } catch (err: any) {
      log('engine_bootstrap: install-assets failed (non-fatal)', { error: err.message })
    }
  }

  const defChanged = await sup.install(destBinary, supOpts)
  const forceRestart = binaryUpdated || defChanged
  log('engine_bootstrap: starting daemon', { supervisor: sup.name, force_restart: forceRestart, binary_updated: binaryUpdated, definition_changed: defChanged })
  await sup.start(forceRestart, supOpts)

  // Verify the daemon actually came up — the supervisor command succeeding
  // proves the OS accepted the start request, not that the engine bound its
  // address. The failure this closes: during a desktop-relaunch handoff the
  // old instance tears down the supervisor definition while the new
  // instance's start races that teardown and fails or lands on a dead
  // registration, and the app then starts against a down engine — 30
  // restoring tabs each timing out against an address nobody was going to
  // bring back.
  if (await waitForEngineSocket(opts)) return

  log('engine_bootstrap: socket not reachable after start, retrying')
  await sup.start(forceRestart, supOpts)
  if (await waitForEngineSocket(opts)) return

  error('engine_bootstrap: engine daemon failed to come up; bridge reconnect will keep retrying', {
    socket: describeEngineAddress(resolveEngineAddress()),
    force_restart: forceRestart,
  })
}

// Exported for testing
export { findPlistTemplate, PLIST_LABEL, PLIST_FILENAME, findBundledBinary, hashBinary }

/**
 * Stop the engine daemon through its supervisor and wait for it to go away.
 *
 * This is what Quit All means: the desktop is exiting and the daemon must
 * not outlive it. Every platform stops its own way -- launchd needs the
 * agent booted out or it respawns the process immediately, a Windows
 * Scheduled Task needs schtasks /End -- and the supervisor abstraction
 * already encodes that difference, so the quit path asks for the verb
 * rather than reimplementing one platform's mechanism inline.
 *
 * The bug this closes: the quit path ran `launchctl bootout` behind a
 * `process.platform === 'darwin'` check and did nothing at all on Windows.
 * Quit All left the Scheduled Task running, so the engine kept serving on
 * 127.0.0.1:21017 after the desktop exited -- and because the engine reads
 * engine.json exactly once at start, an operator who quit, edited config,
 * and relaunched was still talking to a daemon holding the old config with
 * no indication anything had been ignored.
 *
 * Returns false when there is no supervisor for this platform, or when the
 * stop failed. Never throws: a failure here must not prevent the desktop
 * from exiting, but it must be visible in the log.
 */
export async function stopEngineDaemon(): Promise<boolean> {
  const sup = supervisorFor()
  if (!sup) {
    warn('stopEngineDaemon: unsupported platform for engine supervision', { platform: process.platform })
    return false
  }
  try {
    await sup.stop(toSupervisorOpts(READINESS_DEFAULTS))
    log('stopEngineDaemon: engine stopped', { supervisor: sup.name })
    return true
  } catch (err: any) {
    error('stopEngineDaemon: stop failed; the daemon may outlive the desktop', {
      supervisor: sup.name,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Force-restart the running engine daemon so it re-reads engine.json.
 *
 * The engine is a persistent daemon that outlives the desktop and reads
 * engine.json exactly ONCE at process start. A config change (backend, model,
 * logging, egress, ...) therefore does not take effect until the daemon
 * restarts. This is the on-demand restart affordance: it force-restarts the
 * daemon in place (launchd kickstart -k, or a Windows task /End + /Run)
 * WITHOUT quitting the desktop or killing background work beyond the engine
 * process itself — the daemon comes straight back up with fresh config.
 *
 * This is distinct from Quit All (which tears down the supervisor
 * registration so it stays down until the next desktop launch) and from
 * Quit Desktop (which leaves the supervisor untouched). Here the daemon is
 * intentionally recycled and immediately respawned by its supervisor.
 *
 * Returns false when there is no supervisor for this platform. Resolves
 * true when the restart command was issued successfully.
 */
export async function restartEngineDaemon(): Promise<boolean> {
  const sup = supervisorFor()
  if (!sup) {
    warn('restartEngineDaemon: unsupported platform for engine supervision', { platform: process.platform })
    return false
  }
  const opts = toSupervisorOpts(READINESS_DEFAULTS)
  try {
    await sup.start(true, opts)
    await waitForEngineSocket(READINESS_DEFAULTS)
    log('restartEngineDaemon: engine recycled (re-reading engine.json)', { supervisor: sup.name })
    return true
  } catch (err: any) {
    log('restartEngineDaemon: restart failed', { supervisor: sup.name, error: err.message })
    return false
  }
}
