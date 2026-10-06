import { ipcMain } from 'electron'
import { createHash } from 'crypto'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { basename, extname, join } from 'path'
import { atomicWriteFileSync } from '@ion/server/utils/atomicWrite'
import { dataDir } from '@ion/server/paths'
import { cleanupFile } from '@ion/server/utils/temp-dir'
import { IPC } from '@ion/shared/types'
import { state, SPACES_DEBUG } from '../state'
import { snapshotWindowState } from '../window-manager'
import { log as _log, warn as _warn, debug as _debug } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
}

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
/**
 * Permanent, content-addressed store for user-supplied images (screenshots). Mirrors the mechanic in `conversation-image-store.ts` (which
 * handles engine-generated tool-result images) but targets a separate
 * `<dataDir>/user-images/` directory (`userImagesDir`) so user input images
 * live alongside all other Ion data and survive OS temp-directory purges
 * across reboots.
 *
 * Content-addressing (filename = SHA-256 of raw bytes + extension) is
 * idempotent: the same bytes captured twice produce exactly one file.
 *
 * Returns the absolute path of the saved file, or null on failure (the caller
 * falls through to returning null for the whole attachment, which is logged
 * at the call site).
 */
/**
 * Where screenshots are stored: the data folder's `user-images/`, so a
 * machine that runs Ion under `ION_DATA_DIR` keeps them with the rest of its
 * data instead of in the home folder.
 */
export function userImagesDir(): string {
  return join(dataDir(), 'user-images')
}

function saveUserImage(buf: Buffer, ext: string): string | null {
  try {
    const dir = userImagesDir()
    mkdirSync(dir, { recursive: true })
    const hash = createHash('sha256').update(buf).digest('hex')
    const filePath = join(dir, `${hash}.${ext}`)
    // Content-addressed: same bytes → same name. Skip write when already present.
    if (!existsSync(filePath)) {
      atomicWriteFileSync(filePath, buf)
      log('attachments: user image saved', { path: filePath, bytes: buf.length })
    } else {
      log('attachments: user image already present (content-addressed); skipping write', { path: filePath })
    }
    return filePath
  } catch (err) {
    log('attachments: user image save failed', { error: (err as Error).message })
    return null
  }
}

function describeFile(fp: string): { id: string; type: 'image' | 'file'; name: string; path: string; mimeType: string; contentHash?: string; dataUrl?: string; size: number } | null {
  try {
    const ext = extname(fp).toLowerCase()
    const mime = MIME_MAP[ext] || 'application/octet-stream'
    const stat = statSync(fp)
    let dataUrl: string | undefined
    let contentHash: string | undefined

    if (IMAGE_EXTS.has(ext)) {
      try {
        const buf = readFileSync(fp)
        contentHash = createHash('sha256').update(buf).digest('hex')
        if (stat.size < 2 * 1024 * 1024) dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      } catch (err) {
        // Read failure drops the image preview and its identity; renderers keep
        // the attachment visible rather than guessing an identity from its path.
        debug('attachments: dataUrl/hash read failed', { path: fp, error: String(err) })
      }
    }

    return {
      id: crypto.randomUUID(),
      type: IMAGE_EXTS.has(ext) ? 'image' : 'file',
      name: basename(fp),
      path: fp,
      mimeType: mime,
      ...(contentHash ? { contentHash } : {}),
      dataUrl,
      size: stat.size,
    }
  } catch (err) {
    // A file that can't be described is silently omitted from the attachment
    // set — user-visible data loss. Log before returning null.
    warn('attachments: describeFile failed', { path: fp, error: String(err) })
    return null
  }
}

export function registerAttachmentsIpc(): void {
  ipcMain.handle(IPC.ATTACH_FILE_BY_PATH, async (_event, fp: string) => describeFile(fp))

  ipcMain.handle(IPC.TAKE_SCREENSHOT, async () => {
    if (!state.studioWindow) return null

    if (SPACES_DEBUG) snapshotWindowState('screenshot pre-hide')
    state.studioWindow.hide()
    await new Promise((r) => setTimeout(r, 300))

    const tmpPath = join(tmpdir(), `ion-screenshot-${crypto.randomUUID()}.png`)
    try {
      execSync(`/usr/sbin/screencapture -i "${tmpPath}"`, {
        timeout: 30000,
        stdio: 'ignore',
      })

      if (!existsSync(tmpPath)) {
        return null
      }

      const buf = readFileSync(tmpPath)
      const permanentPath = saveUserImage(buf, 'png')
      if (!permanentPath) return null

      const dataUrl = `data:image/png;base64,${buf.toString('base64')}`
      log('attachments: screenshot captured', { path: permanentPath, bytes: buf.length })
      return {
        id: crypto.randomUUID(),
        type: 'image',
        name: `screenshot ${++state.screenshotCounter}.png`,
        path: permanentPath,
        mimeType: 'image/png',
        contentHash: createHash('sha256').update(buf).digest('hex'),
        dataUrl,
        size: buf.length,
      }
    } catch (err) {
      warn('attachments: screenshot capture failed', { error: String(err) })
      return null
    } finally {
      cleanupFile(tmpPath)
      if (state.studioWindow) {
        state.studioWindow.show()
        state.studioWindow.webContents.focus()
      }
      if (SPACES_DEBUG) {
        log('[spaces] screenshot restore show+focus')
        snapshotWindowState('screenshot restore immediate')
        setTimeout(() => snapshotWindowState('screenshot restore +200ms'), 200)
      }
    }
  })
}
