/**
 * studio-browser-views — main-process `WebContentsView` guests for the Studio
 * browser surface.
 *
 * WHY THIS EXISTS: the browser surface used a `<webview>` tag, which Chromium
 * reports to CDP as a target of type `webview`. Playwright's Chromium layer
 * only turns `page`, `iframe`, `frame`, and (behind a flag) `other` targets
 * into objects — a `webview` target is attached to and then discarded, so it
 * never appears in `context.pages()` and `pageForTarget()` could never resolve
 * it. Every browser tool failed at the attach step for that reason, and no
 * change to the resolver could have fixed it.
 *
 * A `WebContentsView` is a real top-level `page` target, so Playwright attaches
 * to it normally. That is the entire reason for this module's existence.
 *
 * The trade is that a view is NOT a DOM element: it is a sibling of the
 * renderer surface, painted by the window rather than by the page. So the
 * renderer no longer owns layout for the browser body — it measures where the
 * body should be and tells main, which is what `setBounds` below consumes.
 * Stacking follows from that too: a view always paints above page content, so
 * hiding it is explicit (`setVisible(false)`) rather than a CSS side effect.
 */
import { WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { debug as _debug, log as _log, warn as _warn } from './logger'
import { getStudioBrowserWindow } from './studio-browser-window-resolver'
import { registerStudioPlaywrightWebview, unregisterStudioPlaywrightWebview } from './studio-playwright/host'
import { installGuestPolicy, previewPartitionFor } from './webview-policy'
import { installBrowserShortcuts } from './studio-browser-shortcuts'
import { installBrowserContextMenu } from './studio-browser-menu'
import { installBrowserIdentity } from './studio-browser-identity'
import { installBrowserPermissionHandlers, installGuestSecurityPrompts, refuseBrowserPromptsFor, type GuestContext } from './studio-browser-permissions'
import { BROWSER_ZOOM_LEVEL_BOUNDS } from '@ion/shared/studio-surface-persistence'
import type { StudioBrowserChromeShortcut, StudioBrowserFindRequest, StudioBrowserZoomRequest } from '@ion/shared/studio-browser-types'

const TAG = 'studio-browser-views'

/** Bounds in window CSS pixels, as measured by the renderer. */
export interface ViewBounds {
  x: number
  y: number
  width: number
  height: number
}

interface Entry {
  view: WebContentsView
  conversationId: string
  instanceId: string
  partition: string
  /** Last bounds applied, so a visibility flip can restore them. */
  bounds: ViewBounds
  visible: boolean
  /** The open find-in-page query, so a repeat or an Escape knows there is one. */
  find: { text: string } | null
}

const entries = new Map<string, Entry>()

function key(conversationId: string, instanceId: string): string {
  return `${conversationId}::${instanceId}`
}

/**
 * Off-screen parking spot for a hidden view.
 *
 * Full-size, not 10x10. A view's layout size IS its viewport, so parking a
 * guest at 10x10 gave the page a 10x10 window — and a 0x0 one once it was also
 * hidden, which made `innerWidth`/`innerHeight` zero and failed
 * `Page.captureScreenshot` outright. A background agent asking for a
 * screenshot got a protocol error rather than an image.
 *
 * Parked far off-screen at a normal desktop size, the page lays out and paints
 * exactly as it would on screen while remaining invisible to the operator.
 */
const HIDDEN_BOUNDS: ViewBounds = { x: -30000, y: -30000, width: 1280, height: 900 }

/**
 * Create (or return) the view for one browser tab.
 *
 * The partition decides session identity exactly as it did for `<webview>`:
 * `persist:studio-browser` for shared tabs, `studio-isolated-<id>` for private
 * ones, `studio-preview-<id>` for a file:// preview whose session is held
 * offline. Keeping those names identical means existing sessions, cookies, and
 * the preview network block all continue to work unchanged.
 */
/**
 * Deliver a chrome-changing shortcut to the renderer. Injected by the IPC
 * layer, which owns every Studio-bound send; a guest created before the IPC
 * layer registered simply logs the shortcut it could not deliver.
 */
let chromeSender: ((event: { conversationId: string; instanceId: string; action: StudioBrowserChromeShortcut }) => void) | null = null
export function setBrowserChromeSender(sender: typeof chromeSender): void {
  chromeSender = sender
}

export function ensureBrowserView(params: {
  conversationId: string
  instanceId: string
  partition: string
  url: string
  /** The zoom the document was left at, re-applied so a restore looks the same. */
  zoomLevel?: number
}): WebContents | null {
  const win = getStudioBrowserWindow()
  if (!win || win.isDestroyed()) {
    _warn(TAG, 'browser view requested with no studio window', { conversation_id: params.conversationId })
    return null
  }

  const existing = entries.get(key(params.conversationId, params.instanceId))
  if (existing && !existing.view.webContents.isDestroyed()) return existing.view.webContents

  // Before the view exists: the identity is on the session, and the first
  // request the guest makes must already carry it.
  installBrowserIdentity(params.partition)

  const view = new WebContentsView({
    webPreferences: {
      partition: params.partition,
      // The same hard floor the webview policy enforced on attach. A browser
      // guest renders untrusted pages, so it gets no preload, no Node, and a
      // sandbox — set here at construction because a view has no
      // will-attach-webview event to intercept.
      preload: undefined,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  const guest = view.webContents
  // Hardening AND modifier capture, shared with the <webview> path.
  installGuestPolicy(guest, params.partition)

  win.contentView.addChildView(view)
  // Parked until the renderer reports real bounds; a view added without bounds
  // would otherwise paint at 0,0 over the whole shell for one frame. Hidden
  // immediately for the same reason.
  view.setVisible(false)
  view.setBounds(HIDDEN_BOUNDS)

  const entry: Entry = {
    view,
    conversationId: params.conversationId,
    instanceId: params.instanceId,
    partition: params.partition,
    bounds: HIDDEN_BOUNDS,
    visible: false,
    find: null,
  }
  entries.set(key(params.conversationId, params.instanceId), entry)

  const context = { conversationId: params.conversationId, instanceId: params.instanceId }
  // Deny-by-default permissions, HTTP auth, and certificate prompts. Installed
  // here rather than in the guest policy because a prompt must name its
  // document, and only this module knows which guest is which.
  installBrowserPermissionHandlers(params.partition, browserGuestContext)
  installGuestSecurityPrompts(guest, { ...context, partition: params.partition })
  installBrowserContextMenu(guest, context)
  installBrowserShortcuts(guest, context, {
    findActive: () => entry.find !== null,
    findAgain: (forward) => { if (entry.find) findInBrowserView(context.conversationId, context.instanceId, { text: entry.find.text, forward, findNext: true }) },
    zoom: (request) => { zoomBrowserView(context.conversationId, context.instanceId, request) },
    sendToChrome: (action) => {
      if (chromeSender) chromeSender({ ...context, action })
      else _warn(TAG, 'browser shortcut dropped, no chrome sender', { ...context, action })
    },
  })
  if (params.zoomLevel !== undefined && params.zoomLevel !== 0) {
    // Chromium keys zoom by origin, so the level takes effect once the page's
    // origin is known; applying on every navigation keeps a restored document
    // at its remembered zoom even when its first load redirects.
    const level = clampZoom(params.zoomLevel)
    guest.once('did-navigate', () => { guest.setZoomLevel(level) })
  }

  guest.on('destroyed', () => {
    entries.delete(key(params.conversationId, params.instanceId))
    refuseBrowserPromptsFor(params.conversationId, params.instanceId)
    unregisterStudioPlaywrightWebview(params.conversationId, params.instanceId)
    _log(TAG, 'browser view destroyed', { conversation_id: params.conversationId, instance_id: params.instanceId })
  })

  // Registration is what makes the tools able to find this guest. It happens
  // here rather than in the renderer because main owns the view now.
  registerStudioPlaywrightWebview(params.conversationId, params.instanceId, guest)

  if (params.url) {
    void guest.loadURL(params.url).catch((err: unknown) => {
      _warn(TAG, 'browser view initial load failed', { conversation_id: params.conversationId, error: String(err) })
    })
  }

  _log(TAG, 'browser view created', {
    conversation_id: params.conversationId,
    instance_id: params.instanceId,
    partition: params.partition,
    web_contents_id: guest.id,
  })
  return guest
}

/**
 * Clamp a view to the content area.
 *
 * A view is NOT clipped by the page, so a rect that extends past the content
 * edge paints over whatever is beside or below it — including for a frame
 * during a resize, when the renderer's measurement lags the window.
 *
 * No coordinate conversion happens here, and none should. A child of
 * `contentView` is positioned relative to the content view, and
 * `getBoundingClientRect()` in the renderer already reports real pixels in
 * that same space. Two earlier attempts to "correct" for the title bar and for
 * the UI zoom each moved the view AWAY from its hole; the measurement was
 * right to begin with.
 */
function clampToContent(win: BrowserWindow, bounds: ViewBounds): ViewBounds {
  const content = win.getContentBounds()
  const width = Math.max(0, Math.min(bounds.width, content.width - bounds.x))
  const height = Math.max(0, Math.min(bounds.height, content.height - bounds.y))
  return { x: bounds.x, y: bounds.y, width, height }
}

/** Position one view over the area the renderer measured for it. */
export function setBrowserViewBounds(conversationId: string, instanceId: string, bounds: ViewBounds, visible: boolean): boolean {
  const entry = entries.get(key(conversationId, instanceId))
  if (!entry || entry.view.webContents.isDestroyed()) return false
  entry.bounds = bounds
  entry.visible = visible
  // A view paints above all page content, so an inactive tab must be moved
  // away AND hidden. Relying on visibility alone has been observed to leave a
  // ghost frame during window resize. Popover avoidance is applied here too,
  // so a geometry push mid-popover cannot paint the view back over it.
  applyBounds(entry)
  return true
}

/**
 * Where the on-screen popovers are, in window coordinates.
 *
 * A `WebContentsView` is painted by the window, above ALL page content, so no
 * z-index can put a DOM popover in front of one — the Surface add-tab menu and
 * every context menu rendered *behind* the browser canvas once the body moved
 * out of the DOM.
 *
 * So the view is hidden while a popover overlaps it; `applyBounds` below
 * explains why shrinking it was measured and rejected.
 */
let popoverRects: ViewBounds[] = []

export function setPopoverRects(rects: ViewBounds[]): void {
  const encoded = JSON.stringify(rects)
  if (encoded === JSON.stringify(popoverRects)) return
  popoverRects = rects
  for (const entry of entries.values()) {
    if (!entry.visible || entry.view.webContents.isDestroyed()) continue
    applyBounds(entry)
  }
  // DEBUG: a popover that moves or animates changes its region every frame.
  _debug(TAG, 'browser popover regions changed', { count: rects.length })
}

/** Does any popover overlap this rectangle? */
function popoverOverlaps(bounds: ViewBounds): boolean {
  return popoverRects.some((rect) =>
    rect.x < bounds.x + bounds.width &&
    rect.x + rect.width > bounds.x &&
    rect.y < bounds.y + bounds.height &&
    rect.y + rect.height > bounds.y)
}

/**
 * Apply an entry's remembered bounds, hiding it while a popover covers it.
 *
 * A `WebContentsView` is composited by the window above the renderer, which IS
 * the window's own web contents — so a DOM popover can never be layered over
 * one, and the view has no way to render behind it.
 *
 * Three approaches were measured against the running app before this one:
 *
 *   - Shrinking the view. A view's size is its viewport, so the page reflowed
 *     and the content jumped: a menu appeared to shove the page down.
 *   - Pinning the viewport first, then shrinking. The page kept its layout,
 *     but a smaller view still renders from its own origin, so content moved.
 *   - The `viewport` clip on `Emulation.setDeviceMetricsOverride`. Measured in
 *     the page, layout size, scroll position, and element rects were identical
 *     with and without it — it affects capture, not compositing.
 *
 * So the view is hidden for exactly as long as a popover covers it, and its
 * bounds never change: the page does not reflow, and it reappears showing
 * exactly what it showed before.
 *
 * Hiding is scoped to real overlap. A tooltip elsewhere in the window — an
 * inbox row, a toolbar button — leaves the browser untouched, which is what
 * stopped the canvas flashing on every inbox hover.
 */
function applyBounds(entry: Entry): void {
  const win = getStudioBrowserWindow()
  if (!win || win.isDestroyed()) return
  if (!entry.visible) {
    entry.view.setVisible(false)
    entry.view.setBounds(HIDDEN_BOUNDS)
    return
  }
  const bounds = clampToContent(win, entry.bounds)
  const covered = popoverOverlaps(bounds)
  entry.view.setBounds(bounds)
  entry.view.setVisible(!covered && bounds.width > 0 && bounds.height > 0)
}

/** Hide every view for a conversation that is no longer on screen. */
export function hideBrowserViewsExcept(conversationId: string | null, instanceId: string | null): void {
  for (const entry of entries.values()) {
    const keep = entry.conversationId === conversationId && entry.instanceId === instanceId
    if (keep || !entry.visible) continue
    entry.visible = false
    entry.view.setVisible(false)
    entry.view.setBounds(HIDDEN_BOUNDS)
  }
}

/** Navigate a view. Returns false when the tab is gone. */
export function navigateBrowserView(conversationId: string, instanceId: string, url: string): boolean {
  const entry = entries.get(key(conversationId, instanceId))
  if (!entry || entry.view.webContents.isDestroyed()) return false
  void entry.view.webContents.loadURL(url).catch((err: unknown) => {
    _warn(TAG, 'browser view navigation failed', { conversation_id: conversationId, error: String(err) })
  })
  return true
}

/** Destroy one browser view. */
export function destroyBrowserView(conversationId: string, instanceId: string): boolean {
  const entry = entries.get(key(conversationId, instanceId))
  if (!entry) return false
  entries.delete(key(conversationId, instanceId))
  refuseBrowserPromptsFor(conversationId, instanceId)
  const win = getStudioBrowserWindow()
  if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.view)
  if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
  unregisterStudioPlaywrightWebview(conversationId, instanceId)
  _log(TAG, 'browser view closed', { conversation_id: conversationId, instance_id: instanceId })
  return true
}

/** Destroy every view. Used when the Studio window closes. */
export function destroyAllBrowserViews(): void {
  for (const [id, entry] of [...entries.entries()]) {
    entries.delete(id)
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
    unregisterStudioPlaywrightWebview(entry.conversationId, entry.instanceId)
  }
  _log(TAG, 'all browser views released', {})
}

/**
 * Is this guest currently displayed?
 *
 * Emulation needs it: Chromium's `mobile: true` flag makes a PARKED view lay
 * out at a default 980-wide viewport scaled by the device pixel ratio, instead
 * of the exact size requested. Verified against the live protocol — 390x844
 * with mobile:true came back as 1560x3376, while mobile:false gave exactly
 * 390x844 with the page's mobile CSS still engaged.
 */
export function isBrowserViewVisible(conversationId: string, instanceId: string): boolean {
  return entries.get(key(conversationId, instanceId))?.visible === true
}

/** The live guest for a tab, when one exists. */
export function browserViewContents(conversationId: string, instanceId: string): WebContents | null {
  const entry = entries.get(key(conversationId, instanceId))
  if (!entry || entry.view.webContents.isDestroyed()) return null
  return entry.view.webContents
}

/** Re-apply bounds after the window itself changed size. */
export function reapplyBrowserViewBounds(_win: BrowserWindow): void {
  for (const entry of entries.values()) {
    if (!entry.visible || entry.view.webContents.isDestroyed()) continue
    applyBounds(entry)
  }
}

/** Which document a WebContents is, or null when it is not a browser guest. */
export function browserGuestContext(contents: WebContents): GuestContext | null {
  for (const entry of entries.values()) {
    if (entry.view.webContents === contents) {
      return { conversationId: entry.conversationId, instanceId: entry.instanceId, partition: entry.partition }
    }
  }
  return null
}

/** Is this WebContents one of the Studio browser guests? */
export function isBrowserGuest(contents: WebContents): boolean {
  return browserGuestContext(contents) !== null
}

function clampZoom(level: number): number {
  return Math.min(BROWSER_ZOOM_LEVEL_BOUNDS.max, Math.max(BROWSER_ZOOM_LEVEL_BOUNDS.min, level))
}

/** One zoom step. Chromium presets are roughly 10% apart, which is half a level. */
const ZOOM_STEP = 0.5

/**
 * Apply a zoom request and return the level now in effect, or null when the
 * document is gone. Chromium keys zoom by origin within a session, exactly as
 * a browser does: two documents on one origin zoom together.
 */
export function zoomBrowserView(conversationId: string, instanceId: string, request: StudioBrowserZoomRequest): number | null {
  const entry = entries.get(key(conversationId, instanceId))
  if (!entry || entry.view.webContents.isDestroyed()) return null
  const guest = entry.view.webContents
  const current = guest.getZoomLevel()
  const next = request === 'in' ? current + ZOOM_STEP
    : request === 'out' ? current - ZOOM_STEP
    : request === 'reset' ? 0
    : request.level
  const level = clampZoom(Number(next.toFixed(2)))
  guest.setZoomLevel(level)
  _log(TAG, 'browser zoom applied', { conversation_id: conversationId, instance_id: instanceId, zoom_level: level })
  return level
}

/**
 * Find in page. Chromium answers over `found-in-page`, which the IPC layer
 * forwards; this only issues the request and remembers that one is open.
 */
export function findInBrowserView(conversationId: string, instanceId: string, request: StudioBrowserFindRequest): boolean {
  const entry = entries.get(key(conversationId, instanceId))
  if (!entry || entry.view.webContents.isDestroyed()) return false
  const guest = entry.view.webContents
  if ('stop' in request) {
    if (entry.find) {
      guest.stopFindInPage('clearSelection')
      // The find bar had the keyboard; the page gets it back.
      guest.focus()
    }
    entry.find = null
    _debug(TAG, 'browser find stopped', { conversation_id: conversationId, instance_id: instanceId })
    return true
  }
  entry.find = { text: request.text }
  guest.findInPage(request.text, { forward: request.forward, findNext: request.findNext })
  _debug(TAG, 'browser find requested', { conversation_id: conversationId, instance_id: instanceId, text_length: request.text.length, forward: request.forward })
  return true
}

/** Preview partitions keep their offline block; exported for the IPC layer. */
export { previewPartitionFor }
