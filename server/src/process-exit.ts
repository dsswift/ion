/**
 * Every way this process ends.
 *
 * Extracted from `main.ts`, which sits at the file-size cap. The signals and
 * the parent watchdog all funnel into the ONE shutdown sequence
 * (`shutdown.ts`), which is what drains the log buffer and the egress sink
 * before the exit -- so a quit records why it happened rather than stopping
 * mid-sequence.
 */
import { log as _log, error as _error } from './logger'
import { runServerShutdown } from './shutdown'
import { sessionPlane, bashProcesses } from './state'
import { startParentWatchdog, supervisorPidFromEnv } from './parent-watchdog'

const TAG = 'process-exit'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error(TAG, msg, fields)
}

/**
 * Wire the signals this server answers.
 *
 * SIGTERM is Quit Desktop: persist, stop the jobs, drop the engine socket,
 * leave sessions running for the grace window. SIGUSR1 is the drain-quit
 * (`make desktop`): wait for active work, then stop the sessions too. The
 * parent watchdog's exit is a crash or a desktop that vanished, which must
 * never stop sessions either.
 */
export function installExitHandlers(): void {
  const exitAfter = (request: { stopSessions: boolean; reason: string }): void => {
    void runServerShutdown(request)
      .catch((err: unknown) => error('shutdown sequence failed; exiting anyway', { reason: request.reason, error: String(err) }))
      .finally(() => process.exit(0))
  }

  process.on('SIGTERM', () => exitAfter({ stopSessions: false, reason: 'SIGTERM' }))
  process.on('SIGUSR1', () => {
    log('SIGUSR1 received; draining active work before stopping sessions')
    sessionPlane.drain(() => bashProcesses.size > 0)
      .then(() => exitAfter({ stopSessions: true, reason: 'SIGUSR1' }))
      .catch((err: unknown) => error('drain before shutdown failed', { error: String(err) }))
  })

  // Spawned by a desktop: exit on our own when it is gone, whatever way it
  // went. See parent-watchdog.ts for the orphan this prevents.
  const supervisorPid = supervisorPidFromEnv()
  if (supervisorPid !== null) {
    startParentWatchdog({ pid: supervisorPid, exit: () => exitAfter({ stopSessions: false, reason: 'supervisor gone' }) })
  } else {
    log('no supervisor pid in environment; running unsupervised')
  }
}
