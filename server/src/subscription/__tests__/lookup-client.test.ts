import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import type { ServerSubscriptionLookupConfig } from '../../config/subscription-lookup-config'
import { LOOKUP_CONTRACT, LookupFailure, VERSION_HEADER, decodeResponse, lookupSubscriptions } from '../lookup-client'

const CONFIG: ServerSubscriptionLookupConfig = {
  endpoint: 'https://ai.example.org/keys/subscriptions',
  provider: 'gateway',
  scope: 'api://example/Gateway.Keys.Read',
  displayName: '',
  header: '',
  timeoutMs: 1000,
  cacheMaxAgeSeconds: 0,
  requireSelection: false,
}

const answer = (status: number, body: string): typeof fetch => (async () => new Response(body, { status })) as typeof fetch

describe('decodeResponse', () => {
  it('reads the version 1 shape and ignores extra fields', () => {
    expect(decodeResponse('[{"id":"a","label":"A","key":"k","tier":"gold"}]')).toEqual([{ id: 'a', label: 'A', key: 'k' }])
  })

  it('treats an empty array as no subscriptions, not a failure', () => {
    expect(decodeResponse('[]')).toEqual([])
  })

  it.each([
    ['not json', 'nope'],
    ['not an array', '{"id":"a"}'],
    ['null', 'null'],
    ['a missing key', '[{"id":"a","label":"A"}]'],
    ['a missing label', '[{"id":"a","key":"k"}]'],
    ['a missing id', '[{"label":"A","key":"k"}]'],
    ['a repeated id', '[{"id":"a","label":"A","key":"k"},{"id":"a","label":"B","key":"j"}]'],
  ])('refuses %s', (_name, body) => {
    expect(() => decodeResponse(body)).toThrow(LookupFailure)
  })
})

describe('lookupSubscriptions', () => {
  it('sends the person\'s bearer token and the contract version, and nothing else of theirs', async () => {
    const seen: RequestInit[] = []
    const doFetch = (async (_url: string, init: RequestInit) => { seen.push(init); return new Response('[{"id":"a","label":"A","key":"k"}]') }) as unknown as typeof fetch
    const result = await lookupSubscriptions(CONFIG, 'the-token', doFetch)
    expect(result).toHaveLength(1)
    expect(seen[0].method).toBe('GET')
    const headers = seen[0].headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer the-token')
    expect(headers[VERSION_HEADER]).toBe(LOOKUP_CONTRACT)
    expect(seen[0].body).toBeUndefined()
  })

  it.each([
    [401, /refused this sign-in \(401\)/],
    [403, /not allowed to look up a subscription \(403\)/],
    [502, /status 502/],
  ])('turns status %i into a message a person can act on', async (status, message) => {
    await expect(lookupSubscriptions(CONFIG, 't', answer(status, '{"error":"x"}'))).rejects.toThrow(message)
  })

  it('never copies a response body into the failure', async () => {
    const error = await lookupSubscriptions(CONFIG, 't', answer(500, 'secret-key-material')).catch((e: unknown) => e as LookupFailure)
    expect(error).toBeInstanceOf(LookupFailure)
    expect((error as LookupFailure).message).not.toContain('secret-key-material')
  })

  it('reports an unreachable endpoint and a timeout as such', async () => {
    const unreachable = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    await expect(lookupSubscriptions(CONFIG, 't', unreachable)).rejects.toThrow(/could not be reached/)
    const timedOut = (async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e }) as unknown as typeof fetch
    await expect(lookupSubscriptions(CONFIG, 't', timedOut)).rejects.toThrow(/timed out/)
  })

  it('refuses a body above the size limit', async () => {
    await expect(lookupSubscriptions(CONFIG, 't', answer(200, 'x'.repeat(1024 * 1024 + 1)))).rejects.toThrow(/too large/)
  })
})
