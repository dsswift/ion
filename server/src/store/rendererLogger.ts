import { trace, debug, info, warn, error } from '../logger'

/**
 * Store-facing logger shim.
 *
 * The renderer's `rendererLogger.ts` routes every call through the preload
 * contextBridge to the main process because the renderer has no direct
 * filesystem access. The moved session store now runs in-process inside the
 * server (no window, no bridge), so it calls the server's own structured
 * logger directly. Call sites were moved unchanged — same five-function API
 * (`rTrace`/`rDebug`/`rInfo`/`rWarn`/`rError`), same argument order — so no
 * caller needed to change.
 */
export function rTrace(tag: string, msg: string, fields?: Record<string, unknown>): void {
  trace(tag, msg, fields)
}

export function rDebug(tag: string, msg: string, fields?: Record<string, unknown>): void {
  debug(tag, msg, fields)
}

export function rInfo(tag: string, msg: string, fields?: Record<string, unknown>): void {
  info(tag, msg, fields)
}

export function rWarn(tag: string, msg: string, fields?: Record<string, unknown>): void {
  warn(tag, msg, fields)
}

export function rError(tag: string, msg: string, fields?: Record<string, unknown>): void {
  error(tag, msg, fields)
}
