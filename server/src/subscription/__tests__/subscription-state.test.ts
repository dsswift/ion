import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import type { ServerSubscriptionLookupConfig } from '../../config/subscription-lookup-config'
import { LookupFailure, type Subscription } from '../lookup-client'
import { SubscriptionStates, type CachedSubscription, type SubscriptionCache } from '../subscription-state'
import type { ProviderSubscriptionStatus } from '@ion/shared/types-engine-event'

const CONFIG: ServerSubscriptionLookupConfig = {
  endpoint: 'https://ai.example.org/keys/subscriptions',
  provider: 'gateway',
  scope: 'api://example/Gateway.Keys.Read',
  displayName: 'Example Gateway',
  header: 'x-api-key',
  timeoutMs: 1000,
  cacheMaxAgeSeconds: 0,
  requireSelection: false,
}

const STANDARD: Subscription = { id: 'sub-standard', label: 'Standard', key: 'key-standard' }
const HIGH: Subscription = { id: 'sub-high', label: 'High quota', key: 'key-high' }

class MemoryCache implements SubscriptionCache {
  readonly store = new Map<string, CachedSubscription>()
  load(subject: string, provider: string): CachedSubscription | null { return this.store.get(`${subject}|${provider}`) ?? null }
  save(subject: string, provider: string, entry: CachedSubscription): void { this.store.set(`${subject}|${provider}`, entry) }
  clear(subject: string, provider: string): void { this.store.delete(`${subject}|${provider}`) }
}

function build(overrides: { config?: Partial<ServerSubscriptionLookupConfig> | null; lookup?: () => Promise<Subscription[]>; cache?: MemoryCache; now?: () => number; token?: { ok: false; reason: string } } = {}) {
  const config = overrides.config === null ? null : { ...CONFIG, ...overrides.config }
  const cache = overrides.cache ?? new MemoryCache()
  const changes: Array<{ subject: string; status: ProviderSubscriptionStatus }> = []
  const lookup = vi.fn(overrides.lookup ?? (async () => [STANDARD]))
  const tokens = vi.fn(async () => overrides.token ?? { ok: true as const, accessToken: 'token' })
  const states = new SubscriptionStates({
    config: () => config,
    tokens,
    lookup,
    cache,
    onChange: (subject, status) => changes.push({ subject, status }),
    now: overrides.now,
    providerDisplayName: () => 'Example Gateway',
  })
  return { states, cache, changes, lookup, tokens }
}

beforeEach(() => vi.clearAllMocks())

describe('first open with no key', () => {
  it('runs the lookup and applies the only subscription silently', async () => {
    const { states, lookup, cache } = build()
    const status = await states.ensure('alice')
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(status.state).toBe('applied')
    expect(status.selected).toEqual({ id: 'sub-standard', label: 'Standard' })
    expect(status.source).toBe('lookup')
    expect(states.keyFor('alice', 'gateway')).toBe('key-standard')
    expect(cache.load('alice', 'gateway')?.selectedId).toBe('sub-standard')
  })

  it('shows resolving while the lookup runs, then the result, in order', async () => {
    const { states, changes } = build()
    await states.ensure('alice')
    expect(changes.map((c) => c.status.state)).toEqual(['resolving', 'applied'])
  })

  it('offers a picker when there are several and none was chosen before', async () => {
    const { states } = build({ lookup: async () => [STANDARD, HIGH] })
    const status = await states.ensure('alice')
    expect(status.state).toBe('selection_required')
    expect(status.options).toEqual([{ id: 'sub-standard', label: 'Standard' }, { id: 'sub-high', label: 'High quota' }])
    expect(states.keyFor('alice', 'gateway')).toBeNull()
  })

  it('never puts a key in a snapshot', async () => {
    const { states, changes } = build({ lookup: async () => [STANDARD, HIGH] })
    await states.ensure('alice')
    const everything = JSON.stringify([...changes.map((c) => c.status), states.status('alice')])
    expect(everything).not.toContain('key-standard')
    expect(everything).not.toContain('key-high')
  })

  it('asks even for a single subscription when requireSelection is on', async () => {
    const { states } = build({ config: { requireSelection: true } })
    expect((await states.ensure('alice')).state).toBe('selection_required')
  })

  it('reports none, and clears a remembered key, when the account has no subscription', async () => {
    const cache = new MemoryCache()
    cache.save('alice', 'gateway', { selectedId: 'old', label: 'Old', key: 'k', options: [], resolvedAt: 1 })
    const { states } = build({ cache, lookup: async () => [], config: { cacheMaxAgeSeconds: 1 }, now: () => 10_000_000 })
    const status = await states.ensure('alice')
    expect(status.state).toBe('none')
    expect(states.keyFor('alice', 'gateway')).toBeNull()
    expect(cache.load('alice', 'gateway')).toBeNull()
  })
})

describe('choosing and remembering', () => {
  it('applies a chosen subscription and remembers it for the next sign-in', async () => {
    const { states, cache } = build({ lookup: async () => [STANDARD, HIGH] })
    await states.ensure('alice')
    const result = await states.select('alice', 'sub-high')
    expect(result.ok).toBe(true)
    expect(result.status.state).toBe('applied')
    expect(states.keyFor('alice', 'gateway')).toBe('key-high')
    expect(cache.load('alice', 'gateway')?.selectedId).toBe('sub-high')
  })

  it('refuses a subscription that was not offered', async () => {
    const { states } = build({ lookup: async () => [STANDARD, HIGH] })
    await states.ensure('alice')
    const result = await states.select('alice', 'sub-unknown')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not offered/)
    expect(states.keyFor('alice', 'gateway')).toBeNull()
  })

  it('reuses a remembered choice when the lookup returns several again', async () => {
    const cache = new MemoryCache()
    const first = build({ cache, lookup: async () => [STANDARD, HIGH] })
    await first.states.ensure('alice')
    await first.states.select('alice', 'sub-high')

    // A restart: a new states object over the same cache, with a cache old enough to look up again.
    const second = build({ cache, lookup: async () => [STANDARD, HIGH], config: { cacheMaxAgeSeconds: 1 }, now: () => Date.now() + 10_000 })
    const status = await second.states.ensure('alice')
    expect(second.lookup).toHaveBeenCalledTimes(1)
    expect(status.state).toBe('applied')
    expect(status.selected?.id).toBe('sub-high')
  })
})

describe('the cache', () => {
  it('applies a cached key with no lookup while cacheMaxAgeSeconds is 0', async () => {
    const cache = new MemoryCache()
    cache.save('alice', 'gateway', { selectedId: 'sub-high', label: 'High quota', key: 'cached-key', options: [{ id: 'sub-high', label: 'High quota' }], resolvedAt: 5 })
    const { states, lookup } = build({ cache })
    const status = await states.ensure('alice')
    expect(lookup).not.toHaveBeenCalled()
    expect(status.source).toBe('cache')
    expect(states.keyFor('alice', 'gateway')).toBe('cached-key')
  })

  it('applies a stale cached key at once and looks up again behind it', async () => {
    const cache = new MemoryCache()
    cache.save('alice', 'gateway', { selectedId: 'sub-standard', label: 'Standard', key: 'old-key', options: [], resolvedAt: 0 })
    const { states, lookup } = build({
      cache,
      config: { cacheMaxAgeSeconds: 60 },
      now: () => 10 * 60 * 1000,
      lookup: async () => [{ ...STANDARD, key: 'rotated-key' }],
    })
    await states.ensure('alice')
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(states.keyFor('alice', 'gateway')).toBe('rotated-key')
  })

  it('keeps a cached key when the refresh lookup fails, and says so', async () => {
    const cache = new MemoryCache()
    cache.save('alice', 'gateway', { selectedId: 'sub-standard', label: 'Standard', key: 'old-key', options: [], resolvedAt: 0 })
    const { states } = build({
      cache,
      config: { cacheMaxAgeSeconds: 60 },
      now: () => 10 * 60 * 1000,
      lookup: async () => { throw new LookupFailure('the lookup timed out') },
    })
    const status = await states.ensure('alice')
    expect(status.state).toBe('applied')
    expect(status.error).toMatch(/timed out/)
    expect(states.keyFor('alice', 'gateway')).toBe('old-key')
  })

  it('survives a cache that cannot be written', async () => {
    const cache = new MemoryCache()
    vi.spyOn(cache, 'save').mockImplementation(() => { throw new Error('disk full') })
    const { states } = build({ cache })
    const status = await states.ensure('alice')
    expect(status.state).toBe('applied')
    expect(states.keyFor('alice', 'gateway')).toBe('key-standard')
  })
})

describe('a failed lookup', () => {
  it('leaves a clear message, not an opaque error', async () => {
    const { states } = build({ lookup: async () => { throw new LookupFailure('this account is not allowed to look up a subscription (403)', 403) } })
    const status = await states.ensure('alice')
    expect(status.state).toBe('failed')
    expect(status.error).toBe('Could not look up your subscription: this account is not allowed to look up a subscription (403).')
    expect(states.keyFor('alice', 'gateway')).toBeNull()
  })

  it('says why when this server holds no token for the person', async () => {
    const { states, lookup } = build({ token: { ok: false, reason: 'you have not signed in to this server in a browser' } })
    const status = await states.ensure('alice')
    expect(lookup).not.toHaveBeenCalled()
    expect(status.state).toBe('failed')
    expect(status.error).toContain('you have not signed in to this server in a browser')
  })

  it('tries again on the next open, and on a refresh', async () => {
    let calls = 0
    const { states } = build({ lookup: async () => { calls += 1; if (calls === 1) throw new LookupFailure('the lookup could not be reached'); return [STANDARD] } })
    expect((await states.ensure('alice')).state).toBe('failed')
    expect((await states.ensure('alice')).state).toBe('applied')
  })

  it('refresh looks up again now', async () => {
    const { states, lookup } = build({ lookup: async () => [STANDARD, HIGH] })
    await states.ensure('alice')
    await states.refresh('alice')
    expect(lookup).toHaveBeenCalledTimes(2)
  })
})

describe('one person never gets another person\'s key', () => {
  it('keeps each person\'s state and key apart', async () => {
    const { states } = build({
      lookup: vi.fn()
        .mockResolvedValueOnce([{ id: 'a', label: 'A', key: 'alice-key' }])
        .mockResolvedValueOnce([{ id: 'b', label: 'B', key: 'bob-key' }]),
    })
    await states.ensure('alice')
    await states.ensure('bob')
    expect(states.keyFor('alice', 'gateway')).toBe('alice-key')
    expect(states.keyFor('bob', 'gateway')).toBe('bob-key')
    expect(states.keyFor('carol', 'gateway')).toBeNull()
  })

  it('routes each change to the person it belongs to', async () => {
    const { states, changes } = build()
    await states.ensure('alice')
    await states.ensure('bob')
    expect(new Set(changes.filter((c) => c.status.state === 'applied').map((c) => c.subject))).toEqual(new Set(['alice', 'bob']))
  })

  it('shares one lookup between two callers asking for the same person at once', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { states, lookup } = build({ lookup: async () => { await gate; return [STANDARD] } })
    const first = states.ensure('alice')
    const second = states.ensure('alice')
    release?.()
    await Promise.all([first, second])
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('removes the applied key at sign-out, keeping the remembered choice on disk', async () => {
    const { states, cache } = build()
    await states.ensure('alice')
    states.forget('alice')
    expect(states.keyFor('alice', 'gateway')).toBeNull()
    expect(cache.load('alice', 'gateway')).not.toBeNull()
  })

  it('answers only for the lookup\'s own provider', async () => {
    const { states } = build()
    await states.ensure('alice')
    expect(states.keyFor('alice', 'some-other-provider')).toBeNull()
  })
})

describe('no lookup configured', () => {
  it('is disabled and answers nothing, so providerCredentials and the engine serve as before', async () => {
    const { states, lookup } = build({ config: null })
    expect(states.enabled()).toBe(false)
    expect((await states.ensure('alice')).state).toBe('disabled')
    expect(states.status('alice').state).toBe('disabled')
    expect(states.keyFor('alice', 'gateway')).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('snapshot', () => {
  it('names the provider the way people read it', async () => {
    const { states } = build()
    await states.ensure('alice')
    expect(states.status('alice').providerDisplayName).toBe('Example Gateway')
    expect(states.status('alice').provider).toBe('gateway')
  })

  it('reads awaiting_identity for a person not yet seen', () => {
    const { states } = build()
    expect(states.status('nobody').state).toBe('awaiting_identity')
  })
})
