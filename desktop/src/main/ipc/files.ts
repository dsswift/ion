import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '../../shared/types'
import { state, fileWatchers, recentlyWrittenPaths } from '../state'
import { broadcast } from '../broadcast'
import { showWindow } from '../window-manager'
import { execFileSync } from 'child_process'
import type { FsEntry } from '../../shared/types'
import { isValidProjectPath } from '../ipc-validation'
import { debug, log, warn } from '../logger'

export function registerFilesIpc(): void {
  ipcMain.handle(IPC.FS_READ_DIR, async (_event, { directory }: { directory: string }) => {
    if (!isValidProjectPath(directory)) return { entries: [], error: 'Invalid path' }
    try {
      const dirents = readdirSync(directory, { withFileTypes: true })
      const entries: FsEntry[] = []
      const winHidden = windowsHiddenNames(directory)
      for (const d of dirents) {
        if (d.name === '.DS_Store') continue
        const fullPath = join(directory, d.name)
        try {
          const st = statSync(fullPath)
          entries.push({
            name: d.name,
            path: fullPath,
            isDirectory: d.isDirectory(),
            size: st.size,
            modifiedMs: st.mtimeMs,
            // A dot prefix on every platform, plus the Windows hidden
            // attribute — AppData and ProgramData carry no dot but are hidden,
            // and a renderer cannot see that bit.
            isHidden: d.name.startsWith('.') || winHidden.has(d.name),
          })
        } catch { /* silent-ok: skip entries that vanish or are unreadable mid-listing */ }
      }
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      return { entries }
    } catch (err: any) {
      return { entries: [], error: err.message }
    }
  })

  ipcMain.handle(IPC.FS_READ_FILE, async (_event, { filePath }: { filePath: string }) => {
    if (!isValidProjectPath(filePath)) return { content: null, error: 'Invalid path' }
    try {
      const st = statSync(filePath)
      if (st.size > 2 * 1024 * 1024) return { content: null, error: 'File too large (>2MB)' }
      const buf = readFileSync(filePath)
      const check = buf.subarray(0, Math.min(8192, buf.length))
      if (check.includes(0)) return { content: null, error: 'Binary file' }
      return { content: buf.toString('utf-8') }
    } catch (err: any) {
      return { content: null, error: err.message }
    }
  })

  ipcMain.handle(IPC.FS_WRITE_FILE, async (_event, { filePath, content }: { filePath: string; content: string }) => {
    if (!isValidProjectPath(filePath)) return { ok: false, error: 'Invalid path' }
    const isWatched = fileWatchers.has(filePath)
    if (isWatched) recentlyWrittenPaths.add(filePath)
    try {
      writeFileSync(filePath, content, 'utf-8')
      if (isWatched) setTimeout(() => recentlyWrittenPaths.delete(filePath), 500)
      return { ok: true }
    } catch (err: any) {
      if (isWatched) recentlyWrittenPaths.delete(filePath)
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.FS_CREATE_DIR, async (_event, { dirPath }: { dirPath: string }) => {
    if (!isValidProjectPath(dirPath)) return { ok: false, error: 'Invalid path' }
    try {
      mkdirSync(dirPath, { recursive: true })
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.FS_CREATE_FILE, async (_event, { filePath }: { filePath: string }) => {
    if (!isValidProjectPath(filePath)) return { ok: false, error: 'Invalid path' }
    try {
      if (existsSync(filePath)) return { ok: false, error: 'File already exists' }
      writeFileSync(filePath, '', 'utf-8')
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.FS_RENAME, async (_event, { oldPath, newPath }: { oldPath: string; newPath: string }) => {
    if (!isValidProjectPath(oldPath) || !isValidProjectPath(newPath)) return { ok: false, error: 'Invalid path' }
    try {
      renameSync(oldPath, newPath)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.FS_DELETE, async (_event, { targetPath }: { targetPath: string }) => {
    if (!isValidProjectPath(targetPath)) return { ok: false, error: 'Invalid path' }
    try {
      rmSync(targetPath, { recursive: true, force: true })
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.FS_SAVE_DIALOG, async (event, payload: unknown) => {
    const args = payload != null && typeof payload === 'object'
      ? payload as { defaultPath?: unknown; defaultFileName?: unknown }
      : {}
    const { defaultPath, defaultFileName } = args
    const sender = BrowserWindow.fromWebContents(event.sender)
    const isOverlay = sender != null && sender === state.mainWindow
    if (isOverlay) state.mainWindow!.hide()

    if (defaultPath != null && (typeof defaultPath !== 'string' || !isValidProjectPath(defaultPath))) {
      warn('files', 'save dialog rejected invalid default path')
      if (isOverlay) showWindow('dialog-return')
      return { filePath: null, error: 'Invalid default path' }
    }
    let resolvedDefaultPath = defaultPath || undefined
    if (defaultFileName != null) {
      if (typeof defaultFileName !== 'string' || defaultFileName.length === 0 || /[/\\\0\r\n]/.test(defaultFileName)) {
        warn('files', 'save dialog rejected invalid default filename', { default_file_name: defaultFileName })
        if (isOverlay) showWindow('dialog-return')
        return { filePath: null, error: 'Invalid default filename' }
      }
      resolvedDefaultPath = join(app.getPath('downloads'), defaultFileName)
    }

    log('files', 'opening save dialog', {
      sender_window: isOverlay ? 'overlay' : sender ? 'application' : 'unowned',
      default_path: resolvedDefaultPath ?? '',
    })
    try {
      const options = { defaultPath: resolvedDefaultPath }
      const result = sender
        ? await dialog.showSaveDialog(sender, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) {
        log('files', 'save dialog cancelled')
        return { filePath: null }
      }
      log('files', 'save dialog selected path', { path: result.filePath })
      return { filePath: result.filePath }
    } catch (error) {
      warn('files', 'save dialog failed', { error: String(error) })
      return { filePath: null, error: String(error) }
    } finally {
      if (isOverlay) showWindow('dialog-return')
    }
  })

  ipcMain.handle(IPC.FS_REVEAL_IN_FINDER, async (_event, { targetPath }: { targetPath: string }) => {
    if (!isValidProjectPath(targetPath)) return
    shell.showItemInFolder(targetPath)
  })

  ipcMain.handle(IPC.FS_OPEN_NATIVE, async (_event, { targetPath }: { targetPath: string }) => {
    if (!isValidProjectPath(targetPath)) return { ok: false, error: 'Invalid path' }
    try {
      const err = await shell.openPath(targetPath)
      if (err) return { ok: false, error: err }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.FS_EXISTS, async (_event, { targetPath }: { targetPath: string }) => {
    if (!isValidProjectPath(targetPath)) return { exists: false }
    try {
      return { exists: existsSync(targetPath) }
    } catch {
      return { exists: false }
    }
  })

  ipcMain.handle(IPC.FS_WATCH_FILE, async (_event, { filePath }: { filePath: string }) => {
    if (!isValidProjectPath(filePath)) return { ok: false, error: 'Invalid path' }
    try {
      const existing = fileWatchers.get(filePath)
      if (existing) {
        existing.refCount++
        return { ok: true }
      }
      const watcher = watch(filePath, (eventType) => {
        if (eventType !== 'change') return
        if (recentlyWrittenPaths.has(filePath)) return
        const entry = fileWatchers.get(filePath)
        if (!entry) return
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
        entry.debounceTimer = setTimeout(() => {
          entry.debounceTimer = null
          broadcast(IPC.FS_FILE_CHANGED, filePath)
        }, 100)
      })
      watcher.on('error', () => {
        const entry = fileWatchers.get(filePath)
        if (entry) {
          if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
          entry.watcher.close()
          fileWatchers.delete(filePath)
        }
      })
      fileWatchers.set(filePath, { watcher, refCount: 1, debounceTimer: null })
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.FS_UNWATCH_FILE, async (_event, { filePath }: { filePath: string }) => {
    const entry = fileWatchers.get(filePath)
    if (!entry) return { ok: true }
    entry.refCount--
    if (entry.refCount <= 0) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.watcher.close()
      fileWatchers.delete(filePath)
    }
    return { ok: true }
  })
}

/**
 * Names in `directory` carrying the Windows hidden attribute.
 *
 * Node's fs.Stats does not expose FILE_ATTRIBUTE_HIDDEN, and most hidden
 * Windows paths have no leading dot — AppData, ProgramData, and the legacy
 * junctions are all marked by the attribute alone. Without this they rendered
 * identically to ordinary source folders.
 *
 * One PowerShell call per listing rather than one per entry, and empty on
 * every non-Windows platform (where the dot prefix is the whole convention).
 * A failure returns empty rather than throwing: losing the dimming on a
 * directory is a cosmetic degradation, while failing the listing would empty
 * the tree.
 *
 * Exported so the desktop↔iOS remote listing handler
 * (`remote/handlers/files.ts`) computes the same `isHidden` bit rather than
 * reimplementing the probe — the remote wire is a second consumer of the
 * same fact, not a second definition of it.
 */
export function windowsHiddenNames(directory: string): Set<string> {
  if (process.platform !== 'win32') return new Set()
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        // -Force includes hidden entries; the Hidden attribute test is what
        // selects them. Names only, one per line.
        `Get-ChildItem -LiteralPath '${directory.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue | ` +
          'Where-Object { $_.Attributes -band [System.IO.FileAttributes]::Hidden } | ' +
          'ForEach-Object { $_.Name }',
      ],
      { encoding: 'utf-8', timeout: 5000, windowsHide: true },
    )
    return new Set(out.split(/\r?\n/).map((n) => n.trim()).filter(Boolean))
  } catch (err) {
    debug('fs', 'windows hidden-attribute probe failed; entries render unhidden', {
      directory,
      error: String(err),
    })
    return new Set()
  }
}
