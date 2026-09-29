import { host } from './host/host-instance'
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
  // logWrite is real for BOTH hosts: ElectronStudioHost's shell IS window.ion
  // (the preload contextBridge), and BrowserStudioHost's unsupportedShell()
  // overrides logWrite specifically so it has a real POST /log transport
  // (spec 18) -- it is the one shell method a browser tab actually
  // implements. The old `window.ion &&` guard predates BrowserStudioHost and
  // silently dropped every renderer log (including RootErrorBoundary's own
  // crash reports) in a real browser tab, where window.ion is never defined
  // by design. Checking that logWrite itself is callable is what the
  // "bridge not loaded yet" guard actually needs (e.g. a renderer unit test
  // with no host configured at all), without excluding a real browser host.
  if (typeof host.shell?.logWrite === 'function') {
    host.shell.logWrite(level, tag, msg, fields)
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
