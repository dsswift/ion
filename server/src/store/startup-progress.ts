/**
 * Startup progress from the server, for the desktop splash.
 *
 * Tab and session restoration moved into this process with the store, and
 * with it the per-phase and per-tab progress the splash used to show
 * ("Restoring tab 3 of 12…", "Starting restored sessions 2 of 5…"). The
 * server has no window, so each report is published as a `studio_event` on
 * `STARTUP_PROGRESS_CHANNEL`; the desktop relays the LOCAL environment's
 * reports into its startup coordinator, which requires a sequence that only
 * moves forward per source — hence the counter here.
 */
import { STARTUP_PROGRESS_CHANNEL, type StartupReport } from '@ion/shared/startup-state'
import { broadcast } from '../broadcast'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('startup', msg, fields)
}

let sequence = 0
let latest: StartupReport | null = null

/** Publishes one startup report from this server; the sequence advances on every call. */
export function reportStartup(status: string, ready = false, error?: string): StartupReport {
  const report: StartupReport = { source: 'server', sequence: sequence++, status, ready, ...(error ? { error } : {}) }
  latest = report
  log('startup progress', { sequence: report.sequence, status, ready, error: error ?? '' })
  broadcast(STARTUP_PROGRESS_CHANNEL, report)
  return report
}

/**
 * The report a connection attaching should see, or null before restoration
 * has started. The desktop attaches to its own server while the server is
 * already restoring, so the first phases are published before anyone
 * listens; replaying the current one on attach is what lets the splash pick
 * up where the restore actually is.
 *
 * The terminal report (ready, or the error) is replayed too. The desktop
 * reveals its window only once this server has reported ready, and a small
 * workspace restores faster than the desktop's connection opens: with the
 * terminal report withheld, that desktop waited on a ready it had already
 * missed, splash up forever.
 */
export function startupReportForAttach(): StartupReport | null {
  return latest
}

/** Test seam. */
export function _resetStartupSequenceForTest(): void {
  sequence = 0
  latest = null
}
