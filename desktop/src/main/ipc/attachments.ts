import { dialog, ipcMain } from 'electron'
import { execSync } from 'child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, extname, join } from 'path'
import { IPC } from '../../shared/types'
import { state, SPACES_DEBUG } from '../state'
import { broadcast } from '../broadcast'
import { showWindow, snapshotWindowState } from '../window-manager'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('main', msg)
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
      const timestamp = Date.now()
      const screenshotPath = join(tmpdir(), `ion-screenshot-${timestamp}.png`)

      execSync(`/usr/sbin/screencapture -i "${screenshotPath}"`, {
        timeout: 30000,
        stdio: 'ignore',
      })

      if (!existsSync(screenshotPath)) {
        return null
      }

      const buf = readFileSync(screenshotPath)
      return {
        id: crypto.randomUUID(),
        type: 'image',
        name: `screenshot ${++state.screenshotCounter}.png`,
        path: screenshotPath,
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
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
      const timestamp = Date.now()
      const filePath = join(tmpdir(), `ion-paste-${timestamp}.${ext}`)
      writeFileSync(filePath, buf)

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
