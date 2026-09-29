/**
 * Which process is doing the shipping.
 *
 * The egress stack runs in two processes at once on a workstation: the server,
 * and Electron's main process, which imports these same modules from
 * `@ion/server`. They share one data directory, so the spool of undelivered
 * batches and the tailer's cursors have to be named per process -- two
 * processes writing one spool file interleave batches and drop each other's
 * cursor positions.
 *
 * It also names the service an OTLP sink sees, which was `ion-desktop` for
 * whoever shipped, so a server's lines would have arrived attributed to a
 * desktop.
 */
import { existsSync, renameSync } from 'fs'
import { join } from 'path'
import { dataDir } from './data-dir'
import { log as _log, warn as _warn } from './log-sink'

export type EgressProcess = 'desktop' | 'server'

/**
 * Defaults to `server`, which is the process this package normally IS. The
 * desktop declares itself when it configures egress (`configureEgress`'s
 * `process` option), before any spool or cursor file is touched.
 */
let current: EgressProcess = 'server'

export function setEgressProcess(proc: EgressProcess): void {
  current = proc
  _log('log_egress', 'egress process identity set', { egress_process: proc })
}

export function egressProcess(): EgressProcess {
  return current
}

/** The OTLP `service.name` when a config does not name one. */
export function defaultEgressServiceName(): string {
  return `ion-${current}`
}

/** `<data dir>/.<process>-egress-<suffix>`. */
export function egressFilePath(suffix: string): string {
  return join(dataDir(), `.${current}-egress-${suffix}`)
}

/**
 * Adopt a pre-rename file.
 *
 * Both files were once shared under one name. The spool holds batches a sink
 * has not accepted yet, so leaving it behind on upgrade would silently strand
 * real log records; the cursors decide where a tailer resumes, and abandoning
 * them re-reads from EOF and loses whatever arrived during the upgrade. The
 * first process to look claims it -- on a workstation that is whichever of the
 * two starts first, and either is correct, because before the rename they were
 * sharing the file anyway.
 */
export function adoptLegacyEgressFile(legacyName: string, current_: string): void {
  const legacy = join(dataDir(), legacyName)
  if (!existsSync(legacy) || existsSync(current_)) return
  try {
    renameSync(legacy, current_)
    _log('log_egress', 'adopted the pre-rename egress file', { from: legacy, to: current_ })
  } catch (err) {
    // Not fatal: the new file is simply created empty, which costs the spool's
    // undelivered batches or one tailer's resume point.
    _warn('log_egress', 'could not adopt the pre-rename egress file', { from: legacy, to: current_, error: String(err) })
  }
}
