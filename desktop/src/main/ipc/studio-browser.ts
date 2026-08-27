import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log, warn as _warn } from '../logger'
import { setStudioBrowserTabRequestHandler } from '../studio-browser-tab-request'
import {
  browserViewContents,
  destroyBrowserView,
  ensureBrowserView,
  navigateBrowserView,
  setBrowserViewBounds,
  setPopoverRects,
  type ViewBounds,
} from '../studio-browser-views'
import { setBrowserCommandSender } from '../studio-playwright/renderer-bridge'
import {
  parseBrowserCommandResult,
  type StudioBrowserCommand,
  type StudioBrowserCommandResult,
} from '../../shared/studio-browser-types'

const TAG = 'studio-browser-ipc'

let commandSeq = 0
let resolveStudioWindow: () => BrowserWindow | null = () => null

/**
 * Studio browser IPC: guest registration inbound, browser commands outbound.
 *
 * Registration is the security boundary. A renderer can name any integer, so
 * the guest is resolved in main and checked three ways: it must be a webview,
 * it must be hosted BY the sending window, and the sender must be the Studio
 * window. Trusting the renderer's claim instead would let any window with the
 * preload bridge hand the automation runtime a WebContents it does not own.
 *
 * Commands run the other way. Main owns the Playwright runtime but not Surface
 * descriptors, so creating, closing, or re-sizing the agent's tab is a request
 * the renderer applies and acknowledges. The correlation lives here for the
 * same reason it does for STUDIO_CALL_ACTION: main is the only party that knows
 * whether a Studio window exists, so a missing or wedged renderer produces a
 * resolved refusal instead of a caller hanging forever.
 */
export function setStudioBrowserWindowResolver(resolver: () => BrowserWindow | null): void {
  resolveStudioWindow = resolver
}

export function registerStudioBrowserIpc(): void {
  setStudioBrowserTabRequestHandler(requestStudioBrowserTab)
  // Guest creation. The renderer no longer owns the browser body: main builds
  // a WebContentsView (a real `page` CDP target Playwright can attach to) and
  // hands back nothing but success, because the renderer has no element to
  // hold on to any more.
  ipcMain.handle(
    IPC.STUDIO_BROWSER_VIEW_ENSURE,
    (event, conversationId: unknown, instanceId: unknown, url: unknown, partition: unknown) => {
      if (!fromStudio(event) || !isId(conversationId) || !isId(instanceId) || typeof partition !== 'string' || !partition) {
        _log(TAG, 'browser view ensure rejected', { sender_id: event.sender.id })
        return false
      }
      const guest = ensureBrowserView({
        conversationId,
        instanceId,
        partition,
        url: typeof url === 'string' ? url : '',
      })
      if (!guest) return false
      watchGuestState(guest, conversationId, instanceId)
      return true
    },
  )

  // Geometry. A view is painted by the window, not by the page, so the
  // renderer measures the hole it left in the layout and main puts the view
  // exactly there.
  ipcMain.on(
    IPC.STUDIO_BROWSER_VIEW_BOUNDS,
    (event, conversationId: unknown, instanceId: unknown, bounds: unknown, visible: unknown) => {
      if (!fromStudio(event) || !isId(conversationId) || !isId(instanceId)) return
      const parsed = parseBounds(bounds)
      if (!parsed) return
      setBrowserViewBounds(conversationId, instanceId, parsed, visible === true)
    },
  )

  ipcMain.handle(
    IPC.STUDIO_BROWSER_VIEW_NAVIGATE,
    (event, conversationId: unknown, instanceId: unknown, url: unknown) => {
      if (!fromStudio(event) || !isId(conversationId) || !isId(instanceId) || typeof url !== 'string') return false
      return navigateBrowserView(conversationId, instanceId, url)
    },
  )

  // Back / forward / reload. These were webview element methods; with the body
  // in main they become a named action on the guest.
  ipcMain.handle(
    IPC.STUDIO_BROWSER_VIEW_ACTION,
    (event, conversationId: unknown, instanceId: unknown, action: unknown) => {
      if (!fromStudio(event) || !isId(conversationId) || !isId(instanceId)) return false
      const guest = browserViewContents(conversationId, instanceId)
      if (!guest) return false
      switch (action) {
        case 'back': if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack(); return true
        case 'forward': if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward(); return true
        case 'reload': guest.reload(); return true
        default: return false
      }
    },
  )

  // Popover suppression. Sent as a depth rather than a flag because popovers
  // overlap, and the last one to close is what restores the browser.
  ipcMain.on(IPC.STUDIO_BROWSER_POPOVER_RECTS, (event, rects: unknown) => {
    if (!fromStudio(event) || !Array.isArray(rects)) return
    const parsed = rects.map(parseBounds).filter((rect): rect is ViewBounds => rect !== null)
    setPopoverRects(parsed)
  })

  ipcMain.handle(
    IPC.STUDIO_BROWSER_VIEW_CLOSE,
    (event, conversationId: unknown, instanceId: unknown) => {
      if (!fromStudio(event) || !isId(conversationId) || !isId(instanceId)) return false
      return destroyBrowserView(conversationId, instanceId)
    },
  )

  // Reply channel for the outbound command below. Validated and matched by
  // callId AND sender, so a non-Studio window cannot settle a pending command.
  setBrowserCommandSender((command, timeoutMs) => sendBrowserCommand(command, timeoutMs))
}

/**
 * Ask Studio to open a URL in a new browser tab.
 *
 * Used for a link the operator cmd-clicked inside a browser guest. Chromium
 * reports that as a new-tab disposition, which arrives at the webview policy's
 * window-open handler and is denied there as a popup — correctly, since a
 * surface browser tab is a single document. Rather than leaving the click dead,
 * the policy forwards it here and it becomes a real Surface tab.
 *
 * One-way on purpose: nothing waits on the result, and a dropped notification
 * costs the operator one click rather than wedging a tool call. Lives in this
 * file so the Studio-targeted send stays inside the parity allowlist.
 */
export function requestStudioBrowserTab(url: string): void {
  const studio = resolveStudioWindow()
  if (!studio || studio.isDestroyed()) {
    _log(TAG, 'browser tab request dropped, no studio window', { host: hostOf(url) })
    return
  }
  studio.webContents.send(IPC.STUDIO_BROWSER_OPEN_URL, url)
  _log(TAG, 'browser tab requested for clicked link', { host: hostOf(url) })
}

/** Host only: a full URL in a log line can carry tokens in its query. */
function hostOf(raw: string): string {
  try {
    return new URL(raw).host
  } catch {
    return ''
  }
}

/** Clear the sender when the Studio window goes away. */
export function clearStudioBrowserCommandSender(): void {
  setBrowserCommandSender(null)
}

async function sendBrowserCommand(command: StudioBrowserCommand, timeoutMs: number): Promise<StudioBrowserCommandResult> {
  const studio = resolveStudioWindow()
  if (!studio || studio.isDestroyed()) {
    return { callId: 'none', ok: false, error: 'the Ion Studio window is not open' }
  }
  const callId = `studio-browser-${++commandSeq}`
  const senderId = studio.webContents.id

  return new Promise<StudioBrowserCommandResult>((resolve) => {
    let settled = false
    const onReply = (event: Electron.IpcMainEvent, payload: unknown): void => {
      const parsed = parseBrowserCommandResult(payload)
      if (!parsed || parsed.callId !== callId) return
      if (event.sender.id !== senderId) {
        _warn(TAG, 'browser command reply rejected, sender is not the studio window', {
          call_id: callId,
          sender_id: event.sender.id,
          studio_id: senderId,
        })
        return
      }
      if (settled) {
        // A late reply cannot be delivered, but it means the timeout is too
        // tight for this command — otherwise indistinguishable from a wedged
        // renderer in the log.
        _warn(TAG, 'browser command reply arrived after timeout', { call_id: callId, timeout_ms: timeoutMs })
        return
      }
      settled = true
      clearTimeout(timer)
      ipcMain.off(IPC.STUDIO_BROWSER_COMMAND_RESULT, onReply)
      resolve(parsed)
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      ipcMain.off(IPC.STUDIO_BROWSER_COMMAND_RESULT, onReply)
      _warn(TAG, 'browser command timed out', { call_id: callId, kind: command.kind, timeout_ms: timeoutMs })
      resolve({ callId, ok: false, error: `Studio did not answer the ${command.kind} browser command in time` })
    }, timeoutMs)

    ipcMain.on(IPC.STUDIO_BROWSER_COMMAND_RESULT, onReply)
    _log(TAG, 'browser command dispatched', { call_id: callId, kind: command.kind, conversation_id: command.conversationId })
    studio.webContents.send(IPC.STUDIO_BROWSER_COMMAND, { callId, command })
  })
}

function fromStudio(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  return event.sender === resolveStudioWindow()?.webContents
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function parseBounds(raw: unknown): ViewBounds | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const nums = ['x', 'y', 'width', 'height'].map((k) => (typeof v[k] === 'number' && Number.isFinite(v[k]) ? Math.round(v[k] as number) : null))
  if (nums.some((n) => n === null)) return null
  const [x, y, width, height] = nums as number[]
  // A zero-area view is legal to ASK for (a collapsed panel mid-animation) but
  // is clamped so Chromium never receives a negative size.
  return { x: x!, y: y!, width: Math.max(0, width!), height: Math.max(0, height!) }
}

/**
 * Forward the guest's own navigation back to the renderer chrome.
 *
 * The URL bar and back/forward buttons used to read these straight off the
 * webview element. With the body in main, the renderer only learns what the
 * page did if main tells it.
 */
const watched = new WeakSet<WebContents>()
function watchGuestState(guest: WebContents, conversationId: string, instanceId: string): void {
  if (watched.has(guest)) return
  watched.add(guest)
  const push = (): void => {
    const win = resolveStudioWindow()
    if (!win || win.isDestroyed() || guest.isDestroyed()) return
    win.webContents.send(IPC.STUDIO_BROWSER_VIEW_STATE, {
      conversationId,
      instanceId,
      url: guest.getURL(),
      title: guest.getTitle(),
      canGoBack: guest.navigationHistory.canGoBack(),
      canGoForward: guest.navigationHistory.canGoForward(),
    })
  }
  guest.on('did-navigate', push)
  guest.on('did-navigate-in-page', push)
  guest.on('page-title-updated', push)
  guest.on('did-finish-load', push)
}
