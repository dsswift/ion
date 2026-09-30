/**
 * studio-browser-identity — what a browser guest tells a site it is.
 *
 * Electron's default user agent is Chrome's with the app's own name tag
 * appended: `... Chrome/134.0.0.0 Safari/537.36 Ion/1.82.0 Electron/35.7.5`.
 * Google's and Microsoft's sign-in pages refuse "embedded browser frameworks",
 * and that tag is how they recognise one. The engine underneath is real
 * Chromium on the same version line as Chrome; the only thing that says "not
 * Chrome" is the tag.
 *
 * So every browser partition sends the plain Chrome identity: the fallback
 * with the app and Electron tokens removed. Nothing is invented. The Chrome
 * version, platform, and layout tokens are whatever this build's Chromium
 * reports, which is what a matching Chrome would say.
 *
 * Set on the session, not the guest, so subresources, service workers, and a
 * document created before the first navigation all agree.
 */
import { app, session } from 'electron'
import { log as _log } from './logger'

const TAG = 'studio-browser-identity'

/** The app and Electron tokens Electron appends to Chrome's own user agent. */
const EMBEDDED_TOKENS = /\s+[A-Za-z][\w.-]*\/[\w.-]+(?=\s|$)/g

/**
 * Chrome's user agent from Electron's fallback.
 *
 * Pure: it drops every trailing `Name/version` token after the last token
 * Chrome itself ends with (`Safari/537.36`), and leaves everything before it
 * untouched. Anything without that anchor is returned as-is rather than
 * guessed at.
 */
export function chromeUserAgent(fallback: string): string {
  const anchor = fallback.indexOf('Safari/')
  if (anchor === -1) return fallback
  const end = fallback.indexOf(' ', anchor)
  if (end === -1) return fallback
  const chrome = fallback.slice(0, end)
  const trailing = fallback.slice(end)
  // Only strip when the trailing part is nothing but Name/version tokens; a
  // fallback someone has already customised is left alone.
  return trailing.replace(EMBEDDED_TOKENS, '').trim() === '' ? chrome : fallback
}

const applied = new Set<string>()

/** Give one browser partition the plain Chrome identity. Idempotent. */
export function installBrowserIdentity(partition: string): void {
  if (applied.has(partition)) return
  applied.add(partition)
  const fallback = app.userAgentFallback
  const userAgent = chromeUserAgent(fallback)
  session.fromPartition(partition).setUserAgent(userAgent)
  _log(TAG, 'browser identity set', { partition, changed: userAgent !== fallback, user_agent: userAgent })
}
