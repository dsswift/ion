/**
 * webview-policy — main-process hardening for the Studio browser surface.
 *
 * The Studio window is the ONLY window with webviewTag enabled, and every
 * attach is forced through this policy:
 *
 *   will-attach-webview: strip preload, force nodeIntegration:false /
 *   contextIsolation:true / sandbox:true, allowlist src schemes
 *   (https/http/file/about:blank) — anything else is prevented + logged.
 *
 *   did-attach-webview: deny window.open entirely and gate will-navigate
 *   with the same scheme allowlist (D6 — navigation, not just popups).
 *
 * D6 preview mode: file:// preview tabs ride ephemeral (non-persist:)
 * partitions named studio-preview-<id>; each such partition's session gets
 * a webRequest filter permitting file:/data:/blob: only — offline by
 * default. An explicit per-tab confirm lifts the block (allowPreviewNetwork)
 * for that partition only. URL browsing rides the persistent
 * persist:studio-browser partition with full network.
 */
import { app, session, type Session, type WebContents } from 'electron'
import { log as _log, warn as _warn } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('webview-policy', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('webview-policy', msg, fields)
}

const ALLOWED_SCHEMES = new Set(['https:', 'http:', 'file:', 'about:'])
const PREVIEW_PARTITION_PREFIX = 'studio-preview-'
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

/** Wire the attach-time policy onto a window's webContents. */
export function installWebviewPolicy(contents: WebContents): void {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = String(params.src ?? '')
    if (!schemeAllowed(src)) {
      warn('webview attach refused: scheme not allowed', { src: src.slice(0, 120) })
      event.preventDefault()
      return
    }
    // Hard floor regardless of what the renderer asked for.
    delete (webPreferences as { preload?: string }).preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true

    // Preview partitions get the offline filter the moment they exist.
    const partition = String(params.partition ?? '')
    if (partition.startsWith(PREVIEW_PARTITION_PREFIX)) {
      installPreviewNetworkBlock(partition, session.fromPartition(partition))
    }
    log('webview attached', { src: src.slice(0, 120), partition })
  })

  contents.on('did-attach-webview', (_event, webContents) => {
    // No popups, ever — a surface browser tab is a single document.
    webContents.setWindowOpenHandler(({ url }) => {
      warn('webview window.open denied', { url: url.slice(0, 120) })
      return { action: 'deny' }
    })
    // D6: navigation itself is scheme-gated, not just window.open.
    webContents.on('will-navigate', (event, url) => {
      if (!schemeAllowed(url)) {
        warn('webview navigation refused: scheme not allowed', { url: url.slice(0, 120) })
        event.preventDefault()
      }
    })
  })
}

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
