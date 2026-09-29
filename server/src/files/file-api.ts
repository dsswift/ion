/**
 * file-api — filesystem reads and writes for the Explorer and the file
 * editor, headless.
 *
 * These bodies used to live inside `desktop/src/main/ipc/files.ts`, behind
 * `ipcMain.handle`, which made them Electron-only by accident: every one is
 * plain `fs` work against a path the shared validator already checks. A
 * browser Studio client consequently rendered the Explorer as a root node
 * with no children and every file as "preview is not available" — the
 * `filesDirect` capability was false because there was no transport, not
 * because the server could not read a directory.
 *
 * The genuinely native operations stay in the Electron layer and are NOT
 * here: the save dialog, Reveal in Finder, and Open With are OS shell
 * integrations with no server-side meaning. A browser client still refuses
 * those three, correctly.
 *
 * `emitFileChanged` is injected rather than imported so the watcher's change
 * notification reaches whichever fan-out the host uses — `studio_event` on
 * the server, `webContents.send` in Electron — while the debounce and
 * refcount logic stays in one place.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'fs'
import { join } from 'path'
import type { FsEntry } from '@ion/shared/types'
import { isValidProjectPath } from '../ipc-validation'
import { fileWatchers, recentlyWrittenPaths } from '../state'
import { windowsHiddenNames } from '../remote/handlers/files'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('file-api', msg, fields)
}

/** Largest file the editor will read. Beyond this the caller gets a typed refusal, not a truncated buffer. */
const MAX_READ_BYTES = 2 * 1024 * 1024

export interface ReadDirResult { entries: FsEntry[]; error?: string }
export interface ReadFileResult { content: string | null; error?: string }
export interface OkResult { ok: boolean; error?: string }

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * `includeHidden: false` leaves hidden entries out of the listing, for a
 * client that would only discard them. Absent, every entry is listed with its
 * `isHidden` flag, which is what the Explorer filters on itself.
 */
export function fsReadDir(payload: unknown): ReadDirResult {
  const directory = str((payload as { directory?: unknown } | null)?.directory)
  const dropHidden = (payload as { includeHidden?: unknown } | null)?.includeHidden === false
  if (!isValidProjectPath(directory)) return { entries: [], error: 'Invalid path' }
  try {
    const dirents = readdirSync(directory, { withFileTypes: true })
    const entries: FsEntry[] = []
    const winHidden = windowsHiddenNames(directory)
    for (const d of dirents) {
      if (d.name === '.DS_Store') continue
      const isHidden = d.name.startsWith('.') || winHidden.has(d.name)
      if (dropHidden && isHidden) continue
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
          isHidden,
        })
      } catch { /* silent-ok: skip entries that vanish or are unreadable mid-listing */ }
    }
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    log('directory listed', { directory, entries: entries.length, hidden_dropped: dropHidden })
    return { entries }
  } catch (err) {
    return { entries: [], error: (err as Error).message }
  }
}

/**
 * `maxBytes` lowers the size a caller will accept, for a route that cannot
 * carry the editor's limit in one frame. It never raises it.
 */
export function fsReadFile(payload: unknown): ReadFileResult {
  const filePath = str((payload as { filePath?: unknown } | null)?.filePath)
  if (!isValidProjectPath(filePath)) return { content: null, error: 'Invalid path' }
  const asked = (payload as { maxBytes?: unknown } | null)?.maxBytes
  const limit = typeof asked === 'number' && asked > 0 ? Math.min(Math.floor(asked), MAX_READ_BYTES) : MAX_READ_BYTES
  try {
    const st = statSync(filePath)
    if (st.size > limit) {
      log('file read refused: over the size limit', { path: filePath, bytes: st.size, limit })
      return { content: null, error: limit === MAX_READ_BYTES ? 'File too large (>2MB)' : `File too large (>${limit} bytes)` }
    }
    const buf = readFileSync(filePath)
    const check = buf.subarray(0, Math.min(8192, buf.length))
    if (check.includes(0)) return { content: null, error: 'Binary file' }
    return { content: buf.toString('utf-8') }
  } catch (err) {
    return { content: null, error: (err as Error).message }
  }
}

export function fsWriteFile(payload: unknown): OkResult {
  const filePath = str((payload as { filePath?: unknown } | null)?.filePath)
  const content = str((payload as { content?: unknown } | null)?.content)
  if (!isValidProjectPath(filePath)) return { ok: false, error: 'Invalid path' }
  // A write to a watched path would otherwise bounce straight back as an
  // external-change notification; the suppression window covers the watcher's
  // own event for this write.
  const isWatched = fileWatchers.has(filePath)
  if (isWatched) recentlyWrittenPaths.add(filePath)
  try {
    writeFileSync(filePath, content, 'utf-8')
    if (isWatched) setTimeout(() => recentlyWrittenPaths.delete(filePath), 500)
    return { ok: true }
  } catch (err) {
    if (isWatched) recentlyWrittenPaths.delete(filePath)
    return { ok: false, error: (err as Error).message }
  }
}

export function fsCreateDir(payload: unknown): OkResult {
  const dirPath = str((payload as { dirPath?: unknown } | null)?.dirPath)
  if (!isValidProjectPath(dirPath)) return { ok: false, error: 'Invalid path' }
  try {
    mkdirSync(dirPath, { recursive: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function fsCreateFile(payload: unknown): OkResult {
  const filePath = str((payload as { filePath?: unknown } | null)?.filePath)
  if (!isValidProjectPath(filePath)) return { ok: false, error: 'Invalid path' }
  try {
    if (existsSync(filePath)) return { ok: false, error: 'File already exists' }
    writeFileSync(filePath, '', 'utf-8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function fsRename(payload: unknown): OkResult {
  const oldPath = str((payload as { oldPath?: unknown } | null)?.oldPath)
  const newPath = str((payload as { newPath?: unknown } | null)?.newPath)
  if (!isValidProjectPath(oldPath) || !isValidProjectPath(newPath)) return { ok: false, error: 'Invalid path' }
  try {
    renameSync(oldPath, newPath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function fsDelete(payload: unknown): OkResult {
  const targetPath = str((payload as { targetPath?: unknown } | null)?.targetPath)
  if (!isValidProjectPath(targetPath)) return { ok: false, error: 'Invalid path' }
  try {
    rmSync(targetPath, { recursive: true, force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function fsExists(payload: unknown): { exists: boolean } {
  const targetPath = str((payload as { targetPath?: unknown } | null)?.targetPath)
  if (!isValidProjectPath(targetPath)) return { exists: false }
  try {
    return { exists: existsSync(targetPath) }
  } catch {
    return { exists: false }
  }
}

/**
 * Start (or ref-count up) a watch on one file. `emitFileChanged` is called
 * with the path on a debounced external change; writes this process just
 * made are suppressed by `recentlyWrittenPaths`.
 */
export function fsWatchFile(payload: unknown, emitFileChanged: (filePath: string) => void): OkResult {
  const filePath = str((payload as { filePath?: unknown } | null)?.filePath)
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
        emitFileChanged(filePath)
      }, 100)
    })
    watcher.on('error', (err) => {
      log('file watcher errored; dropping the watch', { path: filePath, error: String(err) })
      const entry = fileWatchers.get(filePath)
      if (entry) {
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
        entry.watcher.close()
        fileWatchers.delete(filePath)
      }
    })
    fileWatchers.set(filePath, { watcher, refCount: 1, debounceTimer: null })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function fsUnwatchFile(payload: unknown): OkResult {
  const filePath = str((payload as { filePath?: unknown } | null)?.filePath)
  const entry = fileWatchers.get(filePath)
  if (!entry) return { ok: true }
  entry.refCount--
  if (entry.refCount <= 0) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.watcher.close()
    fileWatchers.delete(filePath)
  }
  return { ok: true }
}
