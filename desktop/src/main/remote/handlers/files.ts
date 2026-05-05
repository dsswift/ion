import { join } from 'path'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { log as _log } from '../../logger'
import { state } from '../../state'
import { isValidProjectPath } from '../../ipc-validation'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

export async function handleFsListDir(cmd: Extract<RemoteCommand, { type: 'fs_list_dir' }>): Promise<void> {
  const { directory, includeHidden } = cmd
  try {
    if (!isValidProjectPath(directory)) {
      state.remoteTransport?.send({ type: 'fs_dir_listing', directory, entries: [], error: 'Invalid path' })
      return
    }
    const dirents = readdirSync(directory, { withFileTypes: true })
    const entries: Array<{ name: string; path: string; isDirectory: boolean; size: number; modifiedMs: number }> = []
    for (const d of dirents) {
      if (d.name === '.DS_Store') continue
      if (!includeHidden && d.name.startsWith('.')) continue
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
    state.remoteTransport?.send({ type: 'fs_dir_listing', directory, entries })
  } catch (err) {
    log(`fs_list_dir error: ${(err as Error).message}`)
    state.remoteTransport?.send({ type: 'fs_dir_listing', directory, entries: [], error: (err as Error).message })
  }
}

export async function handleFsReadFile(cmd: Extract<RemoteCommand, { type: 'fs_read_file' }>): Promise<void> {
  const { filePath } = cmd
  try {
    if (!isValidProjectPath(filePath)) {
      state.remoteTransport?.send({ type: 'fs_file_content', filePath, content: null, error: 'Invalid path' })
      return
    }
    const st = statSync(filePath)
    if (st.size > 2 * 1024 * 1024) {
      state.remoteTransport?.send({ type: 'fs_file_content', filePath, content: null, error: 'File too large (>2MB)' })
      return
    }
    const buf = readFileSync(filePath)
    const check = buf.subarray(0, Math.min(8192, buf.length))
    if (check.includes(0)) {
      state.remoteTransport?.send({ type: 'fs_file_content', filePath, content: null, error: 'Binary file' })
      return
    }
    state.remoteTransport?.send({ type: 'fs_file_content', filePath, content: buf.toString('utf-8') })
  } catch (err) {
    log(`fs_read_file error: ${(err as Error).message}`)
    state.remoteTransport?.send({ type: 'fs_file_content', filePath, content: null, error: (err as Error).message })
  }
}

export async function handleFsWriteFile(cmd: Extract<RemoteCommand, { type: 'fs_write_file' }>): Promise<void> {
  const { filePath, content } = cmd
  try {
    if (!isValidProjectPath(filePath)) {
      state.remoteTransport?.send({ type: 'fs_write_result', filePath, ok: false, error: 'Invalid path' })
      return
    }
    writeFileSync(filePath, content, 'utf-8')
    state.remoteTransport?.send({ type: 'fs_write_result', filePath, ok: true })
  } catch (err) {
    log(`fs_write_file error: ${(err as Error).message}`)
    state.remoteTransport?.send({ type: 'fs_write_result', filePath, ok: false, error: (err as Error).message })
  }
}
