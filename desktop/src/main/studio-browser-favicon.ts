/**
 * Studio browser favicons, resolved to `data:` URLs in main.
 *
 * The Studio window's CSP allows only `img-src 'self' data: blob:`, so the
 * chrome cannot load the `https:` icon URL a guest reports. Main fetches it
 * through the guest's own session instead: the request carries that
 * partition's cookies and certificate decisions, so an icon behind the same
 * sign-in as the page loads exactly as the page's own would.
 */

import type { Session } from 'electron'
import { debug } from './logger'

const TAG = 'studio-browser-favicon'
const FETCH_TIMEOUT_MS = 5000
/** Large enough for any real favicon, small enough to persist on the descriptor. */
export const MAX_FAVICON_BYTES = 64 * 1024

/**
 * Pick the icon to show from what the guest reported: the first candidate on
 * a scheme main can fetch or pass through. Empty when none qualify.
 */
export function pickFaviconCandidate(candidates: readonly string[]): string {
  return candidates.find((candidate) => candidate.startsWith('https:') || candidate.startsWith('http:') || candidate.startsWith('data:')) ?? ''
}

/** A `data:` URL for `iconUrl` fetched through `session`, or `''` when it cannot be shown. */
export async function resolveFaviconDataUrl(session: Pick<Session, 'fetch'>, iconUrl: string): Promise<string> {
  if (!iconUrl) return ''
  if (iconUrl.startsWith('data:')) return iconUrl.length <= MAX_FAVICON_BYTES * 2 ? iconUrl : ''
  const host = hostOf(iconUrl)
  try {
    const res = await session.fetch(iconUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      debug(TAG, 'favicon fetch non-ok', { url_host: host, status: res.status })
      return ''
    }
    const mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
    if (!mime.startsWith('image/')) {
      debug(TAG, 'favicon not an image', { url_host: host, content_type: mime })
      return ''
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_FAVICON_BYTES) {
      debug(TAG, 'favicon size out of bounds', { url_host: host, size: bytes.length })
      return ''
    }
    debug(TAG, 'favicon resolved', { url_host: host, size: bytes.length, content_type: mime })
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch (err) {
    debug(TAG, 'favicon fetch failed', { url_host: host, error: String(err) })
    return ''
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '' // silent-ok: a malformed icon URL is logged with an empty host
  }
}
