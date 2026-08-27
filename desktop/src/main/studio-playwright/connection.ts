/**
 * The shared Playwright connection to Electron's own Chromium.
 *
 * Playwright cannot launch this browser — it is already running and it is the
 * app. `connectOverCDP` against Chromium's loopback debugging endpoint is the
 * supported way to drive it, so CDP is the compatibility boundary here rather
 * than a bundled-browser version match.
 *
 * ONE connection is shared by every conversation. It is established on the
 * first validated guest registration rather than on the first tool call, so
 * Playwright's retained console/network buffers already cover the operator's
 * own manual browsing by the time an agent asks a question about the page.
 *
 * The connection is never closed. `browser.close()` on a CDP connection asks
 * the REAL browser to exit, which for Electron means killing the app; the
 * lifecycle here is disconnect-and-rebind only. Disabling the browser tools
 * stops advertising and executing them, and leaves this connection dormant.
 */
import type { Browser, Page } from 'playwright-core'
import { log as _log, warn as _warn } from '../logger'
import { readDevToolsEndpoint } from './host'

const TAG = 'studio-playwright'

let connecting: Promise<Browser> | null = null
let browser: Browser | null = null

/** Reset for focused tests. Never called in shipped paths. */
export function resetConnectionForTests(): void {
  connecting = null
  browser = null
}

async function connect(): Promise<Browser> {
  const endpoint = await readDevToolsEndpoint()
  // Imported lazily so requiring this module (and therefore the tool
  // declarations) never pays for Playwright until a browser is actually in use.
  const { chromium } = await import('playwright-core')
  const connected = await chromium.connectOverCDP(endpoint)
  connected.on('disconnected', () => {
    if (browser === connected) {
      browser = null
      connecting = null
    }
    // Expected on app shutdown and on a DevTools endpoint restart. Recovery is
    // implicit: the next call reconnects and rebinds pages by target id.
    _log(TAG, 'browser connection dropped', { reason: 'cdp disconnected' })
  })
  _log(TAG, 'browser connection established', { contexts: connected.contexts().length })
  return connected
}

/** The shared connection, established on first use and reused thereafter. */
export async function sharedBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser
  if (!connecting) {
    connecting = connect()
      .then((connected) => {
        browser = connected
        return connected
      })
      .catch((err: unknown) => {
        connecting = null
        _warn(TAG, 'browser connection failed', { error: String(err) })
        throw err
      })
  }
  return connecting
}

/**
 * Find the Playwright `Page` for one Electron guest.
 *
 * The join is the CDP target id: Electron reports it for a `WebContents`, and
 * Playwright exposes it per page through a CDP session. Matching on that id is
 * what makes a tool call land on the EXACT visible tab a conversation owns,
 * rather than on whichever page happens to be first or focused.
 */
export async function pageForTarget(cdpTargetId: string): Promise<Page | null> {
  const connected = await sharedBrowser()
  for (const context of connected.contexts()) {
    for (const page of context.pages()) {
      if (page.isClosed()) continue
      const id = await targetIdOf(page).catch(() => null) // silent-ok: a page that closed mid-scan simply is not the match
      if (id === cdpTargetId) return page
    }
  }
  _warn(TAG, 'no playwright page matched the browser target', { cdp_target_id: cdpTargetId })
  return null
}

const targetIds = new WeakMap<Page, string>()

async function targetIdOf(page: Page): Promise<string | null> {
  const cached = targetIds.get(page)
  if (cached) return cached
  const context = page.context()
  const session = await context.newCDPSession(page)
  try {
    const info = await session.send('Target.getTargetInfo') as { targetInfo?: { targetId?: unknown } }
    const id = info.targetInfo?.targetId
    if (typeof id !== 'string' || !id) return null
    targetIds.set(page, id)
    return id
  } finally {
    await session.detach().catch(() => { /* silent-ok: session dies with the page */ })
  }
}
