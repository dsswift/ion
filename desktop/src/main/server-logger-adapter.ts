/**
 * The `@ion/server/logger` that desktop main gets instead of the real one.
 *
 * Desktop main runs a large amount of `@ion/server` code in its OWN process:
 * engine bootstrap, the daemon supervisor, the settings store, machine
 * identity, git, the worktree registry. Every one of those modules logs
 * through `server/src/logger.ts`, and that module writes
 * `<ION_DATA_DIR>/server.jsonl` stamped `component: 'server'`. So lines this
 * process emitted were filed against the server: the wrong file and the wrong
 * surface, at a level nobody had set, with no machine identity, and with no
 * flush at quit. Two processes also kept independent rotation byte-counts for
 * one file, so either could rotate out the other's lines.
 *
 * `mainServerLoggerPlugin` (src/buildtools/renderer-server-stubs.ts) swaps the
 * server logger for this module in the main bundle, so those same modules log
 * to `desktop.jsonl` as `component: 'desktop'` with no change at their call
 * sites. One process, one file, one component.
 *
 * The level, machine identity, flush, and rotation of the desktop's log belong
 * to `main/logger.ts`, which `app-lifecycle` already configures. The setters
 * here are therefore deliberate no-ops rather than a second, competing
 * configuration of the same file.
 */
import {
  log as desktopLog,
  trace as desktopTrace,
  debug as desktopDebug,
  info as desktopInfo,
  warn as desktopWarn,
  error as desktopError,
  flushLogs as desktopFlushLogs,
  type LogLevel,
} from './logger'

export type { LogLevel }

export function log(tag: string, msg: string, fields?: Record<string, unknown>): void {
  desktopLog(tag, msg, fields)
}

export function trace(tag: string, msg: string, fields?: Record<string, unknown>): void {
  desktopTrace(tag, msg, fields)
}

export function debug(tag: string, msg: string, fields?: Record<string, unknown>): void {
  desktopDebug(tag, msg, fields)
}

export function info(tag: string, msg: string, fields?: Record<string, unknown>): void {
  desktopInfo(tag, msg, fields)
}

export function warn(tag: string, msg: string, fields?: Record<string, unknown>): void {
  desktopWarn(tag, msg, fields)
}

export function error(tag: string, msg: string, fields?: Record<string, unknown>): void {
  desktopError(tag, msg, fields)
}

/**
 * The server's `POST /log` route stamps a browser client's forwarded lines
 * `component: 'web'`. That route runs in the server process and never in this
 * one; the export exists so this module is a complete stand-in for the one it
 * replaces. A line that somehow arrives here is recorded rather than dropped,
 * under the desktop's own component, with the caller's `web:` tag intact.
 */
export function logWeb(level: LogLevel, tag: string, msg: string, fields?: Record<string, unknown>): boolean {
  const byLevel = { TRACE: desktopTrace, DEBUG: desktopDebug, INFO: desktopInfo, WARN: desktopWarn, ERROR: desktopError }
  byLevel[level](tag, msg, fields)
  return true
}

/** No-op: `main/logger.ts` owns this process's level (app-lifecycle sets it). */
export function setLogLevel(_level: LogLevel): void {}

/** No-op: `main/logger.ts` owns this process's machine identity. */
export function initLoggerMachineIdentity(_identity: {
  host: string
  machineId: string
  mdmDeviceId: string
  mdmSerial: string
}): void {}

/** No-op: `main/logger.ts` owns this process's rotation and log directory. */
export function configureLogger(_opts: { disableRotation?: boolean; maxGenerations?: number; dir?: string }): void {}

/** The desktop logger's drain, so a server module's shutdown flush reaches the right file. */
export function flushLogs(): void {
  desktopFlushLogs()
}
