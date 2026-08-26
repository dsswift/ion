/**
 * browser-guest policy — main-process hardening for Studio browser guests.
 *
 * The Studio browser used to render through `<webview>` tags, and this file
 * was the attach-time gate for them. It is not any more: a `<webview>` is
 * reported to CDP as a target of type `webview`, which Playwright never turns
 * into a page, so the browser tools could not attach to one. The body is now a
 * main-process `WebContentsView` (see `studio-browser-views.ts`), and
 * `webviewTag` is disabled on the Studio window entirely.
 *
 * What survives is the hardening a guest needs once it exists, which the view
 * path calls directly at construction:
 *
 *   - popups denied, with a ⌘-click reopened as a Surface tab and ⌥⌘-click
 *     escaping to the operator's own browser
 *   - navigation scheme-gated, not just window.open
 *   - preview partitions held offline until an explicit per-tab confirm
 */
import { app, session, shell, type Session, type WebContents } from 'electron'
import { log as _log, warn as _warn } from './logger'
import { requestStudioBrowserTab } from './ipc/studio-browser'
import { PREVIEW_PARTITION_PREFIX, previewPartitionFor } from '../shared/studio-browser-partitions'
import { consumeAltHeld, watchGuestModifiers } from './guest-modifiers'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('webview-policy', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('webview-policy', msg, fields)
}

const ALLOWED_SCHEMES = new Set(['https:', 'http:', 'file:', 'about:'])

/** Only http(s) is meaningful in a new browser tab; file:// stays in place. */
function isHttpUrl(rawUrl: string): boolean {
  try {
    const protocol = new URL(rawUrl).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}
/** Preview partitions whose network block was explicitly lifted. */
const unlockedPreviewPartitions = new Set<string>()

function schemeAllowed(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol === 'about:') return rawUrl === 'about:blank'
    return ALLOWED_SCHEMES.has(url.protocol)
  } catch {
    return rawUrl === '' // an empty src attaches blank; navigation gates later
  }
}

/** Offline-by-default filter for a preview partition's session. */
function installPreviewNetworkBlock(partition: string, ses: Session): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (unlockedPreviewPartitions.has(partition)) {
      callback({})
      return
    }
    try {
      const proto = new URL(details.url).protocol
      if (proto === 'file:' || proto === 'data:' || proto === 'blob:' || proto === 'devtools:') {
        callback({})
        return
      }
    } catch {
      // Unparseable URL in a restricted partition: block.
    }
    log('preview network request blocked', { partition, url: details.url.slice(0, 120) })
    callback({ cancel: true })
  })
}

/**
 * Lift the network block for one preview partition (per-tab explicit
 * confirm — the shield click in BrowserChrome).
 */
export function allowPreviewNetwork(partition: string): boolean {
  if (!partition.startsWith(PREVIEW_PARTITION_PREFIX)) {
    warn('preview unlock rejected: not a preview partition', { partition })
    return false
  }
  unlockedPreviewPartitions.add(partition)
  log('preview network unlocked', { partition })
  return true
}

/** The partition name a preview tab uses, for callers outside this module. */
export { previewPartitionFor }

/**
 * Install the offline block for a partition when it is a preview partition.
 *
 * A `WebContentsView` has no `will-attach-webview` event to intercept, so the
 * caller that creates the view installs the block itself. Same filter, same
 * unlock set — routed through here so there is one implementation of what
 * "preview is offline" means.
 */
export function installPreviewBlockIfPreview(partition: string): void {
  if (!partition.startsWith(PREVIEW_PARTITION_PREFIX)) return
  installPreviewNetworkBlock(partition, session.fromPartition(partition))
}

/**
 * Harden one guest's webContents.
 *
 * Shared by the `<webview>` attach path and by `WebContentsView` browser tabs.
 * A view sets its sandbox/isolation flags at construction (it has no attach
 * event), but everything AFTER construction — popup policy, scheme-gated
 * navigation, modifier capture for the ⌥ escape — is identical and lives here
 * so the two paths cannot drift apart.
 */
export function installGuestPolicy(guest: WebContents, partition: string): void {
  installPreviewBlockIfPreview(partition)
  // Chromium never reports the Option key to setWindowOpenHandler, so the ⌥
  // escape depends on this capture being installed before the first click.
  watchGuestModifiers(guest)
  guest.setWindowOpenHandler(({ url, disposition }) => {
    // A cmd-clicked link inside a page arrives here as a new-tab disposition.
    // The popup itself still gets denied — a surface browser tab is a single
    // document — but the operator's intent was "open this somewhere", so it is
    // reopened rather than dropped. window.open() and every other disposition
    // stay denied outright.
    const userAskedForATab = disposition === 'foreground-tab' || disposition === 'background-tab'
    if (userAskedForATab && schemeAllowed(url) && isHttpUrl(url)) {
      // Blink maps ⌘-click and ⌥⌘-click to the SAME disposition, so the Option
      // key is invisible here and has to come from the guest's raw input
      // events. With it, ⌥ is the escape hatch to the operator's own browser;
      // without it (an expired or missing capture) this stays a Surface tab,
      // which is the recoverable direction.
      if (consumeAltHeld(guest)) {
        log('browser link routed to the default browser', { disposition, url: url.slice(0, 120) })
        void shell.openExternal(url).catch((err: unknown) => {
          warn('browser default-browser open failed', { url: url.slice(0, 120), error: String(err) })
        })
        return { action: 'deny' }
      }
      log('browser link routed to a surface browser tab', { disposition, url: url.slice(0, 120) })
      requestStudioBrowserTab(url)
      return { action: 'deny' }
    }
    warn('browser window.open denied', { url: url.slice(0, 120), disposition })
    return { action: 'deny' }
  })
  // D6: navigation itself is scheme-gated, not just window.open.
  guest.on('will-navigate', (event, url) => {
    if (!schemeAllowed(url)) {
      warn('browser navigation refused: scheme not allowed', { url: url.slice(0, 120) })
      event.preventDefault()
    }
  })
}

/** Wire the attach-time policy onto a window's webContents. */
/** Test hook: reset unlocked partitions. */
export function _resetPreviewUnlocks(): void {
  unlockedPreviewPartitions.clear()
}

/** Pure predicate export for tests. */
export function _schemeAllowed(url: string): boolean {
  return schemeAllowed(url)
}

// app import is used indirectly by session.fromPartition consumers; keep the
// module main-process-only by construction.
void app
