/**
 * Opens the sign-in page a Studio client is asked to show.
 *
 * The server cannot open a browser, so an interactive auth flow (Google's
 * redirect, an MCP server's authorization page, the engine-owned Entra
 * login) broadcasts its URL on `ion:open-auth-url` and whichever client is
 * attached opens it. This is the client half of `server/src/oauth/
 * url-opener.ts`.
 *
 * The page opens through the host, never `window.open` directly: the
 * desktop window refuses every pop-up, so the host hands the URL to the
 * system browser instead, and a browser client opens a new tab. A browser
 * may still block that tab, because the frame arrives outside a user
 * gesture. A page that did not open is reported rather than swallowed:
 * without it the flow cannot complete, and a silent failure would look
 * identical to a server that never answered.
 */
import { host } from './host-instance'
import { rInfo, rWarn } from '../rendererLogger'

let installed = false

export function initAuthUrlOpen(): void {
  if (installed) return
  installed = true
  host.shell.onOpenAuthUrl((payload: { url?: unknown }) => {
    const url = typeof payload?.url === 'string' ? payload.url : ''
    if (!url) {
      rWarn('auth.url', 'open-auth-url carried no url')
      return
    }
    void host.openExternal(url).then((opened) => {
      if (opened) {
        rInfo('auth.url', 'opened sign-in page', { url_host: safeHost(url) })
        return
      }
      rWarn('auth.url', 'sign-in page did not open; the flow cannot complete', {
        url_host: safeHost(url),
      })
    }).catch((err: unknown) => {
      rWarn('auth.url', 'opening the sign-in page failed; the flow cannot complete', {
        url_host: safeHost(url),
        error: String(err),
      })
    })
  })
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    // Diagnostic only -- never throw out of a log line for a bad URL.
    return '(unparseable)'
  }
}
