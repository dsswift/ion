import { log as _log } from '../logger'
import { engineBridge } from '../state'

function log(msg: string, fields?: Record<string, unknown>): void { _log('oauth', msg, fields) }

interface StoredToken {
  provider: string
  accessToken: string
  refreshToken: string
  expiresAt: number
}

const tokens = new Map<string, StoredToken>()
let refreshTimer: ReturnType<typeof setTimeout> | null = null

type RefreshFn = (refreshToken: string) => Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>
const refreshFns = new Map<string, RefreshFn>()

/** Register a refresh function for a provider. */
export function registerRefreshFn(provider: string, fn: RefreshFn): void {
  refreshFns.set(provider, fn)
}

/** Store tokens after a successful OAuth flow and push access token to engine. */
export async function storeTokens(provider: string, accessToken: string, refreshToken: string, expiresAt: number): Promise<void> {
  tokens.set(provider, { provider, accessToken, refreshToken, expiresAt })
  try {
    await engineBridge.storeCredential(provider, accessToken)
    log('oauth: stored access token', { provider })
  } catch (err) {
    log('oauth: failed to store token', { provider, error: (err as Error).message })
  }
  scheduleRefresh()
}

/** Clear tokens for a provider (logout). */
export async function clearTokens(provider: string): Promise<void> {
  tokens.delete(provider)
  try {
    await engineBridge.storeCredential(provider, '')
    log('oauth: cleared token', { provider })
  } catch (err) {
    log('oauth: failed to clear token', { provider, error: (err as Error).message })
  }
  scheduleRefresh()
}

/** Check if a provider has stored OAuth tokens. */
export function hasTokens(provider: string): boolean {
  return tokens.has(provider)
}

function scheduleRefresh(): void {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
  let earliest = Infinity
  let earliestProvider = ''
  for (const [provider, token] of tokens) {
    const refreshAt = token.expiresAt - 5 * 60 * 1000
    if (refreshAt < earliest) { earliest = refreshAt; earliestProvider = provider }
  }
  if (earliest === Infinity) return
  const delay = Math.max(0, earliest - Date.now())
  log('oauth: scheduling token refresh', { provider: earliestProvider, delay_s: Math.round(delay / 1000) })
  refreshTimer = setTimeout(() => {
    void (async () => {
      refreshTimer = null
      const token = tokens.get(earliestProvider)
      if (!token) return
      const refreshFn = refreshFns.get(earliestProvider)
      if (!refreshFn) { log('oauth: no refresh function', { provider: earliestProvider }); return }
      try {
        log('oauth: refreshing token', { provider: earliestProvider })
        const t = await refreshFn(token.refreshToken)
        await storeTokens(earliestProvider, t.accessToken, t.refreshToken, t.expiresAt)
      } catch (err) {
        log('oauth: failed to refresh token', { provider: earliestProvider, error: (err as Error).message })
        refreshTimer = setTimeout(() => scheduleRefresh(), 60_000)
      }
    })()
  }, delay)
}
