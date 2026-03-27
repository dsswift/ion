import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, Tray, Menu, nativeImage, nativeTheme, shell, systemPreferences } from 'electron'
import { join, basename } from 'path'
import { existsSync, readdirSync, statSync, createReadStream, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'fs'
import { unlink } from 'fs/promises'
import { createInterface } from 'readline'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { execFile as execFileCb, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { ControlPlane } from './claude/control-plane'
import { ensureSkills, type SkillStatus } from './skills/installer'
import { fetchCatalog, listInstalled, installPlugin, uninstallPlugin } from './marketplace/catalog'
import { discoverCommands } from './claude/command-discovery'
import { log as _log, LOG_FILE, flushLogs } from './logger'
import { getCliEnv } from './cli-env'
import { IPC } from '../shared/types'
import type { RunOptions, NormalizedEvent, EnrichedError, WorktreeInfo, WorktreeStatus } from '../shared/types'
import { TerminalManager } from './terminal-manager'
import { isValidProjectPath, isValidSessionId, validateExternalUrl, buildTerminalCommand } from './ipc-validation'

const gitExec = promisify(execFileCb)

const DEBUG_MODE = process.env.CODA_DEBUG === '1'
const SPACES_DEBUG = DEBUG_MODE || process.env.CODA_SPACES_DEBUG === '1'

function log(msg: string): void {
  _log('main', msg)
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let screenshotCounter = 0
let toggleSequence = 0
let forceQuit = false

// Feature flag: enable PTY interactive permissions transport
const INTERACTIVE_PTY = process.env.CODA_INTERACTIVE_PERMISSIONS_PTY === '1'

const controlPlane = new ControlPlane(INTERACTIVE_PTY)

// Forward-declared — initialized after broadcast() is defined
let terminalManager: TerminalManager

// The native window covers the full screen work area so that floating panels
// (plan viewer, diff viewer, git panel) can be positioned anywhere without clipping.
// The UI itself renders at the bottom center; all other regions are transparent/click-through.

// ─── Broadcast to renderer ───

function broadcast(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

terminalManager = new TerminalManager(broadcast)

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
  broadcast('coda:normalized-event', tabId, event)
})

controlPlane.on('tab-status-change', (tabId: string, newStatus: string, oldStatus: string) => {
  broadcast('coda:tab-status-change', tabId, newStatus, oldStatus)
})

controlPlane.on('error', (tabId: string, error: EnrichedError) => {
  broadcast('coda:enriched-error', tabId, error)
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

  // Log renderer crashes and errors for diagnostics
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log(`[renderer:error] ${message}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log(`[renderer:gone] reason=${details.reason} exitCode=${details.exitCode}`)
  })

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

  app.on('before-quit', (e) => {
    if (forceQuit) return
    e.preventDefault()
    const hasRunning = controlPlane.hasRunningTabs()
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Quit CODA?',
      message: hasRunning
        ? 'Sessions are still running. Quitting will stop them.'
        : 'Are you sure you want to quit?',
      detail: 'Tip: Press ⌥Space to hide/show the app without quitting.',
    })
    if (choice === 0) {
      forceQuit = true
      terminalManager.destroyAll()
      controlPlane.shutdown()
      globalShortcut.unregisterAll()
      if (tray) {
        tray.destroy()
        tray = null
      }
      flushLogs()
      app.exit(0)
    }
  })
  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  const trayIconPath = join(__dirname, '../../resources/trayTemplate.png')
  const trayIcon = nativeImage.createFromPath(trayIconPath)
  trayIcon.setTemplateImage(true)
  tray = new Tray(trayIcon)
  tray.setToolTip('CODA — Claude Overlay Dev Assistant')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Toggle Interface', accelerator: 'Alt+Space', click: () => toggleWindow('tray menu') },
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
}

function ensureWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
  }
  if (!tray || tray.isDestroyed()) {
    createTray()
  }
}

function showWindow(source = 'unknown'): void {
  ensureWindow()
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
  if (!mainWindow || mainWindow.isDestroyed()) return
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

  // Auto-register tab if it doesn't exist in the control plane
  // (handles race conditions on first launch, process restarts, stale state)
  if (!controlPlane.hasTab(tabId)) {
    log(`PROMPT: tab ${tabId} not found — auto-registering`)
    controlPlane.ensureTab(tabId)
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
  terminalManager.destroy(tabId)
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

// ─── Bash command execution ───

const bashProcesses = new Map<string, ChildProcess>()

ipcMain.handle(IPC.EXECUTE_BASH, async (_event, { id, command, cwd }: { id: string; command: string; cwd: string }) => {
  log(`IPC EXECUTE_BASH [${id}]: ${command} (cwd=${cwd})`)
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve) => {
    const shell = process.env.SHELL || '/bin/bash'
    const child = spawn(shell, ['-lc', command], { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    bashProcesses.set(id, child)

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout!.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    child.on('close', (code) => {
      bashProcesses.delete(id)
      controlPlane.notifyExternalWorkDone()
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code,
      })
    })

    child.on('error', (err) => {
      bashProcesses.delete(id)
      controlPlane.notifyExternalWorkDone()
      resolve({ stdout: '', stderr: err.message, exitCode: 1 })
    })
  })
})

ipcMain.on(IPC.CANCEL_BASH, (_event, id: string) => {
  const child = bashProcesses.get(id)
  if (child) {
    log(`IPC CANCEL_BASH [${id}]: sending SIGINT`)
    child.kill('SIGINT')
  }
})

// ─── Fonts ───

let cachedFonts: string[] | null = null

ipcMain.handle(IPC.LIST_FONTS, async () => {
  if (cachedFonts) return cachedFonts
  try {
    const script = `
use framework "AppKit"
set fm to current application's NSFontManager's sharedFontManager()
set families to fm's availableFontFamilies() as list
set output to ""
repeat with f in families
  set fl to f as text
  if fl contains "Nerd" then
    set output to output & fl & linefeed
  else
    set members to fm's availableMembersOfFontFamily:f
    if members is not missing value and (count of members) > 0 then
      set traits to item 4 of (item 1 of members) as integer
      if (traits div 1024) mod 2 = 1 then
        set output to output & fl & linefeed
      end if
    end if
  end if
end repeat
return output`
    const { stdout } = await gitExec('/usr/bin/osascript', ['-e', script])
    cachedFonts = stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b))
    return cachedFonts
  } catch {
    return ['Menlo', 'Monaco', 'Courier New']
  }
})

// ─── Terminal PTY ───

ipcMain.handle(IPC.TERMINAL_CREATE, (_event, { tabId, cwd }: { tabId: string; cwd: string }) => {
  log(`IPC TERMINAL_CREATE: tab=${tabId} cwd=${cwd}`)
  terminalManager.create(tabId, cwd)
})

ipcMain.on(IPC.TERMINAL_DATA, (_event, { tabId, data }: { tabId: string; data: string }) => {
  terminalManager.write(tabId, data)
})

ipcMain.on(IPC.TERMINAL_RESIZE, (_event, { tabId, cols, rows }: { tabId: string; cols: number; rows: number }) => {
  terminalManager.resize(tabId, cols, rows)
})

ipcMain.handle(IPC.TERMINAL_DESTROY, (_event, { tabId }: { tabId: string }) => {
  log(`IPC TERMINAL_DESTROY: tab=${tabId}`)
  terminalManager.destroy(tabId)
})

ipcMain.handle(IPC.RESPOND_PERMISSION, (_event, { tabId, questionId, optionId }: { tabId: string; questionId: string; optionId: string }) => {
  log(`IPC RESPOND_PERMISSION: tab=${tabId} question=${questionId} option=${optionId}`)
  return controlPlane.respondToPermission(tabId, questionId, optionId)
})

ipcMain.handle(IPC.APPROVE_DENIED_TOOLS, (_event, { tabId, toolNames }: { tabId: string; toolNames: string[] }) => {
  log(`IPC APPROVE_DENIED_TOOLS: tab=${tabId} tools=${toolNames.join(',')}`)
  controlPlane.approveToolsForTab(tabId, toolNames)
})

ipcMain.handle(IPC.DISCOVER_COMMANDS, async (_e, projectPath: string) => {
  log(`IPC DISCOVER_COMMANDS (path=${projectPath})`)
  try {
    if (!isValidProjectPath(projectPath)) {
      log(`DISCOVER_COMMANDS: rejected invalid projectPath: ${projectPath}`)
      return []
    }
    return await discoverCommands(projectPath)
  } catch (err) {
    log(`DISCOVER_COMMANDS error: ${err}`)
    return []
  }
})

ipcMain.handle(IPC.LIST_SESSIONS, async (_e, projectPath?: string) => {
  log(`IPC LIST_SESSIONS ${projectPath ? `(path=${projectPath})` : ''}`)
  try {
    const cwd = projectPath || process.cwd()
    if (!isValidProjectPath(cwd)) {
      log(`LIST_SESSIONS: rejected invalid projectPath: ${cwd}`)
      return []
    }
    // Claude stores project sessions at ~/.claude/projects/<encoded-path>/
    // Path encoding: replace all '/' with '-' (leading '/' becomes leading '-')
    const encodedPath = cwd.replace(/\//g, '-')
    const sessionsDir = join(homedir(), '.claude', 'projects', encodedPath)
    if (!existsSync(sessionsDir)) {
      log(`LIST_SESSIONS: directory not found: ${sessionsDir}`)
      return []
    }
    const files = readdirSync(sessionsDir).filter((f: string) => f.endsWith('.jsonl'))

    const sessions: Array<{ sessionId: string; slug: string | null; firstMessage: string | null; lastResponse: string | null; lastTimestamp: string; size: number }> = []

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
      const meta: { validated: boolean; slug: string | null; firstMessage: string | null; lastResponse: string | null; lastTimestamp: string | null } = {
        validated: false, slug: null, firstMessage: null, lastResponse: null, lastTimestamp: null,
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
              let raw = ''
              if (typeof content === 'string') {
                raw = content
              } else if (Array.isArray(content)) {
                raw = (content.find((p: any) => p.type === 'text')?.text) || ''
              }
              // Skip CLI internal messages, but show bash commands with ! prefix
              if (!raw || raw.includes('<local-command-caveat') || raw.includes('<bash-stdout') || raw.includes('<bash-stderr') || raw.includes('<system-reminder') || raw.includes('<command-name')) {
                // Skip: internal hints and output-only messages
              } else if (raw.includes('<bash-input')) {
                const cmd = extractTag(raw, 'bash-input')
                if (cmd) meta.firstMessage = `! ${cmd.trim()}`.substring(0, 100)
              } else {
                const cleaned = cleanCliTags(raw)
                const { bashEntries, remainder } = extractBashEntries(cleaned)
                if (bashEntries.length > 0) {
                  meta.firstMessage = `! ${bashEntries[0].command}`.substring(0, 100)
                } else {
                  meta.firstMessage = cleaned.substring(0, 100) || null
                }
              }
            }
            // Extract last assistant response (overwrites each time so we keep the final one)
            if (obj.type === 'assistant') {
              const content = obj.message?.content
              let raw = ''
              if (typeof content === 'string') {
                raw = content
              } else if (Array.isArray(content)) {
                raw = (content.find((p: any) => p.type === 'text')?.text) || ''
              }
              if (raw) {
                const cleaned = cleanCliTags(raw).substring(0, 100)
                if (cleaned) meta.lastResponse = cleaned
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
          lastResponse: meta.lastResponse,
          lastTimestamp: meta.lastTimestamp || stat.mtime.toISOString(),
          size: stat.size,
        })
      }
    }

    // Sort by last timestamp, most recent first
    sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
    const top = sessions.slice(0, 20)

    // Merge in persisted custom titles and add project fields
    const labels = loadSessionLabels()
    for (const s of top) {
      (s as any).customTitle = labels[s.sessionId] || null
      ;(s as any).projectPath = null
      ;(s as any).projectLabel = null
      ;(s as any).encodedDir = null
    }
    return top
  } catch (err) {
    log(`LIST_SESSIONS error: ${err}`)
    return []
  }
})

// ─── Path Decoder ───
// Claude encodes project paths by replacing '/' with '-'. Since paths can contain
// hyphens, the encoding is ambiguous. We resolve by greedy filesystem walking.
function decodeProjectPath(encoded: string): string | null {
  // Encoded always starts with '-' (from leading '/'), strip it
  if (!encoded.startsWith('-')) return null
  const segments = encoded.slice(1).split('-')
  if (segments.length === 0) return null

  let current = '/'
  let i = 0
  while (i < segments.length) {
    // Try progressively longer hyphen-joined segments (greedy)
    let matched = false
    for (let end = segments.length; end > i; end--) {
      const candidate = segments.slice(i, end).join('-')
      const testPath = join(current, candidate)
      try {
        if (existsSync(testPath) && statSync(testPath).isDirectory()) {
          current = testPath
          i = end
          matched = true
          break
        }
      } catch {}
    }
    if (!matched) return null
  }
  return current
}

// ─── Shared Session Metadata Parser ───
interface ParsedSessionMeta {
  sessionId: string
  slug: string | null
  firstMessage: string | null
  lastResponse: string | null
  lastTimestamp: string
  size: number
}

async function parseSessionMeta(filePath: string, fileSessionId: string, fileSize: number, fileMtime: Date): Promise<ParsedSessionMeta | null> {
  const meta = { validated: false, slug: null as string | null, firstMessage: null as string | null, lastResponse: null as string | null, lastTimestamp: null as string | null }

  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: createReadStream(filePath) })
    rl.on('line', (line: string) => {
      try {
        const obj = JSON.parse(line)
        if (!meta.validated && obj.type && obj.uuid && obj.timestamp) meta.validated = true
        if (obj.slug && !meta.slug) meta.slug = obj.slug
        if (obj.timestamp) meta.lastTimestamp = obj.timestamp
        if (obj.type === 'user' && !meta.firstMessage) {
          const content = obj.message?.content
          let raw = ''
          if (typeof content === 'string') raw = content
          else if (Array.isArray(content)) raw = (content.find((p: any) => p.type === 'text')?.text) || ''
          if (!raw || raw.includes('<local-command-caveat') || raw.includes('<bash-stdout') || raw.includes('<bash-stderr') || raw.includes('<system-reminder') || raw.includes('<command-name')) {
            // Skip internal
          } else if (raw.includes('<bash-input')) {
            const cmd = extractTag(raw, 'bash-input')
            if (cmd) meta.firstMessage = `! ${cmd.trim()}`.substring(0, 100)
          } else {
            const cleaned = cleanCliTags(raw)
            const { bashEntries, remainder } = extractBashEntries(cleaned)
            if (bashEntries.length > 0) meta.firstMessage = `! ${bashEntries[0].command}`.substring(0, 100)
            else meta.firstMessage = cleaned.substring(0, 100) || null
          }
        }
        if (obj.type === 'assistant') {
          const content = obj.message?.content
          let raw = ''
          if (typeof content === 'string') raw = content
          else if (Array.isArray(content)) raw = (content.find((p: any) => p.type === 'text')?.text) || ''
          if (raw) {
            const cleaned = cleanCliTags(raw).substring(0, 100)
            if (cleaned) meta.lastResponse = cleaned
          }
        }
      } catch {}
    })
    rl.on('close', () => resolve())
  })

  if (!meta.validated) return null
  return {
    sessionId: fileSessionId,
    slug: meta.slug,
    firstMessage: meta.firstMessage,
    lastResponse: meta.lastResponse,
    lastTimestamp: meta.lastTimestamp || fileMtime.toISOString(),
    size: fileSize,
  }
}

// ─── LIST_ALL_SESSIONS: scan all directories under ~/.claude/projects/ ───
ipcMain.handle(IPC.LIST_ALL_SESSIONS, async () => {
  log('IPC LIST_ALL_SESSIONS')
  try {
    const projectsRoot = join(homedir(), '.claude', 'projects')
    if (!existsSync(projectsRoot)) return []

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    // Phase 1: stat only — collect all session files with mtime
    const candidates: Array<{ encodedDir: string; sessionId: string; mtime: number; size: number; filePath: string }> = []
    const dirs = readdirSync(projectsRoot)

    for (const encodedDir of dirs) {
      const dirPath = join(projectsRoot, encodedDir)
      try {
        if (!statSync(dirPath).isDirectory()) continue
      } catch { continue }

      const files = readdirSync(dirPath).filter((f: string) => f.endsWith('.jsonl'))
      for (const file of files) {
        const sessionId = file.replace(/\.jsonl$/, '')
        if (!UUID_RE.test(sessionId)) continue
        const fp = join(dirPath, file)
        try {
          const st = statSync(fp)
          if (st.size < 100) continue
          candidates.push({ encodedDir, sessionId, mtime: st.mtime.getTime(), size: st.size, filePath: fp })
        } catch { continue }
      }
    }

    // Sort by mtime descending, take top 50
    candidates.sort((a, b) => b.mtime - a.mtime)
    const top = candidates.slice(0, 50)

    // Phase 2: parse metadata for top 50 and decode paths
    const labels = loadSessionLabels()
    const pathCache = new Map<string, string | null>()
    const sessions: Array<{ sessionId: string; slug: string | null; firstMessage: string | null; lastResponse: string | null; lastTimestamp: string; size: number; customTitle: string | null; projectPath: string | null; projectLabel: string | null; encodedDir: string }> = []

    for (const c of top) {
      const parsed = await parseSessionMeta(c.filePath, c.sessionId, c.size, new Date(c.mtime))
      if (!parsed) continue

      // Decode project path (cached per encodedDir)
      let projectPath: string | null
      if (pathCache.has(c.encodedDir)) {
        projectPath = pathCache.get(c.encodedDir)!
      } else {
        projectPath = decodeProjectPath(c.encodedDir)
        pathCache.set(c.encodedDir, projectPath)
      }

      const projectLabel = projectPath
        ? basename(projectPath)
        : c.encodedDir.split('-').filter(Boolean).pop() || c.encodedDir

      sessions.push({
        ...parsed,
        customTitle: labels[parsed.sessionId] || null,
        projectPath,
        projectLabel,
        encodedDir: c.encodedDir,
      })
    }

    log(`LIST_ALL_SESSIONS: found ${sessions.length} sessions across ${pathCache.size} directories`)
    return sessions
  } catch (err) {
    log(`LIST_ALL_SESSIONS error: ${err}`)
    return []
  }
})

// Load conversation history from a session's JSONL file
/**
 * Clean CLI-internal XML tags from session JSONL content.
 * Removes hidden tags entirely and strips wrapper tags from visible content.
 */
function cleanCliTags(text: string): string {
  let result = text.replace(/<(?:local-command-caveat|system-reminder|command-name|command-message|command-args|task-notification)[^>]*>[\s\S]*?<\/(?:local-command-caveat|system-reminder|command-name|command-message|command-args|task-notification)>\s*(?:Read the output file to retrieve the result:[^\n]*)?\n?/g, '')
  result = result.replace(/<\/?(?:bash-input|bash-stdout|bash-stderr)[^>]*>/g, '')
  return result.trim()
}

/** Extract inner text from a specific XML tag, or null if not present */
function extractTag(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)
  const m = text.match(re)
  return m ? m[1] : null
}

/**
 * Extract CODA-prepended bash command results from a user message.
 * Pattern: "$ command\n```\noutput\n```" optionally followed by more bash entries,
 * then the actual user message.
 */
function extractBashEntries(text: string): { bashEntries: Array<{ command: string; output: string }>; remainder: string } {
  const bashEntries: Array<{ command: string; output: string }>[] = []
  const entries: Array<{ command: string; output: string }> = []
  let rest = text

  // Match pattern: $ command\n```\noutput\n``` (possibly with stderr blocks too)
  const pattern = /^\$ (.+)\n```\n([\s\S]*?)\n```(?:\nstderr:\n```\n[\s\S]*?\n```)?\s*/
  let match = rest.match(pattern)
  while (match) {
    entries.push({ command: match[1], output: match[2] })
    rest = rest.slice(match[0].length)
    match = rest.match(pattern)
  }

  return { bashEntries: entries, remainder: rest }
}

ipcMain.handle(IPC.LOAD_SESSION, async (_e, arg: { sessionId: string; projectPath?: string; encodedDir?: string } | string) => {
  const sessionId = typeof arg === 'string' ? arg : arg.sessionId
  const projectPath = typeof arg === 'string' ? undefined : arg.projectPath
  const encodedDir = typeof arg === 'string' ? undefined : arg.encodedDir
  log(`IPC LOAD_SESSION ${sessionId}${projectPath ? ` (path=${projectPath})` : ''}${encodedDir ? ` (encodedDir=${encodedDir})` : ''}`)
  try {
    if (!isValidSessionId(sessionId)) {
      log(`LOAD_SESSION: rejected invalid sessionId: ${sessionId}`)
      return []
    }
    // When encodedDir is provided (from global history), use it directly
    let filePath: string
    if (encodedDir) {
      filePath = join(homedir(), '.claude', 'projects', encodedDir, `${sessionId}.jsonl`)
    } else {
      const cwd = projectPath || process.cwd()
      if (!isValidProjectPath(cwd)) {
        log(`LOAD_SESSION: rejected invalid projectPath: ${cwd}`)
        return []
      }
      const encodedPath = cwd.replace(/\//g, '-')
      filePath = join(homedir(), '.claude', 'projects', encodedPath, `${sessionId}.jsonl`)
    }
    if (!existsSync(filePath)) return []

    const messages: Array<{ role: string; content: string; toolName?: string; toolInput?: string; toolId?: string; userExecuted?: boolean; attachments?: Array<{ id: string; type: string; name: string; path: string; mimeType?: string }>; timestamp: number }> = []

    // MIME type lookup for reconstructing attachments from history
    const extToMime: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.txt': 'text/plain', '.md': 'text/markdown',
      '.json': 'application/json', '.yaml': 'text/yaml', '.yml': 'text/yaml',
      '.toml': 'text/toml', '.ts': 'text/typescript', '.tsx': 'text/typescript',
      '.js': 'text/javascript', '.py': 'text/x-python', '.rs': 'text/x-rust',
      '.go': 'text/x-go',
    }

    // Extract [Attached type: path] lines from text, returning attachments and cleaned text
    const parseAttachmentLines = (text: string) => {
      const attachmentRegex = /^\[Attached (image|file|plan): (.+)\]$/gm
      const attachments: Array<{ id: string; type: 'image' | 'file' | 'plan'; name: string; path: string; mimeType?: string }> = []
      let match
      while ((match = attachmentRegex.exec(text)) !== null) {
        const aType = match[1] as 'image' | 'file' | 'plan'
        const aPath = match[2]
        const aName = aPath.split('/').pop() || aPath
        const aExt = aName.includes('.') ? '.' + aName.split('.').pop()!.toLowerCase() : ''
        attachments.push({
          id: `hist-${Date.now()}-${attachments.length}`,
          type: aType,
          name: aName,
          path: aPath,
          mimeType: extToMime[aExt],
        })
      }
      const cleaned = text.replace(/^\[Attached (?:image|file|plan): .+\]\n*/gm, '').trim()
      return { attachments, cleaned }
    }

    // Find last ExitPlanMode tool message's planFilePath
    const findLastPlanFilePath = () => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.toolName === 'ExitPlanMode' && m.toolInput) {
          try {
            const input = JSON.parse(m.toolInput)
            if (input.planFilePath) return input.planFilePath as string
          } catch {}
        }
      }
      return null
    }
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: createReadStream(filePath) })
      rl.on('line', (line: string) => {
        try {
          const obj = JSON.parse(line)
          if (obj.type === 'user') {
            const content = obj.message?.content
            let raw = ''
            if (typeof content === 'string') {
              raw = content
            } else if (Array.isArray(content)) {
              // Extract tool_result blocks and attach content to matching tool messages
              for (const block of content) {
                if (block.type === 'tool_result' && block.tool_use_id) {
                  let resultText = ''
                  if (typeof block.content === 'string') {
                    resultText = block.content
                  } else if (Array.isArray(block.content)) {
                    resultText = block.content
                      .filter((c: any) => c.type === 'text' && c.text)
                      .map((c: any) => c.text)
                      .join('\n')
                  }
                  // Find matching tool message and set its content
                  const toolMsg = [...messages].reverse().find(
                    (m) => m.role === 'tool' && m.toolId === block.tool_use_id
                  )
                  if (toolMsg) {
                    toolMsg.content = resultText
                  }
                }
              }
              raw = content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('\n')
            }
            const ts = new Date(obj.timestamp).getTime()

            // CLI ! command messages: route by tag type
            if (raw.includes('<local-command-caveat')) {
              // Internal hint — discard entirely
            } else if (raw.includes('<bash-input')) {
              const cmd = extractTag(raw, 'bash-input') || raw
              messages.push({ role: 'user', content: `! ${cmd.trim()}`, userExecuted: true, timestamp: ts })
            } else if (raw.includes('<bash-stdout') || raw.includes('<bash-stderr')) {
              // Emit as a Bash tool card so it renders like agent tool output
              const stdout = extractTag(raw, 'bash-stdout') || ''
              const stderr = extractTag(raw, 'bash-stderr') || ''
              // Look back for the preceding bash-input to use as toolInput
              const prevMsg = messages[messages.length - 1]
              const cmdInput = prevMsg?.role === 'user' ? prevMsg.content : undefined
              messages.push({
                role: 'tool',
                content: '',
                toolName: 'Bash',
                toolInput: cmdInput ? JSON.stringify({ command: cmdInput }) : undefined,
                userExecuted: true,
                timestamp: ts,
              })
            } else {
              const text = cleanCliTags(raw)
              if (text) {
                // Detect CODA bash command results prepended to prompts: $ cmd\n```\noutput\n```
                const { bashEntries, remainder } = extractBashEntries(text)
                for (const entry of bashEntries) {
                  messages.push({ role: 'user', content: `! ${entry.command}`, userExecuted: true, timestamp: ts })
                  messages.push({
                    role: 'tool',
                    content: entry.output,
                    toolName: 'Bash',
                    toolInput: JSON.stringify({ command: entry.command }),
                    userExecuted: true,
                    timestamp: ts,
                  })
                }
                if (remainder.trim()) {
                  const { attachments: fileAttachments, cleaned } = parseAttachmentLines(remainder.trim())
                  const allAttachments: typeof fileAttachments = [...fileAttachments]

                  // Detect plan implementation messages and attach plan reference (fallback for old sessions)
                  const isImplementMsg = cleaned === 'Implement the plan' || cleaned.startsWith('Implement the following plan:')
                  if (isImplementMsg && !allAttachments.some(a => a.type === 'plan')) {
                    const planPath = findLastPlanFilePath()
                    if (planPath) {
                      const planName = planPath.split('/').pop() || planPath
                      allAttachments.push({ id: `plan-${Date.now()}`, type: 'plan', name: planName, path: planPath })
                    }
                  }

                  // For plan implementation messages with embedded content, show short display text
                  const displayContent = isImplementMsg && cleaned.startsWith('Implement the following plan:')
                    ? 'Implement the plan'
                    : cleaned

                  messages.push({
                    role: 'user',
                    content: displayContent,
                    attachments: allAttachments.length > 0 ? allAttachments : undefined,
                    timestamp: ts,
                  })
                }
              }
            }
          } else if (obj.type === 'assistant') {
            const content = obj.message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  messages.push({ role: 'assistant', content: cleanCliTags(block.text), timestamp: new Date(obj.timestamp).getTime() })
                } else if (block.type === 'tool_use' && block.name) {
                  messages.push({
                    role: 'tool',
                    content: '',
                    toolName: block.name,
                    toolId: block.id,
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
  mainWindow.hide()
  const options = { properties: ['openDirectory' as const] }
  const result = process.platform === 'darwin'
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options)
  showWindow('dialog-return')
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
  const validUrl = validateExternalUrl(url)
  if (!validUrl) return false
  try {
    await shell.openExternal(validUrl)
    return true
  } catch {
    return false
  }
})

ipcMain.handle(IPC.ATTACH_FILES, async () => {
  if (!mainWindow) return null
  mainWindow.hide()
  // macOS NSOpenPanel doesn't reliably handle extensions: ['*'] — omit filters
  // so all files are selectable. Other platforms get type filter dropdowns.
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
    : await dialog.showOpenDialog(mainWindow, options)
  showWindow('dialog-return')
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

ipcMain.handle(IPC.ATTACH_FILE_BY_PATH, async (_event, fp: string) => {
  const { basename, extname } = require('path')
  const { readFileSync, statSync } = require('fs')

  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
  const mimeMap: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
    '.json': 'application/json', '.yaml': 'text/yaml', '.toml': 'text/toml',
  }

  try {
    const ext = extname(fp).toLowerCase()
    const mime = mimeMap[ext] || 'application/octet-stream'
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
    const screenshotPath = join(tmpdir(), `coda-screenshot-${timestamp}.png`)

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
    const filePath = join(tmpdir(), `coda-paste-${timestamp}.${ext}`)
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
  const { execFile } = require('child_process')
  const { join, basename } = require('path')
  const { tmpdir } = require('os')

  const tmpWav = join(tmpdir(), `coda-voice-${Date.now()}.wav`)
  try {
    const runExecFile = (bin: string, args: string[], timeout: number): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(bin, args, { encoding: 'utf-8', timeout }, (err: any, stdout: string, stderr: string) => {
          if (err) {
            const detail = stderr?.trim() || stdout?.trim() || err.message
            reject(new Error(detail))
            return
          }
          resolve(stdout || '')
        })
      })

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
          whisperBin = await runExecFile('/bin/zsh', ['-lc', `whence -p ${name}`], 5000).then((s) => s.trim())
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
      output = await runExecFile(whisperBin, ['transcribe', '--audio-path', tmpWav, '--model', 'tiny', '--without-timestamps', '--skip-special-tokens', '--report', '--report-path', reportDir], 60000)
      // WhisperKit writes <audioFileName>.json (filename without extension)
      const wavBasename = basename(tmpWav, '.wav')
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
      // Fallback: re-run without --report only if first run produced no stdout
      if (!output || !output.trim()) {
        output = await runExecFile(whisperBin, ['transcribe', '--audio-path', tmpWav, '--model', 'tiny', '--without-timestamps', '--skip-special-tokens'], 60000)
      }
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
      output = await runExecFile(whisperBin, ['-m', modelPath, '-f', tmpWav, '--no-timestamps', '-l', isEnglishOnly ? 'en' : 'auto'], 30000)
    } else {
      // Python whisper
      output = await runExecFile(whisperBin, [tmpWav, '--model', 'tiny', '--output_format', 'txt', '--output_dir', tmpdir()], 30000)
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

  // Validate sessionId
  if (sessionId && !isValidSessionId(sessionId)) {
    log(`OPEN_IN_TERMINAL: rejected invalid sessionId: ${sessionId}`)
    return false
  }

  // Sanitize projectPath
  if (!isValidProjectPath(projectPath)) {
    log(`OPEN_IN_TERMINAL: rejected invalid projectPath: ${projectPath}`)
    return false
  }

  const cmd = buildTerminalCommand(projectPath, claudeBin, sessionId)

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

const SETTINGS_DIR = join(homedir(), '.coda')
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json')
const SETTINGS_DEFAULTS = { themeMode: 'dark', soundEnabled: true, expandedUI: false, ultraWide: false, defaultBaseDirectory: '', showDirLabel: true, preferredOpenWith: 'cli', showImplementClearContext: false, expandToolResults: false, terminalFontFamily: 'Menlo, Monaco, monospace', terminalFontSize: 13, allowSettingsEdits: false }

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

// ─── Session Labels (custom tab names persisted across tab close/restore) ───

const SESSION_LABELS_FILE = join(SETTINGS_DIR, 'session-labels.json')

function loadSessionLabels(): Record<string, string> {
  try {
    if (existsSync(SESSION_LABELS_FILE)) {
      return JSON.parse(readFileSync(SESSION_LABELS_FILE, 'utf-8'))
    }
  } catch (err) {
    log(`Failed to load session labels: ${err}`)
  }
  return {}
}

function saveSessionLabels(labels: Record<string, string>): void {
  try {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true })
    writeFileSync(SESSION_LABELS_FILE, JSON.stringify(labels, null, 2))
  } catch (err) {
    log(`Failed to save session labels: ${err}`)
  }
}

ipcMain.handle(IPC.SAVE_SESSION_LABEL, (_event, { sessionId, customTitle }: { sessionId: string; customTitle: string | null }) => {
  const labels = loadSessionLabels()
  if (customTitle) {
    labels[sessionId] = customTitle
  } else {
    delete labels[sessionId]
  }
  saveSessionLabels(labels)
})

ipcMain.handle(IPC.LOAD_SESSION_LABELS, () => {
  return loadSessionLabels()
})

// ─── Git Worktree Cleanup ───

async function cleanOrphanedWorktrees(): Promise<void> {
  const worktreeDir = join(homedir(), '.coda', 'worktrees')
  if (!existsSync(worktreeDir)) return
  try {
    const entries = readdirSync(worktreeDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const wtPath = join(worktreeDir, entry.name)
      try {
        await gitExec('git', ['rev-parse', '--git-dir'], { cwd: wtPath })
      } catch {
        log(`Cleaning orphaned worktree: ${wtPath}`)
        try { rmSync(wtPath, { recursive: true, force: true }) } catch {}
      }
    }
  } catch (err: any) {
    log(`Worktree cleanup error: ${err.message}`)
  }
}

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

ipcMain.handle(IPC.GIT_COMMIT_DETAIL, async (_event, { directory, hash }: { directory: string; hash: string }) => {
  try {
    const output = await runGit(directory, ['show', '--stat', '--format=', hash])
    // Last non-empty line is the summary, e.g. " 10 files changed, 344 insertions(+), 49 deletions(-)"
    const lines = output.trim().split('\n')
    const summary = lines[lines.length - 1] || ''
    const filesMatch = summary.match(/(\d+)\s+files?\s+changed/)
    const insMatch = summary.match(/(\d+)\s+insertions?\(\+\)/)
    const delMatch = summary.match(/(\d+)\s+deletions?\(-\)/)
    return {
      filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
      insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
      deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
    }
  } catch {
    return { filesChanged: 0, insertions: 0, deletions: 0 }
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

// ─── Git Worktree Handlers ───

ipcMain.handle(IPC.GIT_WORKTREE_ADD, async (_event, { repoPath, sourceBranch }: { repoPath: string; sourceBranch: string }) => {
  try {
    const id = randomBytes(4).toString('hex')
    const branchName = `wt/${randomBytes(4).toString('hex')}`
    const worktreeDir = join(homedir(), '.coda', 'worktrees')
    const worktreePath = join(worktreeDir, `${basename(repoPath)}-${id}`)
    mkdirSync(worktreeDir, { recursive: true })
    await runGit(repoPath, ['worktree', 'add', '-b', branchName, worktreePath, sourceBranch])
    const worktree: WorktreeInfo = { worktreePath, branchName, sourceBranch, repoPath }
    return { ok: true, worktree }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle(IPC.GIT_WORKTREE_REMOVE, async (_event, { repoPath, worktreePath, branchName, force }: { repoPath: string; worktreePath: string; branchName: string; force?: boolean }) => {
  try {
    const removeArgs = ['worktree', 'remove', worktreePath]
    if (force) removeArgs.push('--force')
    await runGit(repoPath, removeArgs)
    // Delete the branch -- ignore errors if already gone
    try { await runGit(repoPath, ['branch', '-D', branchName]) } catch {}
    // Try to remove parent directory if empty
    try {
      const parent = join(worktreePath, '..')
      const entries = readdirSync(parent)
      if (entries.length === 0) rmSync(parent, { recursive: true })
    } catch {}
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle(IPC.GIT_WORKTREE_LIST, async (_event, { repoPath }: { repoPath: string }) => {
  try {
    const raw = await runGit(repoPath, ['worktree', 'list', '--porcelain'])
    const worktrees: Array<{ path: string; branch: string; head: string }> = []
    const blocks = raw.trim().split('\n\n')
    for (const block of blocks) {
      if (!block.trim()) continue
      const lines = block.trim().split('\n')
      let wtPath = ''
      let head = ''
      let branch = ''
      for (const line of lines) {
        if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length)
        else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
        else if (line.startsWith('branch ')) branch = line.slice('branch refs/heads/'.length)
      }
      if (wtPath) worktrees.push({ path: wtPath, branch, head })
    }
    return { worktrees }
  } catch (err: any) {
    return { worktrees: [] }
  }
})

ipcMain.handle(IPC.GIT_WORKTREE_STATUS, async (_event, { worktreePath, sourceBranch }: { worktreePath: string; sourceBranch: string }) => {
  try {
    const statusOutput = await runGit(worktreePath, ['status', '--porcelain'])
    const hasUncommittedChanges = statusOutput.trim().length > 0

    let aheadCount = 0
    let behindCount = 0
    try {
      const ahead = await runGit(worktreePath, ['rev-list', '--count', `${sourceBranch}..HEAD`])
      aheadCount = parseInt(ahead.trim(), 10) || 0
    } catch {}
    try {
      const behind = await runGit(worktreePath, ['rev-list', '--count', `HEAD..${sourceBranch}`])
      behindCount = parseInt(behind.trim(), 10) || 0
    } catch {}

    let isMerged = false
    try {
      await runGit(worktreePath, ['merge-base', '--is-ancestor', 'HEAD', sourceBranch])
      isMerged = true
    } catch {}

    const status: WorktreeStatus = {
      hasUncommittedChanges,
      hasUnpushedCommits: aheadCount > 0,
      isMerged,
      aheadCount,
      behindCount,
    }
    return status
  } catch (err: any) {
    return { hasUncommittedChanges: false, hasUnpushedCommits: false, isMerged: false, aheadCount: 0, behindCount: 0 }
  }
})

ipcMain.handle(IPC.GIT_WORKTREE_MERGE, async (_event, { repoPath, worktreeBranch, sourceBranch }: { repoPath: string; worktreeBranch: string; sourceBranch: string }) => {
  try {
    await runGit(repoPath, ['checkout', sourceBranch])
    await runGit(repoPath, ['merge', '--no-ff', worktreeBranch])
    return { ok: true }
  } catch (err: any) {
    const msg = err.message || ''
    if (msg.includes('CONFLICT') || msg.includes('Merge conflict')) {
      return { ok: false, hasConflicts: true, error: msg }
    }
    return { ok: false, error: msg }
  }
})

ipcMain.handle(IPC.GIT_WORKTREE_PUSH, async (_event, { worktreePath }: { worktreePath: string }) => {
  try {
    await runGit(worktreePath, ['push', '-u', 'origin', 'HEAD'])
    const remoteUrl = (await runGit(worktreePath, ['remote', 'get-url', 'origin'])).trim()
    const remoteBranch = (await runGit(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return { ok: true, remoteBranch, remoteUrl }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle(IPC.GIT_WORKTREE_REBASE, async (_event, { worktreePath, sourceBranch }: { worktreePath: string; sourceBranch: string }) => {
  try {
    await runGit(worktreePath, ['fetch', 'origin'])
    await runGit(worktreePath, ['rebase', sourceBranch])
    return { ok: true }
  } catch (err: any) {
    const msg = err.message || ''
    const hasConflicts = msg.includes('CONFLICT') || msg.includes('could not apply')
    return { ok: false, error: msg, hasConflicts }
  }
})

// ─── Filesystem Operations ───

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
      } catch {
        // skip entries we can't stat (broken symlinks, permission errors)
      }
    }
    // Sort: directories first, then alphabetical case-insensitive
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
    // Check for binary content (null bytes in first 8KB)
    const check = buf.subarray(0, Math.min(8192, buf.length))
    if (check.includes(0)) return { content: null, error: 'Binary file' }
    return { content: buf.toString('utf-8') }
  } catch (err: any) {
    return { content: null, error: err.message }
  }
})

ipcMain.handle(IPC.FS_WRITE_FILE, async (_event, { filePath, content }: { filePath: string; content: string }) => {
  if (!isValidProjectPath(filePath)) return { ok: false, error: 'Invalid path' }
  try {
    writeFileSync(filePath, content, 'utf-8')
    return { ok: true }
  } catch (err: any) {
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
  if (!mainWindow) return { filePath: null }
  mainWindow.hide()
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultPath || undefined })
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
  // Await the permission dialog so it doesn't get lost behind the overlay.
  // This runs before createWindow(), so there's no window to appear dead.
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

  // Clean up orphaned worktree directories (fire and forget)
  cleanOrphanedWorktrees().catch((err: Error) => log(`Worktree cleanup failed: ${err.message}`))

  createWindow()
  snapshotWindowState('after createWindow')

  // Write PID file so install/stop scripts can signal this process
  const pidDir = app.getPath('userData')
  const pidPath = join(pidDir, 'coda.pid')
  writeFileSync(pidPath, String(process.pid))
  log(`PID file written: ${pidPath} (${process.pid})`)

  // Custom application menu: preserve standard edit shortcuts but remove Cmd+W close-window
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ]))

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

  createTray()

  // app 'activate' fires when macOS brings the app to the foreground (e.g. after
  // webContents.focus() triggers applicationDidBecomeActive on some macOS versions).
  // Using showWindow here instead of toggleWindow prevents the re-entry race where
  // a summon immediately hides itself because activate fires mid-show.
  app.on('activate', () => showWindow('app activate'))
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  controlPlane.shutdown()
  if (tray) {
    tray.destroy()
    tray = null
  }
  // Remove PID file
  try { rmSync(join(app.getPath('userData'), 'coda.pid')) } catch {}
  flushLogs()
})

// Graceful drain: install script sends SIGUSR1 to let active agents finish before quit
process.on('SIGUSR1', () => {
  log('SIGUSR1 received — draining active work before quit')
  const timeout = setTimeout(() => {
    log('Drain timeout (5min) — force quitting')
    forceQuit = true
    terminalManager.destroyAll()
    controlPlane.shutdown()
    globalShortcut.unregisterAll()
    if (tray) { tray.destroy(); tray = null }
    try { rmSync(join(app.getPath('userData'), 'coda.pid')) } catch {}
    flushLogs()
    app.exit(0)
  }, 5 * 60 * 1000)

  controlPlane.drain(() => bashProcesses.size > 0).then(() => {
    clearTimeout(timeout)
    log('All agents finished — quitting')
    forceQuit = true
    terminalManager.destroyAll()
    controlPlane.shutdown()
    globalShortcut.unregisterAll()
    if (tray) { tray.destroy(); tray = null }
    try { rmSync(join(app.getPath('userData'), 'coda.pid')) } catch {}
    flushLogs()
    app.exit(0)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
