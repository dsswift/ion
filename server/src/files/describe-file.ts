/**
 * Describe a file on disk as an attachment row.
 *
 * This is the server-side implementation of what the desktop's
 * `main/ipc/attachments.ts` does for `ATTACH_FILE_BY_PATH`. It moved here
 * because nothing in it needs Electron: it is a stat, an extension lookup, and
 * for a small image a base64 preview plus a content hash. The only reason it
 * lived in the main process was that the main process was the only thing with
 * a filesystem.
 *
 * `host-api-misc.ts` used to answer `attachFileByPath` with a hardcoded
 * `null`, documented as "requires desktop-side plumbing that has not moved
 * server-side yet". That was true when it was written and is the reason a
 * browser client could not attach a file the server could see perfectly well.
 */
import { createHash, randomUUID } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { basename, extname } from 'path'
import { debug as _debug, warn as _warn } from '../logger'

const TAG = 'describe-file'

/** Image previews above this size are skipped; the row keeps its identity without a thumbnail. */
const MAX_INLINE_PREVIEW_BYTES = 2 * 1024 * 1024

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.toml': 'text/toml',
}

export interface DescribedFile {
  id: string
  type: 'image' | 'file'
  name: string
  path: string
  mimeType: string
  contentHash?: string
  dataUrl?: string
  size: number
}

/** Returns `null` when the path cannot be described — missing, unreadable, not a file. */
export function describeFile(filePath: string): DescribedFile | null {
  try {
    const ext = extname(filePath).toLowerCase()
    const mimeType = MIME_MAP[ext] ?? 'application/octet-stream'
    const stat = statSync(filePath)
    const isImage = IMAGE_EXTS.has(ext)

    let dataUrl: string | undefined
    let contentHash: string | undefined
    if (isImage) {
      try {
        const buf = readFileSync(filePath)
        contentHash = createHash('sha256').update(buf).digest('hex')
        if (stat.size < MAX_INLINE_PREVIEW_BYTES) dataUrl = `data:${mimeType};base64,${buf.toString('base64')}`
      } catch (err) {
        // The preview and the content identity are both lost, but the row is
        // still worth returning: a client shows the attachment without a
        // thumbnail rather than dropping a file the user explicitly picked.
        _debug(TAG, 'image preview and hash read failed; describing without them', { path: filePath, error: String(err) })
      }
    }

    return {
      id: randomUUID(),
      type: isImage ? 'image' : 'file',
      name: basename(filePath),
      path: filePath,
      mimeType,
      ...(contentHash ? { contentHash } : {}),
      dataUrl,
      size: stat.size,
    }
  } catch (err) {
    // A file that cannot be described is omitted from the attachment set,
    // which is user-visible data loss. Never let it happen silently.
    _warn(TAG, 'describeFile failed; attachment omitted', { path: filePath, error: String(err) })
    return null
  }
}
