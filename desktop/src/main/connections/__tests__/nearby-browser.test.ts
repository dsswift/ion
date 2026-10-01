import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

const { browseNearby, nearbyFromService } = await import('../nearby-browser')

describe('nearbyFromService', () => {
  it('reads the address and the announced identity, and ignores an announcement with no usable address', () => {
    expect(nearbyFromService({ name: 'Ion Studio (oscar)', host: 'oscar.local.', port: 7331, txt: { label: 'oscar', id: 'env-1', v: '0.1.0' } })).toEqual({ environmentId: 'env-1', label: 'oscar', serverVersion: '0.1.0', host: 'oscar.local', port: 7331, url: 'http://oscar.local:7331' })
    expect(nearbyFromService({ name: 'x', host: 'box.local', port: 7332 })).toMatchObject({ label: 'x', environmentId: '', url: 'http://box.local:7332' })
    expect(nearbyFromService({ name: 'x', port: 7331 })).toBeNull()
    expect(nearbyFromService({ name: 'x', host: 'box.local' })).toBeNull()
  })

  // A publisher announces whatever it calls itself, and a default one uses the
  // machine's bare hostname. Dialling that name reaches nothing, which is what
  // made a found server unpairable: the code was right and the address was not.
  it('dials the announced IP, and restores .local on a bare announced name', () => {
    expect(nearbyFromService({ host: 'mac', port: 7331, addresses: ['fe80::1', '192.168.1.42'], txt: { label: 'work' } }))
      .toMatchObject({ host: 'mac', url: 'http://192.168.1.42:7331' })
    expect(nearbyFromService({ host: 'mac', port: 7331, referer: { address: '192.168.1.43' }, txt: { label: 'work' } }))
      .toMatchObject({ url: 'http://192.168.1.43:7331' })
    expect(nearbyFromService({ host: 'mac', port: 7331, txt: { label: 'work' } }))
      .toMatchObject({ url: 'http://mac.local:7331' })
    // A name that already resolves is left alone.
    expect(nearbyFromService({ host: 'box.local', port: 7331 })).toMatchObject({ url: 'http://box.local:7331' })
  })
})

describe('browseNearby', () => {
  // Bounded on purpose: it answers after its window and stops listening.
  it('answers after its window with each server once, sorted, and stops the browse', async () => {
    vi.useFakeTimers()
    const stop = vi.fn()
    const pending = browseNearby({
      durationMs: 1000,
      browse: (onService) => {
        onService({ host: 'zed.local', port: 7331, txt: { label: 'zed', id: 'env-z' } })
        onService({ host: 'oscar.local', port: 7331, txt: { label: 'oscar', id: 'env-g' } })
        onService({ host: 'oscar.local', port: 7331, txt: { label: 'oscar', id: 'env-g' } })
        onService({ name: 'broken' })
        return stop
      },
    })
    vi.advanceTimersByTime(1001)
    const rows = await pending
    expect(rows.map((r) => r.label)).toEqual(['oscar', 'zed'])
    expect(stop).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('answers empty when the browse cannot start', async () => {
    await expect(browseNearby({ durationMs: 10, browse: () => { throw new Error('no mdns') } })).resolves.toEqual([])
  })
})
