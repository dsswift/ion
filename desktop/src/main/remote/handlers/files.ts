import { join } from 'path'
import { tmpdir } from 'os'
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { log as _log } from '../../logger'
import { state } from '../../state'
import { isValidProjectPath } from '../../ipc-validation'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

export async function handleFsListDir(cmd: Extract<RemoteCommand, { type: 'desktop_fs_list_dir' }>, deviceId: string): Promise<void> {
  const { directory, includeHidden } = cmd
  try {
    if (!isValidProjectPath(directory)) {
      state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_fs_dir_listing', directory, entries: [], error: 'Invalid path' })
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
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_fs_dir_listing', directory, entries })
  } catch (err) {
    log(`fs_list_dir error: ${(err as Error).message}`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_fs_dir_listing', directory, entries: [], error: (err as Error).message })
  }
}

/** Mime sniff by extension. Matches the engine's supported image set. */
function imageMimeForExt(filePath: string): string | null {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return null
}

export async function handleFsReadImage(cmd: Extract<RemoteCommand, { type: 'desktop_fs_read_image' }>): Promise<void> {
  const { filePath } = cmd
  try {
    const mime = imageMimeForExt(filePath)
    if (!mime) {
      state.remoteTransport?.send({ type: 'desktop_fs_image_content', filePath, dataUrl: null, error: 'Unsupported image extension' })
      return
    }
    if (!filePath || !existsSync(filePath)) {
      state.remoteTransport?.send({ type: 'desktop_fs_image_content', filePath, dataUrl: null, error: 'File not found' })
      return
    }
    const st = statSync(filePath)
    if (st.size > 10 * 1024 * 1024) {
      state.remoteTransport?.send({ type: 'desktop_fs_image_content', filePath, dataUrl: null, error: 'Image too large (>10MB)' })
      return
    }
    const buf = readFileSync(filePath)
    state.remoteTransport?.send({ type: 'desktop_fs_image_content', filePath, dataUrl: `data:${mime};base64,${buf.toString('base64')}` })
  } catch (err) {
    log(`fs_read_image error: ${(err as Error).message}`)
    state.remoteTransport?.send({ type: 'desktop_fs_image_content', filePath, dataUrl: null, error: (err as Error).message })
  }
}

export async function handleFsReadFile(cmd: Extract<RemoteCommand, { type: 'desktop_fs_read_file' }>, deviceId: string): Promise<void> {
  const { filePath } = cmd
  try {
    if (!isValidProjectPath(filePath)) {
      state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_fs_file_content', filePath, content: null, error: 'Invalid path' })
      return
    }
    const st = statSync(filePath)
    if (st.size > 2 * 1024 * 1024) {
      state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_fs_file_content', filePath, content: null, error: 'File too large (>2MB)' })
      return
    }
    const buf = readFileSync(filePath)
    const check = buf.subarray(0, Math.min(8192, buf.length))
    if (check.includes(0)) {
      state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_fs_file_content', filePath, content: null, error: 'Binary file' })
      return
    }
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_fs_file_content', filePath, content: buf.toString('utf-8') })
  } catch (err) {
    log(`fs_read_file error: ${(err as Error).message}`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_fs_file_content', filePath, content: null, error: (err as Error).message })
  }
}

export async function handleFsWriteFile(cmd: Extract<RemoteCommand, { type: 'desktop_fs_write_file' }>): Promise<void> {
  const { filePath, content } = cmd
  try {
    if (!isValidProjectPath(filePath)) {
      state.remoteTransport?.send({ type: 'desktop_fs_write_result', filePath, ok: false, error: 'Invalid path' })
      return
    }
    writeFileSync(filePath, content, 'utf-8')
    state.remoteTransport?.send({ type: 'desktop_fs_write_result', filePath, ok: true })
  } catch (err) {
    log(`fs_write_file error: ${(err as Error).message}`)
    state.remoteTransport?.send({ type: 'desktop_fs_write_result', filePath, ok: false, error: (err as Error).message })
  }
}

/**
 * Rename a file or directory at the request of a remote (iOS) client.
 *
 * Mirrors the local IPC handler in `desktop/src/main/ipc/files.ts` —
 * both ends validate `oldPath` and `newPath` against `isValidProjectPath`
 * so a paired iOS client cannot rename arbitrary system files. On
 * success/failure we emit `fs_rename_result`; the iOS event handler
 * re-issues `fs_list_dir` on the parent directory to refresh the
 * listing.
 *
 * No pre-check for an existing target — `renameSync` will overwrite on
 * most platforms; we let the OS surface ENOTDIR / EEXIST / EISDIR via
 * the catch block. Symmetry with the IPC handler is intentional. If
 * we ever want a "target exists" pre-check it must be added to both
 * the IPC and remote handlers in lockstep.
 */
export async function handleFsRename(cmd: Extract<RemoteCommand, { type: 'desktop_fs_rename' }>): Promise<void> {
  const { oldPath, newPath } = cmd
  log(`fs_rename: start oldPath=${oldPath} newPath=${newPath}`)
  try {
    if (!isValidProjectPath(oldPath) || !isValidProjectPath(newPath)) {
      log(`fs_rename: rejected oldPath=${oldPath} newPath=${newPath} reason=invalid_path`)
      state.remoteTransport?.send({ type: 'desktop_fs_rename_result', oldPath, newPath, ok: false, error: 'Invalid path' })
      return
    }
    renameSync(oldPath, newPath)
    log(`fs_rename: success oldPath=${oldPath} newPath=${newPath}`)
    state.remoteTransport?.send({ type: 'desktop_fs_rename_result', oldPath, newPath, ok: true })
  } catch (err) {
    const message = (err as Error).message
    log(`fs_rename: failed oldPath=${oldPath} newPath=${newPath} error=${message}`)
    state.remoteTransport?.send({ type: 'desktop_fs_rename_result', oldPath, newPath, ok: false, error: message })
  }
}

export async function handleUploadAttachment(cmd: Extract<RemoteCommand, { type: 'desktop_upload_attachment' }>, deviceId: string): Promise<void> {
  try {
    const match = cmd.dataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) {
      state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_upload_attachment_result', id: '', name: cmd.name, path: '', correlationId: cmd.correlationId, error: 'Invalid data URL format' })
      return
    }
    const [, , base64Data] = match
    const buf = Buffer.from(base64Data, 'base64')
    const timestamp = Date.now()
    // Derive extension from the original filename
    const nameExt = cmd.name.includes('.') ? cmd.name.substring(cmd.name.lastIndexOf('.')) : '.bin'
    const filePath = join(tmpdir(), `ion-remote-${timestamp}${nameExt}`)
    writeFileSync(filePath, buf)
    const id = crypto.randomUUID()
    log(`upload_attachment: saved ${buf.length} bytes to ${filePath}`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_upload_attachment_result', id, name: cmd.name, path: filePath, correlationId: cmd.correlationId })
  } catch (err) {
    log(`upload_attachment error: ${(err as Error).message}`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_upload_attachment_result', id: '', name: cmd.name, path: '', correlationId: cmd.correlationId, error: (err as Error).message })
  }
}
