/**
 * Proactive relay-token refresh timer.
 *
 * Split out of transport-init.ts so the scheduler's decisions are reachable by a
 * test: the defect this module encodes the fix for was a self-feeding timer, and
 * a self-feeding timer is only observable by driving the schedule.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * The refresh time is the token's expiry minus a lead. A token whose remaining
 * life is already shorter than the lead therefore produces a refresh time in the
 * PAST, and the delay was `Math.max(0, refreshAt - now)` — zero. The timer fired
 * immediately, asked the engine for a token, got the same still-cached
 * credential with the same near expiry back, and re-armed at zero.
 *
 * Each pass called `updateConfig` (which rebuilds every per-device relay client)
 * and awaited a peer config push. Observed in production at roughly 2700 desktop
 * log lines per second, which rotated all four 20 MB generations of
 * `desktop.jsonl` in about twenty minutes and destroyed the log window holding
 * the evidence of the unrelated bug then under investigation.
 *
 * ── The fix, in two independent parts ───────────────────────────────────────
 * 1. A floor on the delay converts an unbounded spin into a bounded retry. A
 *    minute costs nothing: relay auth is checked at WebSocket upgrade, so a
 *    client whose bearer expires before the retry lands reconnects and mints a
 *    fresh one itself.
 * 2. A non-advancing expiry does not rotate sockets. The engine answering from
 *    its scope cache hands back the same credential; pushing relay clients onto
 *    a bearer they already carry is pure churn. Re-arm and leave them alone.
 *
 * Either part alone bounds the loop. Both are here because they fix different
 * things: (1) the arming arithmetic, (2) the work done per pass.
 */

/** How long before token expiry to rotate relay sockets. */
export const TOKEN_REFRESH_LEAD_MS = 30 * 1000

/** Floor on the refresh delay. See the header — this is what bounds the loop. */
export const TOKEN_REFRESH_MIN_DELAY_MS = 60 * 1000

export interface TokenResult {
  ok: boolean
  error?: string
  data?: { accessToken?: string; expiresAt?: number }
}

/** Everything the scheduler touches outside itself, injected so it is testable. */
export interface TokenRefreshDeps {
  /** Ask the engine for a token for this scope. */
  requestToken: (oidcScope: string) => Promise<TokenResult>
  /** Rebuild the per-device relay clients onto a fresh credential. */
  rotateSockets: (oidcScope: string) => void
  /** Persist refreshed bootstrap config to paired peers. Result unused. */
  pushConfigToPeers: () => Promise<unknown>
  log: (msg: string, fields?: Record<string, unknown>) => void
  warn: (msg: string, fields?: Record<string, unknown>) => void
  now: () => number
}

/** Module-level refresh timer. Cleared when the transport is torn down. */
let tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null

export function clearTokenRefreshTimer(): void {
  if (tokenRefreshTimer !== null) {
    clearTimeout(tokenRefreshTimer)
    tokenRefreshTimer = null
  }
}

export interface RefreshDelay {
  /** The delay actually armed. */
  delayMs: number
  /** What the expiry arithmetic asked for, before the floor. */
  rawDelayMs: number
  /** Whether the floor changed the answer. */
  floored: boolean
}

/**
 * How long to wait before refreshing a token expiring at `expiresAtMs`.
 *
 * Never returns less than `TOKEN_REFRESH_MIN_DELAY_MS`, including for an expiry
 * already in the past — that case is precisely the spin.
 */
export function computeRefreshDelay(expiresAtMs: number, nowMs: number): RefreshDelay {
  const rawDelayMs = expiresAtMs - TOKEN_REFRESH_LEAD_MS - nowMs
  const floored = rawDelayMs < TOKEN_REFRESH_MIN_DELAY_MS
  return { delayMs: floored ? TOKEN_REFRESH_MIN_DELAY_MS : rawDelayMs, rawDelayMs, floored }
}

/**
 * Schedule a proactive token refresh before expiry. On fire, mint a fresh token
 * and push a relay_config update to iOS as persisted bootstrap recovery data.
 * Autonomous OIDC clients keep their authenticated live socket; legacy clients
 * use the refreshed credential on their next reconnect.
 *
 * Idempotent: rescheduling replaces the previous timer, so it never double-fires.
 */
export function scheduleTokenRefresh(
  oidcScope: string,
  expiresAtMs: number,
  deps: TokenRefreshDeps,
): void {
  clearTokenRefreshTimer()
  const { delayMs, rawDelayMs, floored } = computeRefreshDelay(expiresAtMs, deps.now())
  // The expiry this timer was armed against, captured so the handler can tell a
  // genuine refresh from the engine handing back the same credential.
  const armedExpiryMs = expiresAtMs

  if (floored) {
    deps.warn('remote_transport: token expiry inside the refresh lead, flooring retry delay', {
      raw_delay_ms: Math.round(rawDelayMs),
      delay_ms: delayMs,
      expires_at: new Date(expiresAtMs).toISOString(),
    })
  } else {
    deps.log('remote_transport: scheduling token refresh', {
      delay_ms: Math.round(delayMs),
      expires_at: new Date(expiresAtMs).toISOString(),
    })
  }

  tokenRefreshTimer = setTimeout(() => {
    tokenRefreshTimer = null
    void (async () => {
      try {
        const result = await deps.requestToken(oidcScope)
        if (!result.ok || !result.data?.accessToken) {
          deps.warn('remote_transport: proactive token refresh failed, relay will reconnect on expiry', {
            error: result.error ?? 'no token',
          })
          return
        }
        const freshExpiry = result.data.expiresAt
        if (!freshExpiry) {
          deps.warn('remote_transport: proactive token refresh returned no expiry; relay will reconnect on expiry')
          return
        }
        if (freshExpiry <= armedExpiryMs) {
          deps.warn('remote_transport: token refresh returned a non-advancing expiry, not rotating relay sockets', {
            armed_expires_at: new Date(armedExpiryMs).toISOString(),
            fresh_expires_at: new Date(freshExpiry).toISOString(),
          })
          scheduleTokenRefresh(oidcScope, armedExpiryMs, deps)
          return
        }
        deps.log('remote_transport: proactive token refresh succeeded, rotating relay sockets')

        // Relay auth happens during WebSocket upgrade. Existing sockets keep
        // their old bearer until relay closes them, so refresh must rebuild the
        // per-device relay clients now rather than only persisting bootstrap
        // config for iOS.
        deps.rotateSockets(oidcScope)
        await deps.pushConfigToPeers()
        scheduleTokenRefresh(oidcScope, freshExpiry, deps)
      } catch (err) {
        deps.warn('remote_transport: proactive token refresh threw', { error: String(err) })
      }
    })()
  }, delayMs)
}
