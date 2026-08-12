/**
 * renderer-crash-guard — bounded automatic renderer recovery.
 *
 * Before this guard existed the render-process-gone handlers only logged: a
 * renderer OOM left the overlay as a transparent, click-blocking, permanently
 * empty window (with a live tray) until a manual app relaunch — twice in one
 * production day. These tests pin the recovery budget: crashes recover, a
 * crash loop gives up with an operator notification, and a manual show
 * re-arms the budget.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const { notificationShow, notificationCtor } = vi.hoisted(() => {
  const notificationShow = vi.fn()
  const notificationCtor = vi.fn()
  return { notificationShow, notificationCtor }
})

vi.mock('electron', () => ({
  Notification: class {
    static isSupported() { return true }
    constructor(opts: unknown) { notificationCtor(opts) }
    show() { notificationShow() }
  },
}))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() }))

import {
  attemptRendererRecovery,
  resetRendererCrashGuard,
  __resetCrashGuardForTest,
} from '../renderer-crash-guard'

const CRASH = { reason: 'crashed', exitCode: 5 }

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  __resetCrashGuardForTest()
})

describe('attemptRendererRecovery', () => {
  it('runs the recovery on a crash', () => {
    const recover = vi.fn()
    expect(attemptRendererRecovery('overlay', CRASH, recover)).toBe(true)
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('gives up after the budget is spent and notifies the operator once', () => {
    const recover = vi.fn()
    for (let i = 0; i < 3; i++) {
      expect(attemptRendererRecovery('overlay', CRASH, recover)).toBe(true)
    }

    // Fourth crash inside the window: refused, operator notified.
    expect(attemptRendererRecovery('overlay', CRASH, recover)).toBe(false)
    expect(recover).toHaveBeenCalledTimes(3)
    expect(notificationShow).toHaveBeenCalledTimes(1)

    // Fifth crash: still refused, but no notification spam.
    expect(attemptRendererRecovery('overlay', CRASH, recover)).toBe(false)
    expect(notificationShow).toHaveBeenCalledTimes(1)
  })

  it('budgets are per window kind', () => {
    const recover = vi.fn()
    for (let i = 0; i < 4; i++) attemptRendererRecovery('overlay', CRASH, recover)
    // The overlay budget being spent must not block the ATV.
    expect(attemptRendererRecovery('atv', CRASH, recover)).toBe(true)
  })

  it('the rolling window forgets old crashes', () => {
    const recover = vi.fn()
    for (let i = 0; i < 3; i++) attemptRendererRecovery('overlay', CRASH, recover)

    // Outside the 5-minute window the budget is available again.
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(attemptRendererRecovery('overlay', CRASH, recover)).toBe(true)
  })

  it('a manual show resets an exhausted budget', () => {
    const recover = vi.fn()
    for (let i = 0; i < 4; i++) attemptRendererRecovery('overlay', CRASH, recover)
    expect(attemptRendererRecovery('overlay', CRASH, recover)).toBe(false)

    resetRendererCrashGuard('overlay')

    expect(attemptRendererRecovery('overlay', CRASH, recover)).toBe(true)
  })

  it('a recovery that throws is contained and reported as failed', () => {
    const recover = vi.fn(() => { throw new Error('window already closing') })
    expect(attemptRendererRecovery('overlay', CRASH, recover)).toBe(false)
  })
})
