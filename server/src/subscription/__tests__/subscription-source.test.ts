import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))

import type { ServerSubscriptionLookupConfig } from '../../config/subscription-lookup-config'
import { _unregisterAllPrincipalSourcesForTest, registerPrincipalSource, resolvePrincipalCredential } from '../../credentials/principal-source'
import { adminRefsSource } from '../../credentials/sources/admin-refs'
import { subscriptionSource } from '../index'
import { SubscriptionStates, type SubscriptionCache } from '../subscription-state'

const CONFIG: ServerSubscriptionLookupConfig = {
  endpoint: 'https://ai.example.org/keys/subscriptions',
  provider: 'dci-marketing',
  scope: 'api://example/Gateway.Keys.Read',
  displayName: '',
  header: 'x-api-key',
  timeoutMs: 1000,
  cacheMaxAgeSeconds: 0,
  requireSelection: false,
}

const noCache: SubscriptionCache = { load: () => null, save: () => undefined, clear: () => undefined }

function states(config: ServerSubscriptionLookupConfig | null, key = 'looked-up-key'): SubscriptionStates {
  return new SubscriptionStates({
    config: () => config,
    tokens: async () => ({ ok: true, accessToken: 't' }),
    lookup: async () => [{ id: 's', label: 'S', key }],
    cache: noCache,
    onChange: () => undefined,
  })
}

const provider = (name: string, subject = 'alice') => ({ subject, axis: { kind: 'provider' as const, provider: name } })

beforeEach(() => _unregisterAllPrincipalSourcesForTest())

describe('the subscription credential source', () => {
  it('hands the engine the person\'s looked-up key under the configured header', async () => {
    const s = states(CONFIG)
    await s.ensure('alice')
    const resolved = await subscriptionSource(() => s).resolve(provider('dci-marketing'))
    expect(resolved).toEqual({ source: 'subscription', value: { kind: 'provider', token: 'looked-up-key', header: 'x-api-key' } })
  })

  it('answers for the provider id in any case, as the engine lowercases it', async () => {
    const s = states(CONFIG)
    await s.ensure('alice')
    expect(await subscriptionSource(() => s).resolve(provider('DCI-Marketing'))).not.toBeNull()
  })

  it('starts the person\'s lookup and waits for it when asked before it has run', async () => {
    const s = states(CONFIG)
    const resolved = await subscriptionSource(() => s).resolve(provider('dci-marketing'))
    expect(resolved?.value).toMatchObject({ token: 'looked-up-key' })
  })

  it('answers nothing for another provider, an empty subject, or the git axis', async () => {
    const s = states(CONFIG)
    await s.ensure('alice')
    const source = subscriptionSource(() => s)
    expect(await source.resolve(provider('anthropic'))).toBeNull()
    expect(await source.resolve(provider('dci-marketing', ''))).toBeNull()
    expect(await source.resolve({ subject: 'alice', axis: { kind: 'git', host: 'gitlab.dcim.com' } })).toBeNull()
  })

  it('never answers a person with another person\'s key', async () => {
    const s = states(CONFIG)
    await s.ensure('alice')
    expect(await subscriptionSource(() => new SubscriptionStates({
      config: () => CONFIG, tokens: async () => ({ ok: false, reason: 'no token' }), lookup: async () => [], cache: noCache, onChange: () => undefined,
    })).resolve(provider('dci-marketing', 'bob'))).toBeNull()
  })

  it('answers nothing when no lookup is configured', async () => {
    expect(await subscriptionSource(() => states(null)).resolve(provider('dci-marketing'))).toBeNull()
  })

  it('answers nothing for a person whose lookup found no subscription', async () => {
    const s = new SubscriptionStates({ config: () => CONFIG, tokens: async () => ({ ok: true, accessToken: 't' }), lookup: async () => [], cache: noCache, onChange: () => undefined })
    await s.ensure('alice')
    expect(await subscriptionSource(() => s).resolve(provider('dci-marketing'))).toBeNull()
  })
})

describe('precedence against the Terraform-seeded key', () => {
  const seeded = () => adminRefsSource(
    () => [{ subject: 'alice', provider: 'dci-marketing', value: 'seeded-key', header: 'x-api-key' }],
    () => [],
  )

  it('a looked-up key outranks a providerCredentials entry for the same person', async () => {
    const s = states(CONFIG)
    await s.ensure('alice')
    registerPrincipalSource(subscriptionSource(() => s))
    registerPrincipalSource(seeded())
    const resolved = await resolvePrincipalCredential(provider('dci-marketing'))
    expect(resolved?.source).toBe('subscription')
    expect(resolved?.value).toMatchObject({ token: 'looked-up-key' })
  })

  it('falls back to the seeded key when the lookup has no key for the person', async () => {
    const s = new SubscriptionStates({ config: () => CONFIG, tokens: async () => ({ ok: false, reason: 'no token' }), lookup: async () => [], cache: noCache, onChange: () => undefined })
    registerPrincipalSource(subscriptionSource(() => s))
    registerPrincipalSource(seeded())
    const resolved = await resolvePrincipalCredential(provider('dci-marketing'))
    expect(resolved?.source).toBe('admin')
  })

  it('with no lookup configured, the seeded key serves exactly as before', async () => {
    registerPrincipalSource(subscriptionSource(() => states(null)))
    registerPrincipalSource(seeded())
    expect((await resolvePrincipalCredential(provider('dci-marketing')))?.source).toBe('admin')
  })
})
