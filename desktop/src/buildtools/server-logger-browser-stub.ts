/**
 * server-logger-browser-stub — the Studio renderer's build-time replacement
 * for `server/src/logger.ts`.
 *
 * `server/src/store/sessionStore.ts` is imported directly by every renderer
 * file that reads store state reactively (spec 17: Studio renders against
 * this same module). Its slices call the real server logger pervasively
 * (per this repo's logging policy), and that logger's `logAt()` ships every
 * line to `shipToEgress()`, which spools to a real file via Node's `fs`/
 * `path` — unavailable in a sandboxed Electron renderer, and unresolvable by
 * Rollup's browser build (`__vite-browser-external` has no exports).
 *
 * The renderer is never the log owner — the server process is — so this
 * stub forwards the exact same function signatures to the renderer's own
 * `rendererLogger.ts`, which already routes through the contextBridge to
 * `~/.ion/desktop.jsonl`. Wired in via `electron.vite.config.ts`'s renderer
 * `resolve.alias`, keyed on `server/src/logger.ts`'s resolved absolute path
 * so every relative import (`'./logger'`, `'../logger'`, ...) redirects here
 * regardless of how deep the importing file sits in the server tree.
 */
import { rTrace, rDebug, rInfo, rWarn, rError } from '../renderer/rendererLogger'

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export function setLogLevel(_level: LogLevel): void {
  // The renderer's own log level is controlled by rendererLogger's forward
  // path, not by the server's minLevel — nothing to configure here.
}

export function initLoggerMachineIdentity(_identity: {
  host: string
  machineId: string
  mdmDeviceId: string
  mdmSerial: string
}): void {
  // Machine-identity stamping happens once, in the real server process.
}

export function configureLogger(_opts: { disableRotation?: boolean; maxGenerations?: number }): void {
  // Rotation is a real-filesystem concern; nothing to configure here.
}

export function log(tag: string, msg: string, fields?: Record<string, unknown>): void {
  rInfo(tag, msg, fields)
}

export function trace(tag: string, msg: string, fields?: Record<string, unknown>): void {
  rTrace(tag, msg, fields)
}

export function debug(tag: string, msg: string, fields?: Record<string, unknown>): void {
  rDebug(tag, msg, fields)
}

export function info(tag: string, msg: string, fields?: Record<string, unknown>): void {
  rInfo(tag, msg, fields)
}

export function warn(tag: string, msg: string, fields?: Record<string, unknown>): void {
  rWarn(tag, msg, fields)
}

export function error(tag: string, msg: string, fields?: Record<string, unknown>): void {
  rError(tag, msg, fields)
}

export function flushLogs(): void {
  // rendererLogger forwards immediately over the contextBridge; no buffer to drain.
}

export function _resetForTest(): void {
  // No module-level state to reset in this stub.
}
