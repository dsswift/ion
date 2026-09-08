import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureEgress, flushEgress, _resetEgressForTest, shipToEgress } from '../log-egress'
import type { EgressRecord } from '../log-egress'

describe('source-keyed egress fan-out', () => {
  afterEach(() => {
    _resetEgressForTest()
  })

  it('ships a desktop record to every configured source allowed to ship own records', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: null })
    const originalFetch = global.fetch
    global.fetch = mockFetch as typeof fetch

    const config = {
      egressTargets: ['http'],
      egressEndpoint: 'http://localhost:1',
      egressFlushIntervalMs: 60_000,
    }
    configureEgress(config, async () => ({}), { source: 'engine' })
    configureEgress(config, async () => ({}), { source: 'settings' })

    shipToEgress({
      ts: new Date().toISOString(),
      level: 'INFO',
      msg: 'fanout-test',
      component: 'desktop',
      tag: 'test',
    })
    await flushEgress()
    global.fetch = originalFetch

    expect(mockFetch).toHaveBeenCalledTimes(2)
    for (const [, request] of mockFetch.mock.calls) {
      const body = JSON.parse((request as RequestInit).body as string) as EgressRecord[]
      expect(body[0]?.msg).toBe('fanout-test')
    }
  })
})
