/** The account poll: it reads the engine, never overlaps itself, and follows the engine's sign-in and usage events. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
const bridge = vi.hoisted(() => ({
  request: vi.fn(),
  handlers: [] as Array<(key: string, event: unknown) => void>,
  on: vi.fn((_ev: string, cb: (key: string, event: unknown) => void) => { bridge.handlers.push(cb) }),
}))
vi.mock('../../state', () => ({ engineBridge: bridge }))
vi.mock('../../config/current', () => ({ currentServerConfig: () => ({ fleet: { accountPollSeconds: 300 } }) }))
const ledger = vi.hoisted(() => ({
  recordAccountPoll: vi.fn((entries: unknown[]) => entries.map(() => ({ signedIn: true }))),
  listAccounts: vi.fn(() => []),
  applyRateLimitReport: vi.fn(() => true),
}))
vi.mock('../account-ledger', () => ledger)

import { pollAccountsNow, startAccountPoll, stopAccountPoll } from '../account-poll'

const ANSWER = { ok: true, data: { accounts: [{ backend: 'claude-code', limits: [], fetchedAt: '' }] } }

beforeEach(() => {
  vi.useFakeTimers()
  bridge.request.mockReset().mockResolvedValue(ANSWER)
  ledger.recordAccountPoll.mockClear()
  ledger.applyRateLimitReport.mockClear()
})
afterEach(() => {
  stopAccountPoll()
  vi.useRealTimers()
})

describe('pollAccountsNow', () => {
  it('records what the engine reports', async () => {
    await pollAccountsNow()
    expect(bridge.request).toHaveBeenCalledWith('provider_account_usage')
    expect(ledger.recordAccountPoll).toHaveBeenCalledWith(ANSWER.data.accounts)
  })

  it('shares one engine read between calls that overlap', async () => {
    let release: (v: typeof ANSWER) => void = () => {}
    bridge.request.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const first = pollAccountsNow()
    const second = pollAccountsNow()
    release(ANSWER)
    await Promise.all([first, second])
    expect(bridge.request).toHaveBeenCalledTimes(1)
    await pollAccountsNow()
    expect(bridge.request).toHaveBeenCalledTimes(2)
  })

  it('leaves the ledger alone when the engine read fails', async () => {
    bridge.request.mockResolvedValueOnce({ ok: false, error: 'engine not connected' })
    await pollAccountsNow()
    expect(ledger.recordAccountPoll).not.toHaveBeenCalled()
    bridge.request.mockRejectedValueOnce(new Error('socket closed'))
    await expect(pollAccountsNow()).resolves.toEqual([])
    expect(ledger.recordAccountPoll).not.toHaveBeenCalled()
  })
})

describe('startAccountPoll', () => {
  it('reads at once, again each period, and on the engine events', async () => {
    startAccountPoll()
    await vi.advanceTimersByTimeAsync(0)
    expect(bridge.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(bridge.request).toHaveBeenCalledTimes(2)

    const emit = (event: unknown): void => bridge.handlers.forEach((h) => h('', event))
    emit({ type: 'engine_providers_updated' })
    await vi.advanceTimersByTimeAsync(0)
    expect(bridge.request).toHaveBeenCalledTimes(3)

    const rateLimit = { status: 'allowed', resetsAt: 1, rateLimitType: 'five_hour' }
    emit({ type: 'engine_rate_limit', rateLimit })
    expect(ledger.applyRateLimitReport).toHaveBeenCalledWith('claude-code', rateLimit)
    expect(bridge.request).toHaveBeenCalledTimes(3)

    stopAccountPoll()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(bridge.request).toHaveBeenCalledTimes(3)
  })
})
