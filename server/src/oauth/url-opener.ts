/**
 * "Open this URL for the person driving this flow."
 *
 * Every interactive auth flow — Google's redirect, an MCP server's
 * authorization page, the engine-owned Entra login — reaches a step a
 * headless process cannot perform: showing a page to a human. The
 * implementations used `shell.openExternal` directly, which is what pinned
 * them to `desktop/src/main/` and left a browser Studio client refusing the
 * whole domain.
 *
 * The URL is not the same thing as the browser that opens it. This seam
 * separates them: the flow says WHICH url, the host says WHERE it opens.
 * Electron registers `shell.openExternal`; the server registers a broadcast
 * on `ion:open-auth-url`, which every attached Studio client opens in a new
 * tab. Every action that starts such a flow also returns the URL as
 * `authorizationUrl`, so the requester can open it wherever it runs.
 *
 * A host that registers nothing is a defect, not a silent no-op: the flow
 * would otherwise sit waiting for a callback nobody could ever trigger, so
 * the default throws with a message the caller surfaces.
 */
import { IPC } from '@ion/shared/types'
import { broadcast } from '../broadcast'
import { log, warn } from '../logger'
import type { Connection } from '../protocol/connection'

const TAG = 'oauth.url-opener'

export type UrlOpener = (url: string) => Promise<void>

let opener: UrlOpener | null = null

/** Register the host's way of showing a URL to the person. Called once at boot. */
export function setAuthUrlOpener(fn: UrlOpener): void {
  opener = fn
  log(TAG, 'auth url opener registered')
}

/**
 * The server's own opener: broadcast the URL so an attached client opens it.
 *
 * Registered by `main.ts`. Fire-and-forget by nature — the wire carries no
 * "the tab opened" acknowledgement, and the flow's real completion signal is
 * its callback or its poll, not this.
 */
export function broadcastAuthUrlOpener(url: string): Promise<void> {
  log(TAG, 'broadcasting auth url to attached clients', { url_host: safeHost(url) })
  broadcast(IPC.OPEN_AUTH_URL, { url })
  return Promise.resolve()
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    // A malformed URL is the caller's problem to surface; logging the host is
    // only ever diagnostic, so fall back rather than throwing from a log line.
    return '(unparseable)'
  }
}

/** The connection that asked for the flow, when the caller knows it. */
export type AuthUrlRequester = Pick<Connection, 'id' | 'view' | 'transport'>

/**
 * Show `url` to the person.
 *
 * A thin (phone) requester opens the page itself from the URL its action
 * result carries, so nothing is broadcast: pushing the page to every mirror
 * client would open it on a desktop nobody is sitting at. A mirror requester,
 * or an unknown one, gets the host's opener. Throws when that opener is
 * needed and no host registered one.
 */
export async function openAuthUrl(url: string, requester?: AuthUrlRequester): Promise<void> {
  if (requester && requester.view !== 'mirror') {
    log(TAG, 'auth url returned to the requesting client, not broadcast', { url_host: safeHost(url), connection_id: requester.id, view: requester.view, transport: requester.transport })
    return
  }
  if (!opener) {
    warn(TAG, 'no auth url opener registered; the flow cannot complete', { url_host: safeHost(url), connection_id: requester?.id ?? '' })
    throw new Error('No client is attached to open the sign-in page')
  }
  log(TAG, 'opening auth url through the host opener', { url_host: safeHost(url), connection_id: requester?.id ?? '', transport: requester?.transport ?? '' })
  await opener(url)
}
