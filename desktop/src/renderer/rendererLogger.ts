/**
 * Structured logger for renderer-side code.
 *
 * Routes all log writes through the preload contextBridge to the main process,
 * which stamps component=desktop and persists them in ~/.ion/desktop.jsonl via
 * the shared desktop logger. Renderer code must not import main/logger.ts
 * directly (it is Electron-bound and requires Node.js APIs).
 *
 * API mirrors main/logger.ts (trace/debug/info/warn/error). The optional
 * `fields` map is forwarded as a structured object; the IPC layer serialises it
 * via the structured clone algorithm so plain objects with any JSON-serialisable
 * values are safe. Do not pass class instances or functions.
 *
 * Usage:
 *   import { rTrace, rDebug, rInfo, rWarn, rError } from './rendererLogger'
 *   rInfo('MyComponent', 'panel opened', { tabId: id })
 */

function emit(level: string, tag: string, msg: string, fields?: Record<string, unknown>): void {
  // window.ion is the contextBridge API exposed by the preload. Guard against
  // the bridge not yet being loaded (e.g. renderer unit tests that don't
  // configure the preload).
  if (typeof window !== 'undefined' && window.ion && typeof window.ion.logWrite === 'function') {
    window.ion.logWrite(level, tag, msg, fields)
  }
}

/** Log at TRACE level (below DEBUG). Use for high-frequency internal tracing. */
export function rTrace(tag: string, msg: string, fields?: Record<string, unknown>): void {
  emit('TRACE', tag, msg, fields)
}

/** Log at DEBUG level. */
export function rDebug(tag: string, msg: string, fields?: Record<string, unknown>): void {
  emit('DEBUG', tag, msg, fields)
}

/** Log at INFO level. */
export function rInfo(tag: string, msg: string, fields?: Record<string, unknown>): void {
  emit('INFO', tag, msg, fields)
}

/** Log at WARN level. */
export function rWarn(tag: string, msg: string, fields?: Record<string, unknown>): void {
  emit('WARN', tag, msg, fields)
}

/** Log at ERROR level. */
export function rError(tag: string, msg: string, fields?: Record<string, unknown>): void {
  emit('ERROR', tag, msg, fields)
}
