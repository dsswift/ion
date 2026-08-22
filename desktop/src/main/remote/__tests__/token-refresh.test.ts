/**
 * Relay token-refresh scheduler.
 *
 * The defect: the delay was `Math.max(0, expiry - lead - now)`, so a token
 * already inside its refresh lead armed the timer at ZERO. It fired, the engine
 * answered from its scope cache with the same credential and the same expiry,
 * and the handler re-armed at zero — a tight loop that rebuilt every per-device
 * relay client and awaited a peer config push each pass. It ran at roughly 2700
 * desktop log lines per second in production.
 *
 * Both regression tests below fail against that code: the first because the
 * delay was 0 rather than floored, the second because a non-advancing expiry
 * rotated sockets and rescheduled anyway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  computeRefreshDelay,
  scheduleTokenRefresh,
  clearTokenRefreshTimer,
  TOKEN_REFRESH_LEAD_MS,
  TOKEN_REFRESH_MIN_DELAY_MS,
  type TokenRefreshDeps,
} from '../token-refresh'

const NOW = 1_700_000_000_000

function makeDeps(over: Partial<TokenRefreshDeps> = {}): {
  deps: TokenRefreshDeps
  requestToken: ReturnType<typeof vi.fn>
  rotateSockets: ReturnType<typeof vi.fn>
  pushConfigToPeers: ReturnType<typeof vi.fn>
} {
  const deps: TokenRefreshDeps = {
    requestToken: vi.fn().mockResolvedValue({ ok: true, data: { accessToken: 't', expiresAt: NOW } }),
    rotateSockets: vi.fn(),
    pushConfigToPeers: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    warn: vi.fn(),
    now: () => NOW,
    ...over,
  }
  // Read the spies back OFF deps, so an override is what the assertions see.
  return {
    deps,
    requestToken: deps.requestToken as ReturnType<typeof vi.fn>,
    rotateSockets: deps.rotateSockets as ReturnType<typeof vi.fn>,
    pushConfigToPeers: deps.pushConfigToPeers as ReturnType<typeof vi.fn>,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  clearTokenRefreshTimer()
  vi.useRealTimers()
})

describe('computeRefreshDelay', () => {
  it('waits until the lead time before a comfortably distant expiry', () => {
    const oneHour = 60 * 60 * 1000
    const d = computeRefreshDelay(NOW + oneHour, NOW)
    expect(d.delayMs).toBe(oneHour - TOKEN_REFRESH_LEAD_MS)
    expect(d.floored).toBe(false)
  })

  // THE regression case: remaining life shorter than the lead.
  it('floors an expiry already inside the refresh lead', () => {
    const d = computeRefreshDelay(NOW + 10 * 1000, NOW)
    expect(d.rawDelayMs).toBeLessThan(0)
    expect(d.delayMs).toBe(TOKEN_REFRESH_MIN_DELAY_MS)
    expect(d.floored).toBe(true)
  })

  it('floors an expiry already in the past instead of returning zero', () => {
    const d = computeRefreshDelay(NOW - 60 * 1000, NOW)
    expect(d.delayMs).toBe(TOKEN_REFRESH_MIN_DELAY_MS)
  })

  it('never returns a delay below the floor for any expiry', () => {
    for (const remaining of [-3_600_000, -1, 0, 1, 1_000, 29_999, 30_000, 89_999]) {
      expect(computeRefreshDelay(NOW + remaining, NOW).delayMs).toBeGreaterThanOrEqual(TOKEN_REFRESH_MIN_DELAY_MS)
    }
  })
})

describe('scheduleTokenRefresh', () => {
  it('does not fire immediately for a token inside its refresh lead', async () => {
    const { deps, requestToken } = makeDeps()
    scheduleTokenRefresh('scope', NOW + 5_000, deps)

    // On the unfixed code the timer was armed at 0 and this had already run.
    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MIN_DELAY_MS - 1)
    expect(requestToken).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(requestToken).toHaveBeenCalledOnce()
  })

  // The second, independent bound on the loop.
  it('does not rotate sockets when the engine returns a non-advancing expiry', async () => {
    const armedExpiry = NOW + 5_000
    const { deps, requestToken, rotateSockets, pushConfigToPeers } = makeDeps({
      // A pure scope-cache hit: same credential, same expiry, forever.
      requestToken: vi.fn().mockResolvedValue({ ok: true, data: { accessToken: 't', expiresAt: armedExpiry } }),
    })
    scheduleTokenRefresh('scope', armedExpiry, deps)

    // Ten floored windows. On the unfixed code each pass rotated sockets and
    // pushed config; here the work is skipped and only the cheap retry recurs.
    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MIN_DELAY_MS * 10)

    expect(rotateSockets).not.toHaveBeenCalled()
    expect(pushConfigToPeers).not.toHaveBeenCalled()
    // Still retrying — bounded, not abandoned.
    expect(requestToken.mock.calls.length).toBe(10)
  })

  it('rotates sockets and re-arms on the fresh expiry when the token really advances', async () => {
    const armedExpiry = NOW + 5_000
    const freshExpiry = NOW + 60 * 60 * 1000
    const { deps, rotateSockets, pushConfigToPeers } = makeDeps({
      requestToken: vi.fn().mockResolvedValue({ ok: true, data: { accessToken: 't2', expiresAt: freshExpiry } }),
    })
    scheduleTokenRefresh('scope', armedExpiry, deps)

    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MIN_DELAY_MS)

    expect(rotateSockets).toHaveBeenCalledWith('scope')
    expect(pushConfigToPeers).toHaveBeenCalledOnce()
  })

  it('does not reschedule when the engine refuses to mint', async () => {
    const { deps, requestToken, rotateSockets } = makeDeps({
      requestToken: vi.fn().mockResolvedValue({ ok: false, error: 'no grant' }),
    })
    scheduleTokenRefresh('scope', NOW + 5_000, deps)

    // The credential factory re-arms on the next mint attempt; a failed refresh
    // must not spin on its own.
    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MIN_DELAY_MS * 5)
    expect(requestToken).toHaveBeenCalledOnce()
    expect(rotateSockets).not.toHaveBeenCalled()
  })

  it('replaces the previous timer rather than stacking a second one', async () => {
    const { deps, requestToken } = makeDeps()
    scheduleTokenRefresh('scope', NOW + 5_000, deps)
    scheduleTokenRefresh('scope', NOW + 5_000, deps)
    scheduleTokenRefresh('scope', NOW + 5_000, deps)

    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MIN_DELAY_MS)
    expect(requestToken).toHaveBeenCalledOnce()
  })

  it('stops firing after clearTokenRefreshTimer', async () => {
    const { deps, requestToken } = makeDeps()
    scheduleTokenRefresh('scope', NOW + 5_000, deps)
    clearTokenRefreshTimer()

    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MIN_DELAY_MS * 3)
    expect(requestToken).not.toHaveBeenCalled()
  })
})
