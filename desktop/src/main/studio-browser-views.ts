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
import { log as _log, warn as _warn } from './logger'
import { state } from './state'
import { registerStudioPlaywrightWebview, unregisterStudioPlaywrightWebview } from './studio-playwright/host'
import { installGuestPolicy, previewPartitionFor } from './webview-policy'

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
export function ensureBrowserView(params: {
  conversationId: string
  instanceId: string
  partition: string
  url: string
}): WebContents | null {
  const win = state.studioWindow
  if (!win || win.isDestroyed()) {
    _warn(TAG, 'browser view requested with no studio window', { conversation_id: params.conversationId })
    return null
  }

  const existing = entries.get(key(params.conversationId, params.instanceId))
  if (existing && !existing.view.webContents.isDestroyed()) return existing.view.webContents

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

  entries.set(key(params.conversationId, params.instanceId), {
    view,
    conversationId: params.conversationId,
    instanceId: params.instanceId,
    partition: params.partition,
    bounds: HIDDEN_BOUNDS,
    visible: false,
  })

  guest.on('destroyed', () => {
    entries.delete(key(params.conversationId, params.instanceId))
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
 * Hiding the view fixes the layering and blanks the whole page behind a small
 * menu, which is worse. Instead the view is shrunk out from under the popover:
 * the page keeps rendering everywhere the popover is not, and only the covered
 * band is given up.
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
  _log(TAG, 'browser popover regions changed', { count: rects.length })
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
  const win = state.studioWindow
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

/** Hide every view for a conversation that is no longer on screen. *//** Hide every view for a conversation that is no longer on screen. */
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
  const win = state.studioWindow
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

/** Preview partitions keep their offline block; exported for the IPC layer. */
export { previewPartitionFor }
