// @vitest-environment jsdom
/**
 * A tab that sleeps wakes holding a session the server may have forgotten.
 * The guard asks one question first and acts on the answer, so the person
 * is signed back in (or told to sign in) instead of watching a half-working app.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionGuard, SLEPT_AFTER_MS, TICK_MS, type SessionGuardDeps } from '../browser-session-guard'

function setup(statuses: number[]) {
  let clock = 1_000_000
  const calls = { check: 0, signIn: 0 }
  const logs: Array<{ level: string; msg: string }> = []
  const queue = [...statuses]
  const deps: SessionGuardDeps = {
    checkSession: async () => { calls.check += 1; return queue.length > 1 ? queue.shift()! : queue[0] },
    signInSilently: () => { calls.signIn += 1 },
    isVisible: () => true,
    now: () => clock,
    log: (level, msg) => { logs.push({ level, msg }) },
  }
  const guard = new SessionGuard(deps)
  return { guard, calls, logs, advance: (ms: number) => { clock += ms } }
}

afterEach(() => { vi.useRealTimers() })

describe('SessionGuard.check', () => {
  it('does nothing visible when the session still works', async () => {
    const { guard, calls } = setup([200])
    await guard.check('visible')
    expect(calls.signIn).toBe(0)
    expect(guard.signingIn).toBe(false)
  })

  it('goes straight to the silent sign-in when the server says the session is unknown or expired', async () => {
    const { guard, calls } = setup([401])
    await guard.check('visible')
    expect(calls.signIn).toBe(1)
    expect(guard.signingIn).toBe(true)
  })

  it('does not sign in again while one is already under way (the page is about to leave)', async () => {
    const { guard, calls } = setup([401])
    await guard.check('visible')
    await guard.check('online')
    await guard.check('slept')
    expect(calls.signIn).toBe(1)
    expect(calls.check).toBe(1)
  })

  it('may sign in again once the first attempt has had time to finish', async () => {
    const { guard, calls, advance } = setup([401])
    await guard.check('visible')
    advance(30_000)
    await guard.check('visible')
    expect(calls.signIn).toBe(2)
  })

  // A sign-in service that is down must not sign the person out: their session is fine.
  it('keeps the session and looks again, slowly, when the sign-in service cannot be reached', async () => {
    vi.useFakeTimers()
    const { guard, calls } = setup([503, 503, 200])
    await guard.check('visible')
    expect(calls.signIn).toBe(0)
    expect(calls.check).toBe(1)

    await vi.advanceTimersByTimeAsync(2_100)
    expect(calls.check).toBe(2)
    await vi.advanceTimersByTimeAsync(4_100)
    expect(calls.check).toBe(3)
    expect(calls.signIn).toBe(0)
    guard.stop()
  })

  it('treats no network (status 0) the same way as an unreachable service', async () => {
    const { guard, calls } = setup([0])
    await guard.check('online')
    expect(calls.signIn).toBe(0)
    guard.stop()
  })

  it('runs one check at a time', async () => {
    const { guard, calls } = setup([200])
    await Promise.all([guard.check('visible'), guard.check('visible'), guard.check('online')])
    expect(calls.check).toBe(1)
  })
})

describe('SessionGuard.tick', () => {
  it('is quiet on time, and reports a page that was frozen for a long while', () => {
    const { guard, advance } = setup([200])
    advance(TICK_MS)
    expect(guard.tick()).toBe(false)
    advance(TICK_MS + 5_000)
    expect(guard.tick()).toBe(false)
    // A laptop that slept for 8 hours: the next tick is hours late.
    advance(8 * 60 * 60_000)
    expect(guard.tick()).toBe(true)
  })

  it('counts a tick as late once it is a full minute behind', () => {
    const { guard, advance } = setup([200])
    advance(TICK_MS + SLEPT_AFTER_MS - TICK_MS)
    expect(guard.tick()).toBe(true)
  })
})
