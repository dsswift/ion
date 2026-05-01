import { dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '../../shared/types'
import { state, fileWatchers, recentlyWrittenPaths } from '../state'
import { broadcast } from '../broadcast'
import { showWindow } from '../window-manager'
import { isValidProjectPath } from '../ipc-validation'

export function registerFilesIpc(): void {
  ipcMain.handle(IPC.FS_READ_DIR, async (_event, { directory }: { directory: string }) => {
    if (!isValidProjectPath(directory)) return { entries: [], error: 'Invalid path' }
    try {
      const dirents = readdirSync(directory, { withFileTypes: true })
      const entries: Array<{ name: string; path: string; isDirectory: boolean; size: number; modifiedMs: number }> = []
      for (const d of dirents) {
        if (d.name === '.DS_Store') continue
        const fullPath = join(directory, d.name)
        try {
          const st = statSync(fullPath)
          entries.push({ name: d.name, path: fullPath, isDirectory: d.isDirectory(), size: st.size, modifiedMs: st.mtimeMs })
        } catch {}
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

  ipcMain.handle(IPC.FS_SAVE_DIALOG, async (_event, { defaultPath }: { defaultPath?: string }) => {
    if (!state.mainWindow) return { filePath: null }
    state.mainWindow.hide()
    const result = await dialog.showSaveDialog(state.mainWindow, { defaultPath: defaultPath || undefined })
    showWindow('dialog-return')
    return { filePath: result.canceled ? null : result.filePath || null }
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
