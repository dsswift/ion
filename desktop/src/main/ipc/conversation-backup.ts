// IPC handlers for conversation backup (Layer 5 of the cleanup-safety plan).
//
// Three request/response channels:
//   CONVERSATION_EXPORT_PREVIEW  — fast count + size estimate for a given scope
//   CONVERSATION_EXPORT          — create the zip on disk
//   CONVERSATION_RESTORE_PREVIEW — read manifest from a zip
//   CONVERSATION_RESTORE         — extract a zip into ~/.ion/conversations
//
// One push channel:
//   CONVERSATION_BACKUP_PROGRESS — fired during long-running export so the
//     UI can show "Compressing N of M…"

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { state } from '../state'
import { showWindow } from '../window-manager'
import {
  tabsFileForBackend,
  sessionChainsFileForBackend,
  sessionLabelsFileForBackend,
  getCurrentBackend,
} from '../settings-store'
import { previewExport, runExport, type ExportSources } from '../conversation-backup/export'
import { previewRestore, runRestore, type ConflictPolicy } from '../conversation-backup/restore'
import type { ExportScope } from '../conversation-backup/manifest'

function log(msg: string): void { _log('backup-ipc', msg) }

function buildExportSources(): ExportSources {
  const home = join(homedir(), '.ion')
  return {
    conversationsDir: join(home, 'conversations'),
    tabsFiles: [tabsFileForBackend('api'), tabsFileForBackend('cli')],
    chainsFiles: [sessionChainsFileForBackend('api'), sessionChainsFileForBackend('cli')],
    labelsFiles: [sessionLabelsFileForBackend('api'), sessionLabelsFileForBackend('cli')],
  }
}

function defaultExportFilename(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `ion-conversations-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`
}

function emitProgress(current: number, total: number, label: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(IPC.CONVERSATION_BACKUP_PROGRESS, { current, total, label })
    } catch (err: any) {
      log(`emitProgress: send failed err=${err.message}`)
    }
  }
}

export function registerConversationBackupIpc(): void {
  ipcMain.handle(IPC.CONVERSATION_EXPORT_PREVIEW, async (_event, { scope }: { scope: ExportScope }) => {
    try {
      const sources = buildExportSources()
      const preview = previewExport({ scope, sources })
      log(`export preview: scope=${scope} tabs=${preview.tabCount ?? 'n/a'} conversations=${preview.conversationCount} uncompressed=${preview.totalUncompressedBytes}`)
      return { ok: true, ...preview }
    } catch (err: any) {
      log(`export preview failed: ${err.message}`)
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.CONVERSATION_EXPORT, async (_event, args: { scope: ExportScope; destinationPath?: string }) => {
    try {
      const scope = args?.scope === 'all' ? 'all' : 'currently-open'

      // Resolve destination path. If the renderer didn't pre-pick one (the
      // recommended path for fewer round-trips), prompt the user here.
      let destinationPath = args?.destinationPath
      if (!destinationPath) {
        if (!state.mainWindow) {
          return { ok: false, error: 'No main window to host the save dialog' }
        }
        state.mainWindow.hide()
        const result = await dialog.showSaveDialog(state.mainWindow, {
          title: 'Export Ion conversations',
          defaultPath: join(app.getPath('downloads'), defaultExportFilename()),
          filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
        })
        showWindow('export-save-dialog-return')
        if (result.canceled || !result.filePath) {
          return { ok: false, error: 'cancelled' }
        }
        destinationPath = result.filePath
      }

      const sources = buildExportSources()
      const backendSnapshot = getCurrentBackend()
      const ionVersion = app.getVersion()

      const result = await runExport({
        scope,
        destinationPath,
        sources,
        ionVersion,
        backendSnapshot,
        onProgress: emitProgress,
      })
      return result
    } catch (err: any) {
      log(`export failed: ${err.message}`)
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.CONVERSATION_RESTORE_PREVIEW, async (_event, args: { sourcePath?: string }) => {
    try {
      // If the renderer didn't supply a path, prompt for one.
      let sourcePath = args?.sourcePath
      if (!sourcePath) {
        if (!state.mainWindow) {
          return { ok: false, error: 'No main window to host the open dialog' }
        }
        state.mainWindow.hide()
        const result = await dialog.showOpenDialog(state.mainWindow, {
          title: 'Restore Ion conversations from backup',
          properties: ['openFile'],
          filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
        })
        showWindow('restore-open-dialog-return')
        if (result.canceled || result.filePaths.length === 0) {
          return { ok: false, error: 'cancelled' }
        }
        sourcePath = result.filePaths[0]
      }
      const preview = await previewRestore(sourcePath)
      return { ...preview, sourcePath }
    } catch (err: any) {
      log(`restore preview failed: ${err.message}`)
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.CONVERSATION_RESTORE, async (_event, args: {
    sourcePath: string
    conflictPolicy?: ConflictPolicy
    restoreTabs?: boolean
  }) => {
    try {
      if (!args?.sourcePath) return { ok: false, error: 'sourcePath required' }
      const conflictPolicy: ConflictPolicy = args.conflictPolicy === 'overwrite' || args.conflictPolicy === 'rename'
        ? args.conflictPolicy
        : 'skip'
      const restoreTabs = !!args.restoreTabs

      const home = join(homedir(), '.ion')
      const result = await runRestore({
        zipPath: args.sourcePath,
        conflictPolicy,
        restoreTabs,
        sources: {
          conversationsDir: join(home, 'conversations'),
          ionHomeDir: home,
        },
      })
      return result
    } catch (err: any) {
      log(`restore failed: ${err.message}`)
      return { ok: false, error: err.message }
    }
  })
}
