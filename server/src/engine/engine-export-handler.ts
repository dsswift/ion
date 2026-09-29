/**
 * Handler for the `engine_export` event emitted by the engine's
 * dispatchExport when a user runs `/export [format]`.
 *
 * The real implementation (save-as dialog + file write) is Electron-bound
 * and lives at `desktop/src/main/engine-export-handler.ts` — a headless
 * server has no save dialog to show. This module is the mechanism seam:
 * `engine-control-plane-events.ts` calls `handleExportEvent` unconditionally
 * when it sees the event, and the desktop registers its real implementation
 * via `setExportEventHandler` at startup. A server with no registered
 * handler simply drops the export (logged), the same way the original
 * desktop code silently returned when no main window was available yet.
 */
import { log as _log } from '../logger'

const TAG = 'ExportHandler'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}

export type ExportEventHandler = (payload: string, format?: string) => Promise<void> | void

let exportEventHandler: ExportEventHandler | null = null

/** Registers the real (Electron-bound) export handler. Desktop-only. */
export function setExportEventHandler(handler: ExportEventHandler): void {
  exportEventHandler = handler
}

export async function handleExportEvent(payload: string, format?: string): Promise<void> {
  if (!exportEventHandler) {
    log('export: no handler registered; dropping payload', { format: format ?? 'absent' })
    return
  }
  await exportEventHandler(payload, format)
}
