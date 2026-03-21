import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, Tray, Menu, nativeImage, nativeTheme, shell, systemPreferences } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, statSync, createReadStream, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { unlink } from 'fs/promises'
import { createInterface } from 'readline'
import { homedir } from 'os'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { ControlPlane } from './claude/control-plane'
import { ensureSkills, type SkillStatus } from './skills/installer'
import { fetchCatalog, listInstalled, installPlugin, uninstallPlugin } from './marketplace/catalog'
import { log as _log, LOG_FILE, flushLogs } from './logger'
import { getCliEnv } from './cli-env'
import { IPC } from '../shared/types'
import type { RunOptions, NormalizedEvent, EnrichedError } from '../shared/types'

const gitExec = promisify(execFileCb)

const DEBUG_MODE = process.env.CLUI_DEBUG === '1'
const SPACES_DEBUG = DEBUG_MODE || process.env.CLUI_SPACES_DEBUG === '1'

function log(msg: string): void {
  _log('main', msg)
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let screenshotCounter = 0
let toggleSequence = 0

// Feature flag: enable PTY interactive permissions transport
const INTERACTIVE_PTY = process.env.CLUI_INTERACTIVE_PERMISSIONS_PTY === '1'

const controlPlane = new ControlPlane(INTERACTIVE_PTY)

// The native window covers the full screen work area so that floating panels
// (plan viewer, diff viewer, git panel) can be positioned anywhere without clipping.
// The UI itself renders at the bottom center; all other regions are transparent/click-through.

// ─── Broadcast to renderer ───

function broadcast(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function snapshotWindowState(reason: string): void {
  if (!SPACES_DEBUG) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    log(`[spaces] ${reason} window=none`)
    return
  }

  const b = mainWindow.getBounds()
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const visibleOnAll = mainWindow.isVisibleOnAllWorkspaces()
  const wcFocused = mainWindow.webContents.isFocused()

  log(
    `[spaces] ${reason} ` +
    `vis=${mainWindow.isVisible()} focused=${mainWindow.isFocused()} wcFocused=${wcFocused} ` +
    `alwaysOnTop=${mainWindow.isAlwaysOnTop()} allWs=${visibleOnAll} ` +
    `bounds=(${b.x},${b.y},${b.width}x${b.height}) ` +
    `cursor=(${cursor.x},${cursor.y}) display=${display.id} ` +
    `workArea=(${display.workArea.x},${display.workArea.y},${display.workArea.width}x${display.workArea.height})`
  )
}

function scheduleToggleSnapshots(toggleId: number, phase: 'show' | 'hide'): void {
  if (!SPACES_DEBUG) return
  const probes = [0, 100, 400, 1200]
  for (const delay of probes) {
    setTimeout(() => {
      snapshotWindowState(`toggle#${toggleId} ${phase} +${delay}ms`)
    }, delay)
  }
}


// ─── Wire ControlPlane events → renderer ───

controlPlane.on('event', (tabId: string, event: NormalizedEvent) => {
  broadcast('clui:normalized-event', tabId, event)
})

controlPlane.on('tab-status-change', (tabId: string, newStatus: string, oldStatus: string) => {
  broadcast('clui:tab-status-change', tabId, newStatus, oldStatus)
})

controlPlane.on('error', (tabId: string, error: EnrichedError) => {
  broadcast('clui:enriched-error', tabId, error)
})

// ─── Window Creation ───

function createWindow(): void {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { x: dx, y: dy, width: sw, height: sh } = display.workArea

  mainWindow = new BrowserWindow({
    width: sw,
    height: sh,
    x: dx,
    y: dy,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),  // NSPanel — non-activating, joins all spaces
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: true,
    backgroundColor: '#00000000',
    show: false,
    icon: join(__dirname, '../../resources/icon.icns'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Belt-and-suspenders: panel already joins all spaces and floats,
  // but explicit flags ensure correct behavior on older Electron builds.
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  mainWindow.setAlwaysOnTop(true, 'screen-saver')

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    // Enable OS-level click-through for transparent regions.
    // { forward: true } ensures mousemove events still reach the renderer
    // so it can toggle click-through off when cursor enters interactive UI.
    mainWindow?.setIgnoreMouseEvents(true, { forward: true })
    if (process.env.ELECTRON_RENDERER_URL) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  let forceQuit = false
  app.on('before-quit', (e) => {
    if (forceQuit) return
    e.preventDefault()
    const hasRunning = controlPlane.hasRunningTabs()
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Quit Clui CC?',
      message: hasRunning
        ? 'Sessions are still running. Quitting will stop them.'
        : 'Are you sure you want to quit?',
    })
    if (choice === 0) {
      forceQuit = true
      app.quit()
    }
  })
  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow(source = 'unknown'): void {
  if (!mainWindow) return
  const toggleId = ++toggleSequence

  // Position on the display where the cursor currently is (not always primary)
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { x: dx, y: dy, width: sw, height: sh } = display.workArea
  mainWindow.setBounds({
    x: dx,
    y: dy,
    width: sw,
    height: sh,
  })

  // Always re-assert space membership — the flag can be lost after hide/show cycles
  // and must be set before show() so the window joins the active Space, not its
  // last-known Space.
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (SPACES_DEBUG) {
    log(`[spaces] showWindow#${toggleId} source=${source} move-to-display id=${display.id}`)
    snapshotWindowState(`showWindow#${toggleId} pre-show`)
  }
  // As an accessory app (app.dock.hide), show() + focus gives keyboard
  // without deactivating the active app — hover preserved everywhere.
  mainWindow.show()
  mainWindow.webContents.focus()
  broadcast(IPC.WINDOW_SHOWN)
  if (SPACES_DEBUG) scheduleToggleSnapshots(toggleId, 'show')
}

function toggleWindow(source = 'unknown'): void {
  if (!mainWindow) return
  const toggleId = ++toggleSequence
  if (SPACES_DEBUG) {
    log(`[spaces] toggle#${toggleId} source=${source} start`)
    snapshotWindowState(`toggle#${toggleId} pre`)
  }

  if (mainWindow.isVisible()) {
    mainWindow.hide()
    if (SPACES_DEBUG) scheduleToggleSnapshots(toggleId, 'hide')
  } else {
    showWindow(source)
  }
}

// ─── Resize ───
// The native window covers the full work area; all expand/collapse happens inside the renderer.

ipcMain.on(IPC.RESIZE_HEIGHT, () => {
  // No-op — fixed height window, no dynamic resize
})

ipcMain.on(IPC.SET_WINDOW_WIDTH, () => {
  // No-op — native width is fixed to keep expand/collapse animation smooth.
})

ipcMain.handle(IPC.ANIMATE_HEIGHT, () => {
  // No-op — kept for API compat, animation handled purely in renderer
})

ipcMain.on(IPC.HIDE_WINDOW, () => {
  mainWindow?.hide()
})

ipcMain.handle(IPC.IS_VISIBLE, () => {
  return mainWindow?.isVisible() ?? false
})

// OS-level click-through toggle — renderer calls this on mousemove
// to enable clicks on interactive UI while passing through transparent areas
ipcMain.on(IPC.SET_IGNORE_MOUSE_EVENTS, (event, ignore: boolean, options?: { forward?: boolean }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(ignore, options || {})
  }
})

// ─── IPC Handlers (typed, strict) ───

ipcMain.handle(IPC.START, async () => {
  log('IPC START — fetching static CLI info')
  const { execSync } = require('child_process')

  let version = 'unknown'
  try {
    version = execSync('claude -v', { encoding: 'utf-8', timeout: 5000, env: getCliEnv() }).trim()
  } catch {}

  let auth: { email?: string; subscriptionType?: string; authMethod?: string } = {}
  try {
    const raw = execSync('claude auth status', { encoding: 'utf-8', timeout: 5000, env: getCliEnv() }).trim()
    auth = JSON.parse(raw)
  } catch {}

  let mcpServers: string[] = []
  try {
    const raw = execSync('claude mcp list', { encoding: 'utf-8', timeout: 5000, env: getCliEnv() }).trim()
    if (raw) mcpServers = raw.split('\n').filter(Boolean)
  } catch {}

  return { version, auth, mcpServers, projectPath: process.cwd(), homePath: require('os').homedir() }
})

ipcMain.handle(IPC.CREATE_TAB, () => {
  const tabId = controlPlane.createTab()
  log(`IPC CREATE_TAB → ${tabId}`)
  return { tabId }
})

ipcMain.on(IPC.INIT_SESSION, (_event, tabId: string) => {
  log(`IPC INIT_SESSION: ${tabId}`)
  controlPlane.initSession(tabId)
})

ipcMain.on(IPC.RESET_TAB_SESSION, (_event, tabId: string) => {
  log(`IPC RESET_TAB_SESSION: ${tabId}`)
  controlPlane.resetTabSession(tabId)
})

ipcMain.handle(IPC.PROMPT, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
  if (DEBUG_MODE) {
    log(`IPC PROMPT: tab=${tabId} req=${requestId} prompt="${options.prompt.substring(0, 100)}"`)
  } else {
    log(`IPC PROMPT: tab=${tabId} req=${requestId}`)
  }

  if (!tabId) {
    throw new Error('No tabId provided — prompt rejected')
  }
  if (!requestId) {
    throw new Error('No requestId provided — prompt rejected')
  }

  try {
    await controlPlane.submitPrompt(tabId, requestId, options)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`PROMPT error: ${msg}`)
    throw err
  }
})

ipcMain.handle(IPC.CANCEL, (_event, requestId: string) => {
  log(`IPC CANCEL: ${requestId}`)
  return controlPlane.cancel(requestId)
})

ipcMain.handle(IPC.STOP_TAB, (_event, tabId: string) => {
  log(`IPC STOP_TAB: ${tabId}`)
  return controlPlane.cancelTab(tabId)
})

ipcMain.handle(IPC.RETRY, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
  log(`IPC RETRY: tab=${tabId} req=${requestId}`)
  return controlPlane.retry(tabId, requestId, options)
})

ipcMain.handle(IPC.STATUS, () => {
  return controlPlane.getHealth()
})

ipcMain.handle(IPC.TAB_HEALTH, () => {
  return controlPlane.getHealth()
})

ipcMain.handle(IPC.CLOSE_TAB, (_event, tabId: string) => {
  log(`IPC CLOSE_TAB: ${tabId}`)
  controlPlane.closeTab(tabId)
})

ipcMain.on(IPC.SET_PERMISSION_MODE, (_event, payload: { tabId: string; mode: string }) => {
  const { tabId, mode } = payload
  if (mode !== 'ask' && mode !== 'auto' && mode !== 'plan') {
    log(`IPC SET_PERMISSION_MODE: invalid mode "${mode}" — ignoring`)
    return
  }
  log(`IPC SET_PERMISSION_MODE: tab=${tabId} mode=${mode}`)
  controlPlane.setPermissionMode(tabId, mode)
})

ipcMain.handle(IPC.RESPOND_PERMISSION, (_event, { tabId, questionId, optionId }: { tabId: string; questionId: string; optionId: string }) => {
  log(`IPC RESPOND_PERMISSION: tab=${tabId} question=${questionId} option=${optionId}`)
  return controlPlane.respondToPermission(tabId, questionId, optionId)
})

ipcMain.handle(IPC.LIST_SESSIONS, async (_e, projectPath?: string) => {
  log(`IPC LIST_SESSIONS ${projectPath ? `(path=${projectPath})` : ''}`)
  try {
    const cwd = projectPath || process.cwd()
    // Claude stores project sessions at ~/.claude/projects/<encoded-path>/
    // Path encoding: replace all '/' with '-' (leading '/' becomes leading '-')
    const encodedPath = cwd.replace(/\//g, '-')
    const sessionsDir = join(homedir(), '.claude', 'projects', encodedPath)
    if (!existsSync(sessionsDir)) {
      log(`LIST_SESSIONS: directory not found: ${sessionsDir}`)
      return []
    }
    const files = readdirSync(sessionsDir).filter((f: string) => f.endsWith('.jsonl'))

    const sessions: Array<{ sessionId: string; slug: string | null; firstMessage: string | null; lastTimestamp: string; size: number }> = []

    // UUID v4 regex — only consider files named as valid UUIDs
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    for (const file of files) {
      // The filename (without .jsonl) IS the canonical resume ID for `claude --resume`
      const fileSessionId = file.replace(/\.jsonl$/, '')
      if (!UUID_RE.test(fileSessionId)) continue // skip non-UUID files

      const filePath = join(sessionsDir, file)
      const stat = statSync(filePath)
      if (stat.size < 100) continue // skip trivially small files

      // Read lines to extract metadata and validate transcript schema
      const meta: { validated: boolean; slug: string | null; firstMessage: string | null; lastTimestamp: string | null } = {
        validated: false, slug: null, firstMessage: null, lastTimestamp: null,
      }

      await new Promise<void>((resolve) => {
        const rl = createInterface({ input: createReadStream(filePath) })
        rl.on('line', (line: string) => {
          try {
            const obj = JSON.parse(line)
            // Validate: must have expected Claude transcript fields
            if (!meta.validated && obj.type && obj.uuid && obj.timestamp) {
              meta.validated = true
            }
            if (obj.slug && !meta.slug) meta.slug = obj.slug
            if (obj.timestamp) meta.lastTimestamp = obj.timestamp
            if (obj.type === 'user' && !meta.firstMessage) {
              const content = obj.message?.content
              if (typeof content === 'string') {
                meta.firstMessage = content.substring(0, 100)
              } else if (Array.isArray(content)) {
                const textPart = content.find((p: any) => p.type === 'text')
                meta.firstMessage = textPart?.text?.substring(0, 100) || null
              }
            }
          } catch {}
          // Read all lines to get the last timestamp
        })
        rl.on('close', () => resolve())
      })

      if (meta.validated) {
        sessions.push({
          sessionId: fileSessionId,
          slug: meta.slug,
          firstMessage: meta.firstMessage,
          lastTimestamp: meta.lastTimestamp || stat.mtime.toISOString(),
          size: stat.size,
        })
      }
    }

    // Sort by last timestamp, most recent first
    sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
    return sessions.slice(0, 20) // Return top 20
  } catch (err) {
    log(`LIST_SESSIONS error: ${err}`)
    return []
  }
})

// Load conversation history from a session's JSONL file
ipcMain.handle(IPC.LOAD_SESSION, async (_e, arg: { sessionId: string; projectPath?: string } | string) => {
  const sessionId = typeof arg === 'string' ? arg : arg.sessionId
  const projectPath = typeof arg === 'string' ? undefined : arg.projectPath
  log(`IPC LOAD_SESSION ${sessionId}${projectPath ? ` (path=${projectPath})` : ''}`)
  try {
    const cwd = projectPath || process.cwd()
    const encodedPath = cwd.replace(/\//g, '-')
    const filePath = join(homedir(), '.claude', 'projects', encodedPath, `${sessionId}.jsonl`)
    if (!existsSync(filePath)) return []

    const messages: Array<{ role: string; content: string; toolName?: string; timestamp: number }> = []
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: createReadStream(filePath) })
      rl.on('line', (line: string) => {
        try {
          const obj = JSON.parse(line)
          if (obj.type === 'user') {
            const content = obj.message?.content
            let text = ''
            if (typeof content === 'string') {
              text = content
            } else if (Array.isArray(content)) {
              text = content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('\n')
            }
            if (text) {
              messages.push({ role: 'user', content: text, timestamp: new Date(obj.timestamp).getTime() })
            }
          } else if (obj.type === 'assistant') {
            const content = obj.message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  messages.push({ role: 'assistant', content: block.text, timestamp: new Date(obj.timestamp).getTime() })
                } else if (block.type === 'tool_use' && block.name) {
                  messages.push({
                    role: 'tool',
                    content: '',
                    toolName: block.name,
                    toolInput: block.input ? JSON.stringify(block.input) : undefined,
                    timestamp: new Date(obj.timestamp).getTime(),
                  })
                }
              }
            }
          }
        } catch {}
      })
      rl.on('close', () => resolve())
    })
    return messages
  } catch (err) {
    log(`LOAD_SESSION error: ${err}`)
    return []
  }
})

ipcMain.handle(IPC.READ_PLAN, async (_e, filePath: string) => {
  try {
    if (!filePath || !existsSync(filePath)) return { content: null, fileName: null }
    const content = readFileSync(filePath, 'utf-8')
    const fileName = filePath.split('/').pop() || filePath
    return { content, fileName }
  } catch (err) {
    log(`READ_PLAN error: ${err}`)
    return { content: null, fileName: null }
  }
})

ipcMain.handle(IPC.SELECT_DIRECTORY, async () => {
  if (!mainWindow) return null
  // macOS: activate app so unparented dialog appears on top (not behind other apps).
  // Unparented avoids modal dimming on the transparent overlay.
  // Activation is fine here — user is actively interacting with CLUI.
  if (process.platform === 'darwin') app.focus()
  const options = { properties: ['openDirectory'] as const }
  const result = process.platform === 'darwin'
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options)
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
  try {
    // Only allow http(s) links from markdown content.
    if (!/^https?:\/\//i.test(url)) return false
    await shell.openExternal(url)
    return true
  } catch {
    return false
  }
})

ipcMain.handle(IPC.ATTACH_FILES, async () => {
  if (!mainWindow) return null
  // macOS: activate app so unparented dialog appears on top
  if (process.platform === 'darwin') app.focus()
  const options = {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
      { name: 'Code', extensions: ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'md', 'json', 'yaml', 'toml'] },
    ],
  }
  const result = process.platform === 'darwin'
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options)
  if (result.canceled || result.filePaths.length === 0) return null

  const { basename, extname } = require('path')
  const { readFileSync, statSync } = require('fs')

  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
  const mimeMap: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
    '.json': 'application/json', '.yaml': 'text/yaml', '.toml': 'text/toml',
  }

  return result.filePaths.map((fp: string) => {
    const ext = extname(fp).toLowerCase()
    const mime = mimeMap[ext] || 'application/octet-stream'
    const stat = statSync(fp)
    let dataUrl: string | undefined

    // Generate preview data URL for images (max 2MB to keep IPC fast)
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
  })
})

ipcMain.handle(IPC.TAKE_SCREENSHOT, async () => {
  if (!mainWindow) return null

  if (SPACES_DEBUG) snapshotWindowState('screenshot pre-hide')
  mainWindow.hide()
  await new Promise((r) => setTimeout(r, 300))

  try {
    const { execSync } = require('child_process')
    const { join } = require('path')
    const { tmpdir } = require('os')
    const { readFileSync, existsSync } = require('fs')

    const timestamp = Date.now()
    const screenshotPath = join(tmpdir(), `clui-screenshot-${timestamp}.png`)

    execSync(`/usr/sbin/screencapture -i "${screenshotPath}"`, {
      timeout: 30000,
      stdio: 'ignore',
    })

    if (!existsSync(screenshotPath)) {
      return null
    }

    // Return structured attachment with data URL preview
    const buf = readFileSync(screenshotPath)
    return {
      id: crypto.randomUUID(),
      type: 'image',
      name: `screenshot ${++screenshotCounter}.png`,
      path: screenshotPath,
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
      size: buf.length,
    }
  } catch {
    return null
  } finally {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.webContents.focus()
    }
    broadcast(IPC.WINDOW_SHOWN)
    if (SPACES_DEBUG) {
      log('[spaces] screenshot restore show+focus')
      snapshotWindowState('screenshot restore immediate')
      setTimeout(() => snapshotWindowState('screenshot restore +200ms'), 200)
    }
  }
})

let pasteCounter = 0
ipcMain.handle(IPC.PASTE_IMAGE, async (_event, dataUrl: string) => {
  try {
    const { writeFileSync } = require('fs')
    const { join } = require('path')
    const { tmpdir } = require('os')

    // Parse data URL: "data:image/png;base64,..."
    const match = dataUrl.match(/^data:(image\/(\w+));base64,(.+)$/)
    if (!match) return null

    const [, mimeType, ext, base64Data] = match
    const buf = Buffer.from(base64Data, 'base64')
    const timestamp = Date.now()
    const filePath = join(tmpdir(), `clui-paste-${timestamp}.${ext}`)
    writeFileSync(filePath, buf)

    return {
      id: crypto.randomUUID(),
      type: 'image',
      name: `pasted image ${++pasteCounter}.${ext}`,
      path: filePath,
      mimeType,
      dataUrl,
      size: buf.length,
    }
  } catch {
    return null
  }
})

ipcMain.handle(IPC.TRANSCRIBE_AUDIO, async (_event, audioBase64: string) => {
  const { writeFileSync, existsSync, unlinkSync, readFileSync } = require('fs')
  const { execSync } = require('child_process')
  const { join } = require('path')
  const { tmpdir } = require('os')

  const tmpWav = join(tmpdir(), `clui-voice-${Date.now()}.wav`)
  try {
    const buf = Buffer.from(audioBase64, 'base64')
    writeFileSync(tmpWav, buf)

    // Find whisper backend in priority order: whisperkit-cli (Apple Silicon CoreML) → whisper-cli (whisper-cpp) → whisper (python)
    const candidates = [
      '/opt/homebrew/bin/whisperkit-cli',
      '/usr/local/bin/whisperkit-cli',
      '/opt/homebrew/bin/whisper-cli',
      '/usr/local/bin/whisper-cli',
      '/opt/homebrew/bin/whisper',
      '/usr/local/bin/whisper',
      join(homedir(), '.local/bin/whisper'),
    ]

    let whisperBin = ''
    for (const c of candidates) {
      if (existsSync(c)) { whisperBin = c; break }
    }

    if (!whisperBin) {
      for (const name of ['whisperkit-cli', 'whisper-cli', 'whisper']) {
        try {
          whisperBin = execSync(`/bin/zsh -lc "whence -p ${name}"`, { encoding: 'utf-8' }).trim()
          if (whisperBin) break
        } catch {}
      }
    }

    if (!whisperBin) {
      const hint = process.arch === 'arm64'
        ? 'brew install whisperkit-cli   (or: brew install whisper-cpp)'
        : 'brew install whisper-cpp'
      return {
        error: `Whisper not found. Install with:\n  ${hint}`,
        transcript: null,
      }
    }

    const isWhisperKit = whisperBin.includes('whisperkit-cli')
    const isWhisperCpp = !isWhisperKit && whisperBin.includes('whisper-cli')

    log(`Transcribing with: ${whisperBin} (backend: ${isWhisperKit ? 'WhisperKit' : isWhisperCpp ? 'whisper-cpp' : 'Python whisper'})`)

    let output: string
    if (isWhisperKit) {
      // WhisperKit (Apple Silicon CoreML) — auto-downloads models on first run
      // Use --report to produce a JSON file with a top-level "text" field for deterministic parsing
      const reportDir = tmpdir()
      execSync(
        `"${whisperBin}" transcribe --audio-path "${tmpWav}" --model tiny --without-timestamps --skip-special-tokens --report --report-path "${reportDir}"`,
        { encoding: 'utf-8', timeout: 60000 }
      )
      // WhisperKit writes <audioFileName>.json (filename without extension)
      const wavBasename = require('path').basename(tmpWav, '.wav')
      const reportPath = join(reportDir, `${wavBasename}.json`)
      if (existsSync(reportPath)) {
        try {
          const report = JSON.parse(readFileSync(reportPath, 'utf-8'))
          const transcript = (report.text || '').trim()
          try { unlinkSync(reportPath) } catch {}
          // Also clean up .srt that --report creates
          const srtPath = join(reportDir, `${wavBasename}.srt`)
          try { unlinkSync(srtPath) } catch {}
          return { error: null, transcript }
        } catch (parseErr: any) {
          log(`WhisperKit JSON parse failed: ${parseErr.message}, falling back to stdout`)
          try { unlinkSync(reportPath) } catch {}
        }
      }
      // Fallback: re-run without --report, stdout is plain text when --verbose is not set
      output = execSync(
        `"${whisperBin}" transcribe --audio-path "${tmpWav}" --model tiny --without-timestamps --skip-special-tokens`,
        { encoding: 'utf-8', timeout: 60000 }
      )
    } else if (isWhisperCpp) {
      // whisper-cpp: whisper-cli -m model -f file --no-timestamps
      // Find model file — prefer multilingual (auto-detect language) over .en (English-only)
      const modelCandidates = [
        join(homedir(), '.local/share/whisper/ggml-base.bin'),
        join(homedir(), '.local/share/whisper/ggml-tiny.bin'),
        '/opt/homebrew/share/whisper-cpp/models/ggml-base.bin',
        '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.bin',
        join(homedir(), '.local/share/whisper/ggml-base.en.bin'),
        join(homedir(), '.local/share/whisper/ggml-tiny.en.bin'),
        '/opt/homebrew/share/whisper-cpp/models/ggml-base.en.bin',
        '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.en.bin',
      ]

      let modelPath = ''
      for (const m of modelCandidates) {
        if (existsSync(m)) { modelPath = m; break }
      }

      if (!modelPath) {
        return {
          error: 'Whisper model not found. Download with:\n  mkdir -p ~/.local/share/whisper && curl -L -o ~/.local/share/whisper/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
          transcript: null,
        }
      }

      const isEnglishOnly = modelPath.includes('.en.')
      const langFlag = isEnglishOnly ? '-l en' : '-l auto'
      output = execSync(
        `"${whisperBin}" -m "${modelPath}" -f "${tmpWav}" --no-timestamps ${langFlag}`,
        { encoding: 'utf-8', timeout: 30000 }
      )
    } else {
      // Python whisper
      output = execSync(
        `"${whisperBin}" "${tmpWav}" --model tiny --output_format txt --output_dir "${tmpdir()}"`,
        { encoding: 'utf-8', timeout: 30000 }
      )
      // Python whisper writes .txt file
      const txtPath = tmpWav.replace('.wav', '.txt')
      if (existsSync(txtPath)) {
        const transcript = readFileSync(txtPath, 'utf-8').trim()
        try { unlinkSync(txtPath) } catch {}
        return { error: null, transcript }
      }
      // File not created — Python whisper failed silently
      return {
        error: `Whisper output file not found at ${txtPath}. Check disk space and permissions.`,
        transcript: null,
      }
    }

    // WhisperKit (stdout fallback) and whisper-cpp print to stdout directly
    // Strip timestamp patterns and known hallucination outputs
    const HALLUCINATIONS = /^\s*(\[BLANK_AUDIO\]|you\.?|thank you\.?|thanks\.?)\s*$/i
    const transcript = output
      .replace(/\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/g, '')
      .trim()

    if (HALLUCINATIONS.test(transcript)) {
      return { error: null, transcript: '' }
    }

    return { error: null, transcript: transcript || '' }
  } catch (err: any) {
    log(`Transcription error: ${err.message}`)
    return {
      error: `Transcription failed: ${err.message}`,
      transcript: null,
    }
  } finally {
    try { unlinkSync(tmpWav) } catch {}
  }
})

ipcMain.handle(IPC.GET_DIAGNOSTICS, () => {
  const { readFileSync, existsSync } = require('fs')
  const health = controlPlane.getHealth()

  let recentLogs = ''
  if (existsSync(LOG_FILE)) {
    try {
      const content = readFileSync(LOG_FILE, 'utf-8')
      const lines = content.split('\n')
      recentLogs = lines.slice(-100).join('\n')
    } catch {}
  }

  return {
    health,
    logPath: LOG_FILE,
    recentLogs,
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    appVersion: app.getVersion(),
    transport: INTERACTIVE_PTY ? 'pty' : 'stream-json',
  }
})

ipcMain.handle(IPC.OPEN_IN_TERMINAL, (_event, arg: string | null | { sessionId?: string | null; projectPath?: string }) => {
  const { execFile } = require('child_process')
  const claudeBin = 'claude'

  // Support both old (string) and new ({ sessionId, projectPath }) calling convention
  let sessionId: string | null = null
  let projectPath: string = process.cwd()
  if (typeof arg === 'string') {
    sessionId = arg
  } else if (arg && typeof arg === 'object') {
    sessionId = arg.sessionId ?? null
    projectPath = arg.projectPath && arg.projectPath !== '~' ? arg.projectPath : process.cwd()
  }

  // Escape for AppleScript: double quotes → backslash-escaped, backslashes doubled
  const projectDir = projectPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  let cmd: string
  if (sessionId) {
    cmd = `cd \\"${projectDir}\\" && ${claudeBin} --resume ${sessionId}`
  } else {
    cmd = `cd \\"${projectDir}\\" && ${claudeBin}`
  }

  const script = `tell application "Terminal"
  activate
  do script "${cmd}"
end tell`

  try {
    execFile('/usr/bin/osascript', ['-e', script], (err: Error | null) => {
      if (err) log(`Failed to open terminal: ${err.message}`)
      else log(`Opened terminal with: ${cmd}`)
    })
    return true
  } catch (err: unknown) {
    log(`Failed to open terminal: ${err}`)
    return false
  }
})

ipcMain.handle(IPC.OPEN_IN_VSCODE, (_event, projectPath: string) => {
  const { execFile } = require('child_process')
  const dir = projectPath || process.cwd()

  try {
    execFile('code', ['--reuse-window', dir], (err: Error | null) => {
      if (err) {
        log(`'code' CLI failed, falling back to open -a: ${err.message}`)
        execFile('/usr/bin/open', ['-a', 'Visual Studio Code', dir], (err2: Error | null) => {
          if (err2) log(`Failed to open VS Code: ${err2.message}`)
          else log(`Opened VS Code (via open -a) at: ${dir}`)
        })
      } else {
        log(`Opened VS Code at: ${dir}`)
      }
    })
    return true
  } catch (err: unknown) {
    log(`Failed to open VS Code: ${err}`)
    return false
  }
})

// ─── Marketplace IPC ───

ipcMain.handle(IPC.MARKETPLACE_FETCH, async (_event, { forceRefresh } = {}) => {
  log('IPC MARKETPLACE_FETCH')
  return fetchCatalog(forceRefresh)
})

ipcMain.handle(IPC.MARKETPLACE_INSTALLED, async () => {
  log('IPC MARKETPLACE_INSTALLED')
  return listInstalled()
})

ipcMain.handle(IPC.MARKETPLACE_INSTALL, async (_event, { repo, pluginName, marketplace, sourcePath, isSkillMd }: { repo: string; pluginName: string; marketplace: string; sourcePath?: string; isSkillMd?: boolean }) => {
  log(`IPC MARKETPLACE_INSTALL: ${pluginName} from ${repo} (isSkillMd=${isSkillMd})`)
  return installPlugin(repo, pluginName, marketplace, sourcePath, isSkillMd)
})

ipcMain.handle(IPC.MARKETPLACE_UNINSTALL, async (_event, { pluginName }: { pluginName: string }) => {
  log(`IPC MARKETPLACE_UNINSTALL: ${pluginName}`)
  return uninstallPlugin(pluginName)
})

// ─── Settings Persistence ───

const SETTINGS_DIR = join(homedir(), '.clui')
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json')
const SETTINGS_DEFAULTS = { themeMode: 'dark', soundEnabled: true, expandedUI: false, defaultBaseDirectory: '', showDirLabel: false, preferredOpenWith: 'cli' }

ipcMain.handle(IPC.LOAD_SETTINGS, () => {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return { ...SETTINGS_DEFAULTS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) }
    }
  } catch (err) {
    log(`Failed to load settings: ${err}`)
  }
  return SETTINGS_DEFAULTS
})

ipcMain.handle(IPC.SAVE_SETTINGS, (_event, data: Record<string, unknown>) => {
  try {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true })
    writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2))
  } catch (err) {
    log(`Failed to save settings: ${err}`)
  }
})

// ─── Tab Persistence ───

const TABS_FILE = join(SETTINGS_DIR, 'tabs.json')

ipcMain.handle(IPC.LOAD_TABS, () => {
  try {
    if (existsSync(TABS_FILE)) {
      return JSON.parse(readFileSync(TABS_FILE, 'utf-8'))
    }
  } catch (err) {
    log(`Failed to load tabs: ${err}`)
  }
  return null
})

ipcMain.handle(IPC.SAVE_TABS, (_event, data: Record<string, unknown>) => {
  try {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true })
    writeFileSync(TABS_FILE, JSON.stringify(data, null, 2))
  } catch (err) {
    log(`Failed to save tabs: ${err}`)
  }
})

// ─── Git IPC Handlers ───

async function runGit(directory: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await gitExec('git', args, { cwd: directory, maxBuffer: 10 * 1024 * 1024 })
    return stdout
  } catch (err: any) {
    throw new Error(err.stderr?.trim() || err.message)
  }
}

ipcMain.handle(IPC.GIT_IS_REPO, async (_event, directory: string) => {
  try {
    await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
    return { isRepo: true }
  } catch {
    return { isRepo: false }
  }
})

ipcMain.handle(IPC.GIT_GRAPH, async (_event, { directory, skip = 0, limit = 100 }: { directory: string; skip?: number; limit?: number }) => {
  try {
    await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return { commits: [], isGitRepo: false, totalCount: 0 }
  }

  try {
    const format = '%h%x00%H%x00%P%x00%an%x00%aI%x00%s%x00%D'
    const logOutput = await runGit(directory, [
      'log', '--all', `--format=${format}`, '--topo-order',
      `--skip=${skip}`, `-n`, `${limit}`,
    ])

    let totalCount = 0
    try {
      const countOutput = await runGit(directory, ['rev-list', '--all', '--count'])
      totalCount = parseInt(countOutput.trim(), 10) || 0
    } catch {}

    const commits = logOutput.trim().split('\n').filter(Boolean).map((line) => {
      const [hash, fullHash, parents, authorName, authorDate, subject, decorations] = line.split('\x00')
      const refs: Array<{ name: string; type: 'head' | 'remote' | 'tag'; isCurrent: boolean }> = []
      if (decorations && decorations.trim()) {
        for (const dec of decorations.split(',')) {
          const d = dec.trim()
          if (!d) continue
          if (d.startsWith('HEAD -> ')) {
            refs.push({ name: d.replace('HEAD -> ', ''), type: 'head', isCurrent: true })
          } else if (d.startsWith('tag: ')) {
            refs.push({ name: d.replace('tag: ', ''), type: 'tag', isCurrent: false })
          } else if (d.includes('/')) {
            refs.push({ name: d, type: 'remote', isCurrent: false })
          } else if (d !== 'HEAD') {
            refs.push({ name: d, type: 'head', isCurrent: false })
          }
        }
      }
      return {
        hash,
        fullHash,
        parents: parents ? parents.split(' ') : [],
        authorName,
        authorDate,
        subject,
        refs,
      }
    })

    return { commits, isGitRepo: true, totalCount }
  } catch {
    return { commits: [], isGitRepo: true, totalCount: 0 }
  }
})

ipcMain.handle(IPC.GIT_CHANGES, async (_event, { directory }: { directory: string }) => {
  try {
    await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return { files: [], branch: '', isGitRepo: false }
  }

  let branch = ''
  try {
    branch = (await runGit(directory, ['branch', '--show-current'])).trim()
  } catch {}

  try {
    const statusOutput = await runGit(directory, ['status', '--porcelain=v1', '-uall'])

    // A file can appear twice if it has both staged and unstaged changes
    // Split into staged and unstaged entries
    const result: Array<{ path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'; staged: boolean; oldPath?: string }> = []
    // Do NOT trim() the output — leading spaces are status codes (X=' ' means not staged)
    for (const line of statusOutput.split('\n').filter((l) => l.length >= 4)) {
      // Porcelain v1 format: XY PATH — use regex to robustly extract status and path
      const match = line.match(/^(.)(.) (.+)$/)
      if (!match) continue
      const x = match[1]
      const y = match[2]
      let filePath = match[3]
      let oldPath: string | undefined
      if (filePath.includes(' -> ')) {
        const parts = filePath.split(' -> ')
        oldPath = parts[0]
        filePath = parts[1]
      }

      // Staged change
      if (x !== ' ' && x !== '?' && x !== '!') {
        let status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
        if (x === 'A') status = 'added'
        else if (x === 'D') status = 'deleted'
        else if (x === 'R') status = 'renamed'
        else status = 'modified'
        result.push({ path: filePath, status, staged: true, oldPath })
      }
      // Unstaged change
      if (y !== ' ' && y !== '!') {
        let status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
        if (y === '?') status = 'untracked'
        else if (y === 'A') status = 'added'
        else if (y === 'D') status = 'deleted'
        else if (y === 'R') status = 'renamed'
        else status = 'modified'
        result.push({ path: filePath, status, staged: false, oldPath })
      }
    }

    return { files: result, branch, isGitRepo: true }
  } catch {
    return { files: [], branch, isGitRepo: true }
  }
})

ipcMain.handle(IPC.GIT_COMMIT, async (_event, { directory, message }: { directory: string; message: string }) => {
  try {
    await runGit(directory, ['commit', '-m', message])
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle(IPC.GIT_FETCH, async (_event, { directory }: { directory: string }) => {
  try {
    await runGit(directory, ['fetch', '--all'])
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle(IPC.GIT_PULL, async (_event, { directory }: { directory: string }) => {
  try {
    await runGit(directory, ['pull'])
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle(IPC.GIT_PUSH, async (_event, { directory }: { directory: string }) => {
  try {
    await runGit(directory, ['push'])
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle(IPC.GIT_BRANCHES, async (_event, { directory }: { directory: string }) => {
  try {
    const output = await runGit(directory, [
      'branch', '-a', '--format=%(refname:short)%x00%(HEAD)%x00%(upstream:short)',
    ])
    let current = ''
    const branches: Array<{ name: string; isCurrent: boolean; upstream: string | null; isRemote: boolean }> = []
    for (const line of output.trim().split('\n').filter(Boolean)) {
      const [name, head, upstream] = line.split('\x00')
      const isCurrent = head === '*'
      if (isCurrent) current = name
      const isRemote = name.startsWith('origin/') || name.includes('/')
      branches.push({ name, isCurrent, upstream: upstream || null, isRemote })
    }
    return { branches, current }
  } catch (err: any) {
    return { branches: [], current: '' }
  }
})

ipcMain.handle(IPC.GIT_CHECKOUT, async (_event, { directory, branch }: { directory: string; branch: string }) => {
  try {
    await runGit(directory, ['checkout', branch])
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle(IPC.GIT_CREATE_BRANCH, async (_event, { directory, name }: { directory: string; name: string }) => {
  try {
    await runGit(directory, ['checkout', '-b', name])
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle(IPC.GIT_DIFF, async (_event, { directory, path, staged }: { directory: string; path: string; staged: boolean }) => {
  const { basename } = require('path')
  try {
    let diff: string
    if (staged) {
      diff = await runGit(directory, ['diff', '--cached', '--', path])
    } else {
      // Try normal diff first
      diff = await runGit(directory, ['diff', '--', path])
      // If empty, might be untracked - read file contents
      if (!diff.trim()) {
        try {
          const { readFileSync } = require('fs')
          const { join } = require('path')
          const fullPath = join(directory, path)
          const content = readFileSync(fullPath, 'utf-8')
          const lines = content.split('\n')
          diff = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` +
            lines.map((l: string) => `+${l}`).join('\n')
        } catch {
          diff = ''
        }
      }
    }
    return { diff, fileName: basename(path) }
  } catch (err: any) {
    return { diff: '', fileName: basename(path) }
  }
})

ipcMain.handle(IPC.GIT_STAGE, async (_event, { directory, paths }: { directory: string; paths: string[] }) => {
  try {
    await runGit(directory, ['add', '--', ...paths])
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle(IPC.GIT_UNSTAGE, async (_event, { directory, paths }: { directory: string; paths: string[] }) => {
  try {
    await runGit(directory, ['restore', '--staged', '--', ...paths])
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle(IPC.GIT_DISCARD, async (_event, { directory, paths }: { directory: string; paths: string[] }) => {
  try {
    // Separate tracked and untracked files
    const statusOutput = await runGit(directory, ['status', '--porcelain=v1', '-uall', '--', ...paths])
    const trackedPaths: string[] = []
    const untrackedPaths: string[] = []
    for (const line of statusOutput.split('\n').filter((l) => l.length >= 4)) {
      const dm = line.match(/^(.)(.) (.+)$/)
      if (!dm) continue
      const x = dm[1]
      const y = dm[2]
      let p = dm[3]
      if (p.includes(' -> ')) p = p.split(' -> ')[1]
      if (x === '?' && y === '?') {
        untrackedPaths.push(p)
      } else {
        trackedPaths.push(p)
      }
    }
    if (trackedPaths.length > 0) {
      await runGit(directory, ['checkout', 'HEAD', '--', ...trackedPaths])
    }
    if (untrackedPaths.length > 0) {
      const { join } = require('path')
      for (const p of untrackedPaths) {
        try {
          await unlink(join(directory, p))
        } catch {}
      }
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle(IPC.GIT_DELETE_BRANCH, async (_event, { directory, branch }: { directory: string; branch: string }) => {
  try {
    await runGit(directory, ['branch', '-d', branch])
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

// ─── Theme Detection ───

ipcMain.handle(IPC.GET_THEME, () => {
  return { isDark: nativeTheme.shouldUseDarkColors }
})

nativeTheme.on('updated', () => {
  broadcast(IPC.THEME_CHANGED, nativeTheme.shouldUseDarkColors)
})

// ─── Permission Preflight ───
// Request all required macOS permissions upfront on first launch so the user
// is never interrupted mid-session by a permission prompt.

async function requestPermissions(): Promise<void> {
  if (process.platform !== 'darwin') return

  // ── Microphone (for voice input via Whisper) ──
  try {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone')
    if (micStatus === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone')
    }
  } catch (err: any) {
    log(`Permission preflight: microphone check failed — ${err.message}`)
  }

  // ── Accessibility (for global ⌥+Space shortcut) ──
  // globalShortcut works without it on modern macOS; Cmd+Shift+K is always the fallback.
  // Screen Recording: not requested upfront — macOS 15 Sequoia shows an alarming
  // "bypass private window picker" dialog. Let the OS prompt naturally if/when
  // the screenshot feature is actually used.
}

// ─── App Lifecycle ───

app.whenReady().then(async () => {
  // macOS: become an accessory app. Accessory apps can have key windows (keyboard works)
  // without deactivating the currently active app (hover preserved in browsers).
  // This is how Spotlight, Alfred, Raycast work.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide()
  }

  // Request permissions upfront so the user is never interrupted mid-session.
  await requestPermissions()

  // Skill provisioning — non-blocking, streams status to renderer
  ensureSkills((status: SkillStatus) => {
    log(`Skill ${status.name}: ${status.state}${status.error ? ` — ${status.error}` : ''}`)
    broadcast(IPC.SKILL_STATUS, status)
  }).catch((err: Error) => log(`Skill provisioning error: ${err.message}`))

  createWindow()
  snapshotWindowState('after createWindow')

  if (SPACES_DEBUG) {
    mainWindow?.on('show', () => snapshotWindowState('event window show'))
    mainWindow?.on('hide', () => snapshotWindowState('event window hide'))
    mainWindow?.on('focus', () => snapshotWindowState('event window focus'))
    mainWindow?.on('blur', () => snapshotWindowState('event window blur'))
    mainWindow?.webContents.on('focus', () => snapshotWindowState('event webContents focus'))
    mainWindow?.webContents.on('blur', () => snapshotWindowState('event webContents blur'))

    app.on('browser-window-focus', () => snapshotWindowState('event app browser-window-focus'))
    app.on('browser-window-blur', () => snapshotWindowState('event app browser-window-blur'))

    screen.on('display-added', (_e, display) => {
      log(`[spaces] event display-added id=${display.id}`)
      snapshotWindowState('event display-added')
    })
    screen.on('display-removed', (_e, display) => {
      log(`[spaces] event display-removed id=${display.id}`)
      snapshotWindowState('event display-removed')
    })
    screen.on('display-metrics-changed', (_e, display, changedMetrics) => {
      log(`[spaces] event display-metrics-changed id=${display.id} changed=${changedMetrics.join(',')}`)
      snapshotWindowState('event display-metrics-changed')
    })
  }


  // Primary: Option+Space (2 keys, doesn't conflict with shell)
  // Fallback: Cmd+Shift+K kept as secondary shortcut
  const registered = globalShortcut.register('Alt+Space', () => toggleWindow('shortcut Alt+Space'))
  if (!registered) {
    log('Alt+Space shortcut registration failed — macOS input sources may claim it')
  }
  globalShortcut.register('CommandOrControl+Shift+K', () => toggleWindow('shortcut Cmd/Ctrl+Shift+K'))

  const trayIconPath = join(__dirname, '../../resources/trayTemplate.png')
  const trayIcon = nativeImage.createFromPath(trayIconPath)
  trayIcon.setTemplateImage(true)
  tray = new Tray(trayIcon)
  tray.setToolTip('Clui CC — Claude Code UI')
  tray.on('click', () => toggleWindow('tray click'))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Clui CC', click: () => showWindow('tray menu') },
      { type: 'separator' },
      { label: 'Settings...', click: () => {
        showWindow('tray settings')
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.SHOW_SETTINGS)
        }
      }},
      { type: 'separator' },
      { label: 'Quit', click: () => { app.quit() } },
    ])
  )

  // app 'activate' fires when macOS brings the app to the foreground (e.g. after
  // webContents.focus() triggers applicationDidBecomeActive on some macOS versions).
  // Using showWindow here instead of toggleWindow prevents the re-entry race where
  // a summon immediately hides itself because activate fires mid-show.
  app.on('activate', () => showWindow('app activate'))
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  controlPlane.shutdown()
  flushLogs()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
