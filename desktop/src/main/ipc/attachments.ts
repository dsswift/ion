import { dialog, ipcMain } from 'electron'
import { createHash } from 'crypto'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, extname, join } from 'path'
import { IPC } from '../../shared/types'
import { state, SPACES_DEBUG } from '../state'
import { broadcast } from '../broadcast'
import { showWindow, snapshotWindowState } from '../window-manager'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
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
 * Permanent, content-addressed store for user-supplied images (pastes and
 * screenshots). Mirrors the mechanic in `conversation-image-store.ts` (which
 * handles engine-generated tool-result images) but targets a separate
 * `~/.ion/user-images/` directory so user input images live alongside all
 * other Ion data and survive OS temp-directory purges across reboots.
 *
 * Content-addressing (filename = SHA-256 of raw bytes + extension) is
 * idempotent: pasting the same image twice produces exactly one file.
 *
 * Returns the absolute path of the saved file, or null on failure (the caller
 * falls through to returning null for the whole attachment, which is logged
 * at the call site).
 */
function saveUserImage(buf: Buffer, ext: string): string | null {
  try {
    const dir = join(homedir(), '.ion', 'user-images')
    mkdirSync(dir, { recursive: true })
    const hash = createHash('sha256').update(buf).digest('hex')
    const filePath = join(dir, `${hash}.${ext}`)
    // Content-addressed: same bytes → same name. Skip write when already present.
    if (!existsSync(filePath)) {
      writeFileSync(filePath, buf)
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

function describeFile(fp: string): { id: string; type: 'image' | 'file'; name: string; path: string; mimeType: string; dataUrl?: string; size: number } | null {
  try {
    const ext = extname(fp).toLowerCase()
    const mime = MIME_MAP[ext] || 'application/octet-stream'
    const stat = statSync(fp)
    let dataUrl: string | undefined

    if (IMAGE_EXTS.has(ext) && stat.size < 2 * 1024 * 1024) {
      try {
        const buf = readFileSync(fp)
        dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      } catch {}
    }

    return {
      id: crypto.randomUUID(),
      type: IMAGE_EXTS.has(ext) ? 'image' : 'file',
      name: basename(fp),
      path: fp,
      mimeType: mime,
      dataUrl,
      size: stat.size,
    }
  } catch {
    return null
  }
}

export function registerAttachmentsIpc(): void {
  ipcMain.handle(IPC.ATTACH_FILES, async () => {
    if (!state.mainWindow) return null
    state.mainWindow.hide()
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile' as const, 'multiSelections' as const],
      ...(process.platform !== 'darwin' && {
        filters: [
          { name: 'All Files', extensions: ['*'] },
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
          { name: 'Code', extensions: ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'md', 'json', 'yaml', 'toml'] },
        ],
      }),
    }
    const result = process.platform === 'darwin'
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(state.mainWindow, options)
    showWindow('dialog-return')
    if (result.canceled || result.filePaths.length === 0) return null

    return result.filePaths.map((fp: string) => describeFile(fp)).filter(Boolean)
  })

  ipcMain.handle(IPC.ATTACH_FILE_BY_PATH, async (_event, fp: string) => describeFile(fp))

  ipcMain.handle(IPC.TAKE_SCREENSHOT, async () => {
    if (!state.mainWindow) return null

    if (SPACES_DEBUG) snapshotWindowState('screenshot pre-hide')
    state.mainWindow.hide()
    await new Promise((r) => setTimeout(r, 300))

    try {
      // screencapture needs a tmp destination; we read the bytes and move to
      // permanent storage immediately so the file survives across reboots.
      const tmpPath = join(require('os').tmpdir(), `ion-screenshot-tmp-${Date.now()}.png`)

      execSync(`/usr/sbin/screencapture -i "${tmpPath}"`, {
        timeout: 30000,
        stdio: 'ignore',
      })

      if (!existsSync(tmpPath)) {
        // User cancelled the screencapture interactive selection.
        return null
      }

      const buf = readFileSync(tmpPath)
      // Move to permanent content-addressed storage so the path survives restart.
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
        dataUrl,
        size: buf.length,
      }
    } catch {
      return null
    } finally {
      if (state.mainWindow) {
        state.mainWindow.show()
        state.mainWindow.webContents.focus()
      }
      broadcast(IPC.WINDOW_SHOWN)
      if (SPACES_DEBUG) {
        log('[spaces] screenshot restore show+focus')
        snapshotWindowState('screenshot restore immediate')
        setTimeout(() => snapshotWindowState('screenshot restore +200ms'), 200)
      }
    }
  })

  ipcMain.handle(IPC.PASTE_IMAGE, async (_event, dataUrl: string) => {
    try {
      const match = dataUrl.match(/^data:(image\/(\w+));base64,(.+)$/)
      if (!match) return null

      const [, mimeType, ext, base64Data] = match
      const buf = Buffer.from(base64Data, 'base64')

      // Save to permanent content-addressed storage instead of tmpdir so the
      // file survives OS temp-purges across reboots.
      const filePath = saveUserImage(buf, ext)
      if (!filePath) return null

      log('attachments: paste image saved', { path: filePath, bytes: buf.length, mime: mimeType })
      return {
        id: crypto.randomUUID(),
        type: 'image',
        name: `pasted image ${++state.pasteCounter}.${ext}`,
        path: filePath,
        mimeType,
        dataUrl,
        size: buf.length,
      }
    } catch {
      return null
    }
  })
}
