import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { IPC } from '@ion/shared/types'
import { log as _log, warn as _warn } from '../logger'
import { setStudioBrowserTabRequestHandler } from '../studio-browser-tab-request'
import {
  browserViewContents,
  destroyBrowserView,
  ensureBrowserView,
  findInBrowserView,
  navigateBrowserView,
  setBrowserChromeSender,
  setBrowserViewBounds,
  setPopoverRects,
  zoomBrowserView,
  type ViewBounds,
} from '../studio-browser-views'
import { setBrowserCommandSender } from '../studio-playwright/renderer-bridge'
import { answerBrowserPrompt, pendingBrowserPrompts, setBrowserPromptSender } from '../studio-browser-permissions'
import {
  parseBrowserCommandResult,
  parseBrowserFindRequest,
  parseBrowserPromptAnswer,
  parseBrowserZoomRequest,
  type StudioBrowserCommand,
  type StudioBrowserCommandResult,
  type StudioBrowserFindResult,
  type StudioBrowserPrompt,
  type StudioBrowserShortcutEvent,
  type StudioBrowserViewState,
} from '@ion/shared/studio-browser-types'

const TAG = 'studio-browser-ipc'

let commandSeq = 0
let resolveStudioWindow: () => BrowserWindow | null = () => null

/**
 * Studio browser IPC: view control inbound, browser commands outbound.
 *
 * Main creates every guest itself, so a renderer never hands main a
 * WebContents. What it sends are ids, geometry, and verbs, and every handler
 * first checks that the sender is the Studio window. Any other window with the
 * preload bridge is refused, so it cannot create, move, or drive a guest.
 *
 * Commands run the other way. Main owns the Playwright runtime but not Surface
 * descriptors, so creating, closing, or re-sizing the agent's tab is a request
 * the renderer applies and acknowledges. The correlation lives here because
 * main is the only party that knows whether a Studio window exists, so a
 * missing or wedged renderer produces a resolved refusal instead of a caller
 * hanging forever.
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
    (event, conversationId: unknown, instanceId: unknown, url: unknown, partition: unknown, zoomLevel: unknown) => {
      if (!fromStudio(event) || !isId(conversationId) || !isId(instanceId) || typeof partition !== 'string' || !partition) {
        _log(TAG, 'browser view ensure rejected', { sender_id: event.sender.id })
        return false
      }
      const guest = ensureBrowserView({
        conversationId,
        instanceId,
        partition,
        url: typeof url === 'string' ? url : '',
        ...(typeof zoomLevel === 'number' && Number.isFinite(zoomLevel) ? { zoomLevel } : {}),
      })
      if (!guest) return false
      watchGuestState(guest, conversationId, instanceId)
      // A prompt raised while no chrome was mounted for this document (the
      // Surface column closed, a background conversation) is still waiting;
      // the chrome that just mounted is the one that can show it.
      for (const prompt of pendingBrowserPrompts(conversationId, instanceId)) sendBrowserPrompt(prompt)
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

  // Find in page. The request goes to the guest; Chromium's answer comes
  // back through `found-in-page`, which watchGuestState forwards.
  ipcMain.handle(
    IPC.STUDIO_BROWSER_FIND,
    (event, conversationId: unknown, instanceId: unknown, request: unknown) => {
      if (!fromStudio(event) || !isId(conversationId) || !isId(instanceId)) return false
      const parsed = parseBrowserFindRequest(request)
      if (!parsed) {
        _warn(TAG, 'browser find rejected, malformed request', { conversation_id: conversationId, instance_id: instanceId })
        return false
      }
      return findInBrowserView(conversationId, instanceId, parsed)
    },
  )

  ipcMain.handle(
    IPC.STUDIO_BROWSER_SET_ZOOM,
    (event, conversationId: unknown, instanceId: unknown, request: unknown) => {
      if (!fromStudio(event) || !isId(conversationId) || !isId(instanceId)) return null
      const parsed = parseBrowserZoomRequest(request)
      if (!parsed) {
        _warn(TAG, 'browser zoom rejected, malformed request', { conversation_id: conversationId, instance_id: instanceId })
        return null
      }
      const level = zoomBrowserView(conversationId, instanceId, parsed)
      const guest = browserViewContents(conversationId, instanceId)
      if (guest) pushGuestState(guest, conversationId, instanceId)
      return level
    },
  )

  ipcMain.on(IPC.STUDIO_BROWSER_PROMPT_ANSWER, (event, answer: unknown) => {
    if (!fromStudio(event)) return
    const parsed = parseBrowserPromptAnswer(answer)
    if (!parsed) {
      _warn(TAG, 'browser prompt answer rejected, malformed', { sender_id: event.sender.id })
      return
    }
    answerBrowserPrompt(parsed)
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

  // A shortcut pressed inside a guest that only the chrome can act on. Sent
  // from here, not from the shortcut module, so every Studio-bound send stays
  // in this file.
  setBrowserPromptSender(sendBrowserPrompt)

  setBrowserChromeSender((shortcut: StudioBrowserShortcutEvent) => {
    const studio = resolveStudioWindow()
    if (!studio || studio.isDestroyed()) {
      _warn(TAG, 'browser shortcut dropped, no studio window', { conversation_id: shortcut.conversationId, action: shortcut.action })
      return
    }
    // The guest holds keyboard focus; the chrome cannot take it from inside
    // the renderer, so the window's own contents are focused here first.
    if (shortcut.action !== 'close-find') studio.webContents.focus()
    studio.webContents.send(IPC.STUDIO_BROWSER_SHORTCUT, shortcut)
  })
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
    _log(TAG, 'browser tab request dropped, no studio window', { url_host: hostOf(url) })
    return
  }
  studio.webContents.send(IPC.STUDIO_BROWSER_OPEN_URL, url)
  _log(TAG, 'browser tab requested for clicked link', { url_host: hostOf(url) })
}

/** Host only: a full URL in a log line can carry tokens in its query. */
function hostOf(raw: string): string {
  try {
    return new URL(raw).host
  } catch {
    return ''
  }
}

/** Clear the senders when the Studio window goes away. */
export function clearStudioBrowserCommandSender(): void {
  setBrowserCommandSender(null)
  setBrowserChromeSender(null)
  setBrowserPromptSender(null)
}

function sendBrowserPrompt(prompt: StudioBrowserPrompt): void {
  const studio = resolveStudioWindow()
  if (!studio || studio.isDestroyed()) {
    _warn(TAG, 'browser prompt not delivered, no studio window', { prompt_id: prompt.promptId, kind: prompt.kind })
    return
  }
  studio.webContents.send(IPC.STUDIO_BROWSER_PROMPT, prompt)
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
/** Per-guest chrome facts that no getter exposes: the favicon and load state. */
const chromeFacts = new WeakMap<WebContents, { faviconUrl: string; loading: boolean }>()

function pushGuestState(guest: WebContents, conversationId: string, instanceId: string): void {
  const win = resolveStudioWindow()
  if (!win || win.isDestroyed() || guest.isDestroyed()) return
  const facts = chromeFacts.get(guest) ?? { faviconUrl: '', loading: false }
  const state: StudioBrowserViewState = {
    conversationId,
    instanceId,
    url: guest.getURL(),
    title: guest.getTitle(),
    canGoBack: guest.navigationHistory.canGoBack(),
    canGoForward: guest.navigationHistory.canGoForward(),
    faviconUrl: facts.faviconUrl,
    loading: facts.loading,
    zoomLevel: guest.getZoomLevel(),
  }
  win.webContents.send(IPC.STUDIO_BROWSER_VIEW_STATE, state)
}

function watchGuestState(guest: WebContents, conversationId: string, instanceId: string): void {
  if (watched.has(guest)) return
  watched.add(guest)
  const facts = { faviconUrl: '', loading: false }
  chromeFacts.set(guest, facts)
  const push = (): void => pushGuestState(guest, conversationId, instanceId)
  guest.on('did-navigate', () => {
    // A new document has no favicon until it reports one; carrying the old
    // one over would label a page with the previous site's icon.
    facts.faviconUrl = ''
    push()
  })
  guest.on('did-navigate-in-page', push)
  guest.on('page-title-updated', push)
  guest.on('did-finish-load', push)
  guest.on('did-start-loading', () => { facts.loading = true; push() })
  guest.on('did-stop-loading', () => { facts.loading = false; push() })
  guest.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    facts.loading = false
    // -3 is ABORTED: the operator navigated again before the load finished,
    // which is not a failure of anything.
    if (isMainFrame && code !== -3) {
      _warn(TAG, 'browser page load failed', { conversation_id: conversationId, instance_id: instanceId, code, description, url_host: hostOf(url) })
    }
    push()
  })
  guest.on('page-favicon-updated', (_event, favicons) => {
    facts.faviconUrl = favicons.find((candidate) => candidate.startsWith('https:') || candidate.startsWith('http:') || candidate.startsWith('data:')) ?? ''
    push()
  })
  guest.on('found-in-page', (_event, result) => {
    const win = resolveStudioWindow()
    if (!win || win.isDestroyed()) return
    const payload: StudioBrowserFindResult = {
      conversationId,
      instanceId,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
    }
    win.webContents.send(IPC.STUDIO_BROWSER_FIND_RESULT, payload)
  })
}
