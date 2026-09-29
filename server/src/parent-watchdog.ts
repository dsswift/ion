/**
 * parent-watchdog — exit when the process that spawned this server is gone.
 *
 * The desktop spawns the Studio server as a child and stops it on quit. That
 * stop is the primary mechanism; this is the backstop for any exit the
 * desktop does not get to run (a crash, a kill, an exit path that skipped
 * the stop -- which happened: `app.exit()` does not emit `will-quit`, and
 * the stop lived only there). An orphaned server keeps `studio.sock` bound
 * and every tab adopted against the engine, so the next desktop's own server
 * cannot bind and the desktop connects to the orphan instead.
 *
 * The desktop passes its pid as ION_SUPERVISOR_PID. A poll of `kill(pid, 0)`
 * is used rather than `process.ppid`, which on Windows keeps reporting the
 * dead parent's id. A container or `node dist/main.js` run sets no
 * supervisor and gets no watchdog.
 */
import { log as _log, error as _error } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('parent-watchdog', msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error('parent-watchdog', msg, fields)
}

export const PARENT_WATCHDOG_INTERVAL_MS = 2000

export interface ParentWatchdogOptions {
  /** The supervising process's pid. */
  pid: number
  /** Poll interval; defaults to PARENT_WATCHDOG_INTERVAL_MS. */
  intervalMs?: number
  /** Injectable for tests: defaults to a `process.kill(pid, 0)` probe. */
  isAlive?: (pid: number) => boolean
  /** Injectable for tests: defaults to `process.exit`. */
  exit?: (code: number) => void
}

/** True while `kill(pid, 0)` succeeds; ESRCH (no such process) is the one "gone" answer. EPERM means alive but not ours. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Parses ION_SUPERVISOR_PID; null when unset or not a positive integer. */
export function supervisorPidFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.ION_SUPERVISOR_PID
  if (!raw) return null
  const pid = Number(raw)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Start polling for the supervisor's death. Returns a stop function. The
 * timer is unref'd so it never keeps an otherwise-finished process alive.
 */
export function startParentWatchdog(opts: ParentWatchdogOptions): () => void {
  const intervalMs = opts.intervalMs ?? PARENT_WATCHDOG_INTERVAL_MS
  const isAlive = opts.isAlive ?? processIsAlive
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  log('watching supervisor process', { supervisor_pid: opts.pid, interval_ms: intervalMs })
  const timer = setInterval(() => {
    if (isAlive(opts.pid)) return
    clearInterval(timer)
    error('supervisor process is gone; exiting so the next desktop can own the local socket', { supervisor_pid: opts.pid, pid: process.pid })
    exit(0)
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
