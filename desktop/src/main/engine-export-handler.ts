/**
 * Handler for the `engine_export` event emitted by the engine's
 * dispatchExport when a user runs `/export [format]`.
 *
 * The engine emits the rendered output (markdown, json, html, or jsonl)
 * as a single `engine_export` event with the payload on `message`, then
 * follows it with the standard `engine_command_result`. The desktop's
 * job is to surface a save-as dialog so the user can choose where to
 * write the file.
 *
 * Format selection lives at the engine layer (driven by /export's
 * args). The engine reports the resolved format on the event's
 * `exportFormat` field, so the desktop maps it directly to a file
 * extension for the save dialog — no payload sniffing. The user can
 * change the extension freely; we don't enforce it.
 *
 * No UI is rendered for the event itself — the engine_command_result
 * arrives shortly after and the existing conversation-result handling
 * surfaces any error there. Cancelling the save dialog is silent
 * (no system message).
 */

import { join } from 'path'
import { writeFile } from 'fs/promises'
import { dialog, app } from 'electron'
import { log as _log } from './logger'

const TAG = 'ExportHandler'

function log(msg: string): void {
  _log(TAG, msg)
}

/**
 * Map the engine-reported export format to a file extension for the save
 * dialog. The engine resolves the format from the /export args and reports
 * it on `engine_export.exportFormat`, so we map it directly — no payload
 * sniffing. Falls back to `md` only when the format is absent (a legacy
 * engine that predates the exportFormat field, or an unrecognized value).
 *
 * This is a hint for the save dialog only; the user is free to type a
 * different filename. We do not transform the payload.
 */
function extensionForFormat(format: string | undefined): string {
  switch (format) {
    case 'markdown':
      return 'md'
    case 'json':
      return 'json'
    case 'html':
      return 'html'
    case 'jsonl':
      return 'jsonl'
    default:
      // Absent (legacy engine) or unrecognized format: default to markdown,
      // the engine's own /export default.
      return 'md'
  }
}

/**
 * Default filename for the save dialog. Uses ISO date for chronology
 * and a short uuid-like suffix so repeated exports of the same
 * conversation don't collide in the user's downloads folder.
 */
function defaultExportFilename(extension: string): string {
  const iso = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const suffix = Math.random().toString(36).slice(2, 8)
  return `ion-conversation-${iso}-${suffix}.${extension}`
}

/**
 * Show a save-as dialog and write the engine_export payload to the
 * chosen path. Errors are logged but not surfaced to the renderer
 * beyond the existing engine_command_result emission — the user can
 * retry by re-running /export.
 *
 * Returns silently when:
 *   - The main window is not yet available (engine emitted during
 *     window-init, which shouldn't happen but we guard anyway).
 *   - The user cancels the dialog.
 *   - The payload is empty (zero-byte export — probably a fresh
 *     conversation; no need to save an empty file).
 */
export async function handleExportEvent(payload: string, format?: string): Promise<void> {
  // Lazy-load `state` so this module's top-level import graph does not
  // pull in engine-bridge / electron at module-load time. That lets the
  // engine-control-plane tests mock electron without triggering the
  // "Cannot access 'mockBridge' before initialization" hoist hazard that
  // would arise from `import { state } from './state'` at the top.
  const { state } = await import('./state')

  if (!state.mainWindow) {
    log('export: no main window; dropping payload')
    return
  }
  if (!payload) {
    log('export: empty payload; skipping save dialog')
    return
  }

  const extension = extensionForFormat(format)
  const defaultName = defaultExportFilename(extension)
  log(`export: prompting save dialog format=${format ?? 'absent'} extension=${extension} payloadBytes=${payload.length}`)

  try {
    const result = await dialog.showSaveDialog(state.mainWindow, {
      title: 'Export Ion conversation',
      defaultPath: join(app.getPath('downloads'), defaultName),
      filters: [
        { name: extension.toUpperCase(), extensions: [extension] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })

    if (result.canceled || !result.filePath) {
      log('export: user cancelled save dialog')
      return
    }

    await writeFile(result.filePath, payload, 'utf-8')
    log(`export: wrote ${payload.length} bytes to ${result.filePath}`)
  } catch (err) {
    log(`export: save failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
