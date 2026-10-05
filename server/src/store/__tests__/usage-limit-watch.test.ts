/**
 * The server's own handling of usage limits: what it does when a
 * conversation becomes limited, and what each minute's sweep sends.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { FleetAccount } from '@ion/shared/types-fleet'

vi.mock('../rendererLogger', () => ({ rDebug: vi.fn(), rError: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../thin-view/push-doorbell', () => ({ ringOfflineThinClients: vi.fn() }))
vi.mock('../../thin-view/push-title', () => ({ pushConversationTitle: () => null }))
vi.mock('../../persistence/preferences', () => ({ usePreferencesStore: { getState: () => ({}) } }))
vi.mock('../../fleet/account-ledger', () => ({ listAccounts: () => [] }))
vi.mock('../../fleet/usage-automation-trigger', () => ({ triggerUsageAutomation: vi.fn(async () => {}) }))
vi.mock('../../engine/provider-api', () => ({ listModels: vi.fn(), getDefaultProvider: vi.fn() }))
vi.mock('../../host-name', () => ({ hostName: () => 'jolteon' }))
vi.mock('../../paths', () => ({ dataDir: () => '/nonexistent-ion-test' }))

import { LIMIT_PUSH_KIND, LIMIT_RESET_GRACE_MS, QUOTA_EXPIRING_PUSH_KIND, setupUsageLimitWatch, type UsageLimitSettings } from '../usage-limit-watch'
import type { State } from '../session-store-types'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const HOUR = 3_600_000

function tab(over: Record<string, unknown> = {}) {
  return { id: 'a', title: 'Title', status: 'failed', isTerminalOnly: false, inputLocked: false, settledOverride: null, workingDirectory: '/repo', usageLimit: null, deferredSend: null, ...over }
}

function account(over: Partial<FleetAccount> = {}): FleetAccount {
  return {
    provider: 'anthropic', backend: 'claude-code', email: 'user@example.com', firstSeen: NOW - 9 * HOUR, lastSeen: NOW, signedIn: true,
    limits: [{ kind: 'weekly', percent: 40, resetsAt: new Date(NOW + 6 * HOUR).toISOString(), fetchedAt: NOW - HOUR }], ...over,
  }
}

function harness(settings: Partial<UsageLimitSettings> = {}, accounts: FleetAccount[] = []) {
  const listeners = new Set<(next: State, previous: State) => void>()
  const deferSend = vi.fn(() => true)
  const releaseDeferredSend = vi.fn(() => true)
  let state = { tabsReady: true, tabs: [tab()], conversationPanes: new Map(), deferSend, releaseDeferredSend } as unknown as State
  const apply = (next: State): void => {
    const previous = state
    state = next
    for (const listener of listeners) listener(state, previous)
  }
  const store = {
    getState: () => state,
    setState: (patch: (current: State) => Partial<State>) => apply({ ...state, ...patch(state) } as State),
    subscribe: (listener: (next: State, previous: State) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  } as unknown as StoreApi<State>
  const ring = vi.fn()
  const automation = vi.fn(async () => {})
  const alerted = new Set<string>()
  const watch = setupUsageLimitWatch(store, {
    ring, automation, host: () => 'jolteon', title: () => null, accounts: () => accounts,
    settings: () => ({ autoResume: false, resumePrompt: 'Continue.', spare: { withinHours: 12, unusedPercent: 25 }, expiryAlert: true, ...settings }),
    providerOf: async () => 'anthropic', alerted: { has: (k) => alerted.has(k), add: (k) => { alerted.add(k) } },
    now: () => NOW, sweepMs: 60_000_000,
  })
  const setTab = (over: Record<string, unknown>): void => apply({ ...state, tabs: [tab(over)] } as State)
  return { store, setTab, ring, automation, deferSend, releaseDeferredSend, watch, tabs: () => state.tabs }
}

let active: ReturnType<typeof harness> | null = null
afterEach(() => { active?.watch.stop(); active = null })

describe('a conversation becomes limited', () => {
  it('rings once with the reset time and tells automations', () => {
    const h = active = harness()
    h.setTab({ usageLimit: { limitType: 'five_hour', resetsAt: NOW + HOUR, hitAt: NOW } })
    h.setTab({ usageLimit: { limitType: 'five_hour', resetsAt: NOW + HOUR, hitAt: NOW }, title: 'renamed' })

    expect(h.ring).toHaveBeenCalledTimes(1)
    expect(h.ring.mock.calls[0][0]).toMatchObject({ pushTabId: 'a', notifyKind: LIMIT_PUSH_KIND })
    expect(h.ring.mock.calls[0][0].pushBody).toContain('5-hour limit reached on jolteon')
    expect(h.automation).toHaveBeenCalledWith('usage:limit-reached', expect.objectContaining({ tabId: 'a', limitType: 'five_hour' }))
    expect(h.deferSend).not.toHaveBeenCalled()
  })

  it('holds the resume prompt when the server resumes by itself', () => {
    const h = active = harness({ autoResume: true })
    h.setTab({ usageLimit: { limitType: 'five_hour', resetsAt: NOW + HOUR, hitAt: NOW } })
    expect(h.deferSend).toHaveBeenCalledWith('a', 'Continue.', 'limit-reset')
  })
})

describe('the minute sweep', () => {
  it('sends a held resume prompt only once the limit has reset', async () => {
    const h = active = harness()
    h.setTab({ usageLimit: { limitType: 'five_hour', resetsAt: NOW + HOUR, hitAt: NOW - HOUR }, deferredSend: { text: 'Continue.', release: 'limit-reset', queuedAt: NOW } })
    await h.watch.sweep()
    expect(h.releaseDeferredSend).not.toHaveBeenCalled()

    h.setTab({ usageLimit: { limitType: 'five_hour', resetsAt: NOW - LIMIT_RESET_GRACE_MS, hitAt: NOW - 5 * HOUR }, deferredSend: { text: 'Continue.', release: 'limit-reset', queuedAt: NOW } })
    await h.watch.sweep()
    expect(h.releaseDeferredSend).toHaveBeenCalledWith('a')
    expect(h.automation).toHaveBeenCalledWith('usage:limit-reset', expect.objectContaining({ tabId: 'a' }))
  })

  it('tells automations of a reset once, however long a held prompt waits for the conversation to rest', async () => {
    const h = active = harness()
    const limited = { usageLimit: { limitType: 'five_hour', resetsAt: NOW - LIMIT_RESET_GRACE_MS, hitAt: NOW - 5 * HOUR }, deferredSend: { text: 'Continue.', release: 'limit-reset', queuedAt: NOW } }
    h.setTab({ ...limited, status: 'running' })
    await h.watch.sweep()
    await h.watch.sweep()
    expect(h.releaseDeferredSend).not.toHaveBeenCalled()
    expect(h.automation).not.toHaveBeenCalledWith('usage:limit-reset', expect.anything())

    h.releaseDeferredSend.mockReturnValueOnce(false)
    h.setTab({ ...limited, status: 'idle' })
    await h.watch.sweep()
    expect(h.automation).not.toHaveBeenCalledWith('usage:limit-reset', expect.anything())
    await h.watch.sweep()
    expect((h.automation.mock.calls as unknown[][]).filter((call) => call[0] === 'usage:limit-reset')).toHaveLength(1)
  })

  it('lifts a reset limit that has nothing queued', async () => {
    const h = active = harness()
    h.setTab({ usageLimit: { limitType: 'five_hour', resetsAt: NOW - LIMIT_RESET_GRACE_MS, hitAt: NOW - 5 * HOUR } })
    await h.watch.sweep()
    expect(h.tabs()[0].usageLimit).toBeNull()
    expect(h.releaseDeferredSend).not.toHaveBeenCalled()
  })

  it('sends a prompt queued for spare quota when its account has quota about to reset unused', async () => {
    const h = active = harness({}, [account()])
    h.setTab({ status: 'idle', deferredSend: { text: 'Run the audit.', release: 'spare-quota', queuedAt: NOW } })
    await h.watch.sweep()
    expect(h.releaseDeferredSend).toHaveBeenCalledWith('a')
  })

  it('keeps that prompt while the quota is not spare, or the conversation is mid-run', async () => {
    const busy = active = harness({}, [account()])
    busy.setTab({ status: 'running', deferredSend: { text: 'x', release: 'spare-quota', queuedAt: NOW } })
    await busy.watch.sweep()
    expect(busy.releaseDeferredSend).not.toHaveBeenCalled()
    busy.watch.stop()

    const spent = active = harness({}, [account({ limits: [{ kind: 'weekly', percent: 95, resetsAt: new Date(NOW + 6 * HOUR).toISOString(), fetchedAt: NOW }] })])
    spent.setTab({ status: 'idle', deferredSend: { text: 'x', release: 'spare-quota', queuedAt: NOW } })
    await spent.watch.sweep()
    expect(spent.releaseDeferredSend).not.toHaveBeenCalled()
  })

  it('rings once per account window that is about to reset unused', async () => {
    const h = active = harness({}, [account()])
    await h.watch.sweep()
    await h.watch.sweep()
    const rings = h.ring.mock.calls.filter(([push]) => push.notifyKind === QUOTA_EXPIRING_PUSH_KIND)
    expect(rings).toHaveLength(1)
    expect(rings[0][0].pushBody).toContain('60% of the 7-day limit on jolteon resets in 6 h')
    expect(h.automation).toHaveBeenCalledWith('usage:quota-expiring', expect.objectContaining({ provider: 'anthropic', unusedPercent: 60 }))
  })

  it('stays silent about expiring quota when the alert is off', async () => {
    const h = active = harness({ expiryAlert: false }, [account()])
    await h.watch.sweep()
    expect(h.ring).not.toHaveBeenCalled()
  })
})
