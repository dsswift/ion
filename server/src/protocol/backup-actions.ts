/**
 * `backup.*` `studio_action`s: the conversation archive export/restore,
 * moved from the desktop's `ipc/conversation-backup.ts`.
 *
 * The archive format and the work live in `conversation-backup/`; these
 * verbs validate the request, point the work at this Environment's data
 * directory, and publish export progress on
 * `ion:conversation-backup-progress` so the settings panel can show
 * "Compressing N of M". The file dialogs that used to sit inside the IPC
 * handlers are the client's: it picks a path with its own host and hands
 * it over, so every path here is explicit and there is no window to host
 * a dialog in.
 *
 * Every path is on the SERVER host. For the local Environment that is the
 * operator's own machine, where the desktop's native dialog also runs; a
 * browser client prompts for a server path (`save-path-prompt.tsx`), which
 * is exactly right because the files being archived are the server's.
 *
 * `admin`: an export reads every conversation the Environment holds, and a
 * restore writes into its conversation store.
 */
import { join } from 'path'
import { dataDir } from '../paths'
import { IPC } from '@ion/shared/types'
import { broadcast } from '../broadcast'
import { readServerVersion } from '../server-version'
import {
  tabsFile,
  sessionChainsFile,
  sessionLabelsFile,
  legacyTabsFileForBackend,
  legacySessionChainsFileForBackend,
  legacySessionLabelsFileForBackend,
} from '../persistence/settings-store'
import { previewExport, runExport, type ExportSources } from '../conversation-backup/export'
import { previewRestore, runRestore, type ConflictPolicy } from '../conversation-backup/restore'
import type { ExportScope } from '../conversation-backup/manifest'
import { log as _log, warn as _warn } from '../logger'
import type { MiscActionSpec } from './misc-actions'
import type { Connection } from './connection'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('backup-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('backup-actions', msg, fields)
}

/** An absolute path with no control characters; the archive location on the server host. */
function validArchivePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length < 4096 && !/[\0\r\n]/.test(value)
}

function exportScope(value: unknown): ExportScope {
  return value === 'all' ? 'all' : 'currently-open'
}

function buildExportSources(): ExportSources {
  return {
    conversationsDir: join(dataDir(), 'conversations'),
    // Unified files first (live sources); legacy per-backend files stay in
    // the export set through the merge-migration window.
    tabsFiles: [tabsFile(), legacyTabsFileForBackend('api'), legacyTabsFileForBackend('cli')],
    chainsFiles: [sessionChainsFile(), legacySessionChainsFileForBackend('api'), legacySessionChainsFileForBackend('cli')],
    labelsFiles: [sessionLabelsFile(), legacySessionLabelsFileForBackend('api'), legacySessionLabelsFileForBackend('cli')],
  }
}

function emitProgress(current: number, total: number, label: string): void {
  broadcast(IPC.CONVERSATION_BACKUP_PROGRESS, { current, total, label })
}

/** The action never throws to the dispatcher: a failure is `{ ok: false, error }`, the shape the panel renders. */
function wrap(name: string, run: (conn: Connection, args: unknown[]) => Promise<unknown>): MiscActionSpec {
  return {
    requiredScope: 'admin',
    handler: async (conn, args) => {
      try {
        return { ok: true, value: await run(conn, args) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warn('backup action failed', { connection_id: conn.id, action: name, error: message })
        return { ok: true, value: { ok: false, error: message } }
      }
    },
  }
}

export const BACKUP_ACTIONS: Record<string, MiscActionSpec> = {
  // [{ scope }] → { ok: true, ...ExportPreview } — a fast count and size estimate.
  'backup.exportPreview': wrap('backup.exportPreview', async (_conn, a) => {
    const scope = exportScope((a[0] as { scope?: unknown } | undefined)?.scope)
    const preview = previewExport({ scope, sources: buildExportSources() })
    log('export_preview', { scope, tab_count: preview.tabCount ?? 'n/a', conversation_count: preview.conversationCount, total_bytes: preview.totalUncompressedBytes })
    return { ok: true, ...preview }
  }),

  // [{ scope, destinationPath }] → ExportResult. Progress rides the channel.
  'backup.export': wrap('backup.export', async (conn, a) => {
    const args = (a[0] ?? {}) as { scope?: unknown; destinationPath?: unknown }
    if (!validArchivePath(args.destinationPath)) {
      warn('export refused: destinationPath missing or invalid', { connection_id: conn.id })
      return { ok: false, error: 'destinationPath required' }
    }
    const scope = exportScope(args.scope)
    log('export: starting', { connection_id: conn.id, scope, destination: args.destinationPath })
    return runExport({
      scope,
      destinationPath: args.destinationPath,
      sources: buildExportSources(),
      ionVersion: readServerVersion(),
      onProgress: emitProgress,
    })
  }),

  // [{ sourcePath }] → { ...RestorePreview, sourcePath } — the archive's manifest.
  'backup.restorePreview': wrap('backup.restorePreview', async (conn, a) => {
    const sourcePath = (a[0] as { sourcePath?: unknown } | undefined)?.sourcePath
    if (!validArchivePath(sourcePath)) {
      warn('restore preview refused: sourcePath missing or invalid', { connection_id: conn.id })
      return { ok: false, error: 'sourcePath required' }
    }
    const preview = await previewRestore(sourcePath)
    return { ...preview, sourcePath }
  }),

  // [{ sourcePath, conflictPolicy?, restoreTabs? }] → RestoreResult.
  'backup.restore': wrap('backup.restore', async (conn, a) => {
    const args = (a[0] ?? {}) as { sourcePath?: unknown; conflictPolicy?: unknown; restoreTabs?: unknown }
    if (!validArchivePath(args.sourcePath)) {
      warn('restore refused: sourcePath missing or invalid', { connection_id: conn.id })
      return { ok: false, error: 'sourcePath required', restored: 0, skipped: 0, overwritten: 0, renamed: 0, errors: [] }
    }
    const conflictPolicy: ConflictPolicy = args.conflictPolicy === 'overwrite' || args.conflictPolicy === 'rename' ? args.conflictPolicy : 'skip'
    const restoreTabs = args.restoreTabs === true
    const home = dataDir()
    log('restore: starting', { connection_id: conn.id, source: args.sourcePath, conflict_policy: conflictPolicy, restore_tabs: restoreTabs })
    return runRestore({
      zipPath: args.sourcePath,
      conflictPolicy,
      restoreTabs,
      sources: { conversationsDir: join(home, 'conversations'), ionHomeDir: home },
    })
  }),
}
