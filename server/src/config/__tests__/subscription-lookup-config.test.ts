import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { parseSubscriptionLookup } from '../subscription-lookup-config'

const VALID = {
  endpoint: 'https://ai.dcim.com/keys/subscriptions',
  provider: 'dci-marketing',
  scope: 'api://69d75e8e-d602-4538-acad-434c52cf0fca/Gateway.Keys.Read',
  displayName: 'dci Marketing',
  header: 'x-api-key',
}

describe('server.json.subscriptionLookup', () => {
  it('is absent by default', () => {
    expect(parseSubscriptionLookup(undefined)).toBeNull()
    expect(parseSubscriptionLookup(null)).toBeNull()
  })

  it('reads the hosted-instance block with its defaults', () => {
    expect(parseSubscriptionLookup(VALID)).toEqual({
      ...VALID,
      timeoutMs: 15000,
      cacheMaxAgeSeconds: 0,
      requireSelection: false,
    })
  })

  it('lowercases the provider so it matches the engine\'s lowercased ids', () => {
    expect(parseSubscriptionLookup({ ...VALID, provider: 'DCI-Marketing' })?.provider).toBe('dci-marketing')
  })

  it('reads the optional bounds and switches', () => {
    const parsed = parseSubscriptionLookup({ ...VALID, timeoutMs: 5000, cacheMaxAgeSeconds: 3600, requireSelection: true })
    expect(parsed).toMatchObject({ timeoutMs: 5000, cacheMaxAgeSeconds: 3600, requireSelection: true })
  })

  it('ignores a nonsense bound rather than refusing the block', () => {
    expect(parseSubscriptionLookup({ ...VALID, timeoutMs: -1, cacheMaxAgeSeconds: 'soon' })).toMatchObject({ timeoutMs: 15000, cacheMaxAgeSeconds: 0 })
  })

  it.each([
    ['not an object', 'https://x'],
    ['no endpoint', { ...VALID, endpoint: '' }],
    ['no provider', { ...VALID, provider: '' }],
    ['no scope', { ...VALID, scope: '' }],
    ['a non-http endpoint', { ...VALID, endpoint: 'ftp://ai.dcim.com/keys' }],
    ['an endpoint with no host', { ...VALID, endpoint: 'https://' }],
  ])('treats a block with %s as absent, so nothing half-configured runs', (_name, raw) => {
    expect(parseSubscriptionLookup(raw)).toBeNull()
  })
})
