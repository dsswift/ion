/**
 * Read a file's raw bytes for a client that must hand it to its own
 * operating system.
 *
 * `fs.readFile` returns text for an editor. A Word document or a PDF is not
 * text, and when it lives on a remote Environment the client's machine has no
 * copy to open. This returns the bytes as base64 so the client can write a
 * local copy and open that. The cap matches what a client may store as an
 * attachment, so anything the operator could attach, they can also open.
 */
import { readFileSync, statSync } from 'fs'
import { isValidProjectPath } from '../ipc-validation'
import { log as _log, warn as _warn } from '../logger'
import { MAX_FILE_DATA_BYTES } from '@ion/shared/file-link'

const TAG = 'read-file-data'

export interface FileData {
  base64: string
  size: number
}

/** Returns `null` (after logging why) when the path is invalid, missing, not a file, or over the cap. */
export function readFileData(request: unknown): FileData | null {
  const filePath = (request as { filePath?: unknown } | null)?.filePath
  if (typeof filePath !== 'string' || !isValidProjectPath(filePath)) {
    _warn(TAG, 'rejected file data read: invalid path', { path_type: typeof filePath })
    return null
  }
  try {
    const st = statSync(filePath)
    if (!st.isFile()) {
      _warn(TAG, 'rejected file data read: not a file', { path: filePath })
      return null
    }
    if (st.size > MAX_FILE_DATA_BYTES) {
      _warn(TAG, 'rejected file data read: over the size limit', { path: filePath, bytes: st.size, limit: MAX_FILE_DATA_BYTES })
      return null
    }
    const bytes = readFileSync(filePath)
    _log(TAG, 'file data read', { path: filePath, bytes: bytes.length })
    return { base64: bytes.toString('base64'), size: bytes.length }
  } catch (err) {
    _warn(TAG, 'file data read failed', { path: filePath, error: String(err) })
    return null
  }
}
