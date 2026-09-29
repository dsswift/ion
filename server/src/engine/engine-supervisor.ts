/**
 * The engine supervisor abstraction: the per-user OS mechanism that keeps
 * the engine daemon running across sign-in/login and crashes, and that the
 * desktop installs, starts, and stops rather than ever running the engine
 * as its own child process.
 *
 * darwin: a launchd LaunchAgent (engine-supervisor-launchd.ts).
 * win32: a per-user Scheduled Task named "Ion Engine" (engine-supervisor-schtasks.ts).
 * Elsewhere: no supervisor exists; supervisorFor returns null and callers log
 * a WARN and return rather than attempting anything.
 *
 * Manifest contract C2 (windows-mvp program). See docs/vocabulary/terms.json
 * "Engine Supervisor" for the canonical term.
 */
import { launchdSupervisor } from './engine-supervisor-launchd'
import { schtasksSupervisor } from './engine-supervisor-schtasks'

/** Timing and identity inputs every supervisor verb needs. */
export interface SupervisorOpts {
  /** Timeout for a single supervisor command invocation (schtasks / launchctl). */
  commandTimeoutMs: number
  /** Attempts per install/start round (the underlying command can transiently
   *  fail while a just-stopped definition is still tearing down). */
  attempts: number
  /** Settle delay between attempts. */
  settleMs: number
  /** Total budget for the stop-then-verify-refused wait. */
  stopWaitMs: number
  /** Poll interval for the stop-then-verify-refused wait. */
  stopPollMs: number
}

/**
 * One platform's engine-supervision mechanism. install/start/stop are all
 * idempotent — calling any of them when the underlying state already
 * matches is a safe no-op that still logs its outcome.
 */
export interface EngineSupervisor {
  readonly name: 'launchd' | 'schtasks'
  /**
   * Register or refresh the supervisor definition to run binPath. Returns
   * true when the definition text actually changed (a rewritten plist, a
   * re-rendered task XML) — the caller uses this to decide whether a
   * running instance needs a force-restart.
   */
  install(binPath: string, opts: SupervisorOpts): Promise<boolean>
  /**
   * Start the engine under supervision. force restarts an already-running
   * engine (kill + respawn); without force this is a no-op when already
   * running.
   */
  start(force: boolean, opts: SupervisorOpts): Promise<void>
  /** Stop the engine and wait until it no longer accepts connections. */
  stop(opts: SupervisorOpts): Promise<void>
  /** Reports whether the supervisor definition is currently registered. */
  isRegistered(): Promise<boolean>
}

/**
 * Resolves the engine supervisor for platform. Returns null where no
 * supervisor mechanism exists (anything but darwin and win32) — callers
 * must treat that as "unsupported platform for engine supervision" rather
 * than silently doing nothing, per the desktop portability rule.
 */
export function supervisorFor(platform: NodeJS.Platform = process.platform): EngineSupervisor | null {
  if (platform === 'darwin') return launchdSupervisor
  if (platform === 'win32') return schtasksSupervisor
  return null
}
