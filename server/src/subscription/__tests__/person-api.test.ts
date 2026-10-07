import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))

import type { ServerSubscriptionLookupConfig } from '../../config/subscription-lookup-config'
import { personLookupEnabled, personSubscription, refreshPersonSubscription, selectPersonSubscription } from '../person-api'
import { SubscriptionStates, type SubscriptionCache } from '../subscription-state'

const CONFIG: ServerSubscriptionLookupConfig = {
  endpoint: 'https://ai.example.org/keys/subscriptions', provider: 'gateway', scope: 'api://x/Gateway.Keys.Read',
  displayName: '', header: '', timeoutMs: 1000, cacheMaxAgeSeconds: 0, requireSelection: false,
}
const noCache: SubscriptionCache = { load: () => null, save: () => undefined, clear: () => undefined }

function states(subscriptions = [{ id: 'a', label: 'A', key: 'k' }], config: ServerSubscriptionLookupConfig | null = CONFIG) {
  const lookup = vi.fn(async () => subscriptions)
  return { s: new SubscriptionStates({ config: () => config, tokens: async () => ({ ok: true, accessToken: 't' }), lookup, cache: noCache, onChange: () => undefined }), lookup }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('first open', () => {
  it('runs the lookup the first time a person reads their subscription, with no click', async () => {
    const { s, lookup } = states()
    const first = await personSubscription('alice', s)
    expect(first.ok).toBe(true)
    expect(lookup).toHaveBeenCalledTimes(1)
    await settle()
    expect((await personSubscription('alice', s)).subscription.state).toBe('applied')
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('does not look up again on every later read', async () => {
    const { s, lookup } = states()
    await personSubscription('alice', s)
    await settle()
    await personSubscription('alice', s)
    await personSubscription('alice', s)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('retries after a failure on the next read', async () => {
    let calls = 0
    const lookup = vi.fn(async () => { calls += 1; if (calls === 1) throw new Error('down'); return [{ id: 'a', label: 'A', key: 'k' }] })
    const s = new SubscriptionStates({ config: () => CONFIG, tokens: async () => ({ ok: true, accessToken: 't' }), lookup, cache: noCache, onChange: () => undefined })
    await personSubscription('alice', s)
    await settle()
    expect(s.status('alice').state).toBe('failed')
    await personSubscription('alice', s)
    await settle()
    expect(s.status('alice').state).toBe('applied')
  })

  it('does nothing when no lookup is configured', async () => {
    const { s, lookup } = states([], null)
    expect(personLookupEnabled(s)).toBe(false)
    expect((await personSubscription('alice', s)).subscription.state).toBe('disabled')
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('choosing', () => {
  it('applies a chosen subscription for the person asking', async () => {
    const { s } = states([{ id: 'a', label: 'A', key: 'ka' }, { id: 'b', label: 'B', key: 'kb' }])
    await personSubscription('alice', s)
    await settle()
    expect(s.status('alice').state).toBe('selection_required')
    const result = await selectPersonSubscription('alice', { id: 'b' }, s)
    expect(result.ok).toBe(true)
    expect(s.keyFor('alice', 'gateway')).toBe('kb')
  })

  it('refuses a malformed choice and says so', async () => {
    const { s } = states()
    expect(await selectPersonSubscription('alice', {}, s)).toMatchObject({ ok: false, error: 'a subscription id is required' })
    expect(await selectPersonSubscription('alice', { id: '  ' }, s)).toMatchObject({ ok: false })
  })

  it('looks up again on request', async () => {
    const { s, lookup } = states()
    await personSubscription('alice', s)
    await settle()
    await refreshPersonSubscription('alice', s)
    expect(lookup).toHaveBeenCalledTimes(2)
  })
})
