import { useEffect } from 'react'
import { ionUrlFromOpenPath } from '@ion/shared/deeplink-url'
import { host } from '../host/host-instance'
import { navigateToDeepLinkTarget, openDeepLinkUrl } from '../deeplink-client'
import { rInfo, rWarn } from '../rendererLogger'

/**
 * Follows `ion://` navigation for this window.
 *
 * - On the desktop, a link the OS delivered is resolved by the local server,
 *   which broadcasts the target; the window moves its view there.
 * - In a browser, a link arrives as the page's own `/open/<route>?...` path.
 *   The path is rebuilt into the `ion://` URL, cleared from the address bar
 *   (a reload must not run it again), and opened through the server.
 *
 * `ready` gates the browser path until the store has its tabs, so a
 * conversation target can be selected.
 */
export function useDeepLinkNavigation(ready: boolean): void {
  useEffect(() => {
    if (!host.capabilities().includes('deeplink')) return
    return host.shell.onDeepLinkNavigate((target) => {
      rInfo('deeplink', 'navigation link received from the desktop', { route: target.route })
      navigateToDeepLinkTarget(target)
    })
  }, [])

  useEffect(() => {
    if (!ready || typeof window === 'undefined') return
    const url = ionUrlFromOpenPath(window.location.pathname, window.location.search)
    if (!url) return
    window.history.replaceState(null, '', '/')
    rInfo('deeplink', 'opening deep link from the page path', { url_length: url.length })
    openDeepLinkUrl(url).catch((err: unknown) => rWarn('deeplink', 'opening deep link from the page path failed', { error: String(err) }))
  }, [ready])
}
