import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import type { LogLevel } from '../logger'
import { trace, debug, info, warn, error } from '../logger'

/** Valid log levels accepted from the renderer. */
const VALID_LEVELS = new Set<string>(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'])

/**
 * Validate and coerce a renderer-supplied level string to a known LogLevel.
 * Returns 'INFO' for any unrecognised value so malformed renderer calls
 * do not throw but are still observable in the log.
 */
function coerceLevel(raw: unknown): LogLevel {
  if (typeof raw === 'string' && VALID_LEVELS.has(raw.toUpperCase())) {
    return raw.toUpperCase() as LogLevel
  }
  return 'INFO'
}

/**
 * Validate that a fields value coming from the renderer is a plain object.
 * Returns an empty object for anything that is not a non-null object literal,
 * preventing renderer code from accidentally passing a stringified "[object Object]"
 * or an array.
 *
 * This is the regression pin for the [object Object] defect: if the renderer
 * passes a real object, it arrives here as a structured map (IPC serialises it
 * via the structured clone algorithm) and is forwarded unchanged. If it somehow
 * arrives as a string, this guard returns {} rather than logging junk.
 */
function coerceFields(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  return {}
}

/**
 * IPC handler for renderer-side structured logging.
 *
 * Channel: `log:write`
 * Payload: `{ level, tag, msg, fields? }`
 *
 * The main process validates the payload, stamps `component=desktop` (via the
 * shared desktop logger emitters), and writes one canonical JSONL line.
 * Renderer code must never call logger.ts functions directly — the preload
 * bridge + this handler is the only supported path for renderer log writes.
 */
export function registerLogIpc(): void {
  ipcMain.handle(IPC.LOG_WRITE, (_event, payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return

    const p = payload as Record<string, unknown>
    const level = coerceLevel(p['level'])
    const tag = typeof p['tag'] === 'string' ? p['tag'] : 'renderer'
    const msg = typeof p['msg'] === 'string' ? p['msg'] : String(p['msg'] ?? '')
    const fields = coerceFields(p['fields'])

    switch (level) {
      case 'TRACE': trace(tag, msg, fields); break
      case 'DEBUG': debug(tag, msg, fields); break
      case 'INFO':  info(tag, msg, fields);  break
      case 'WARN':  warn(tag, msg, fields);  break
      case 'ERROR': error(tag, msg, fields); break
    }
  })
}
