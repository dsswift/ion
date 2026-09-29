import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  subscribeCorpus: vi.fn(async () => ({ revision: 1, roots: [], documents: [] })),
  unsubscribeCorpus: vi.fn(),
}))
vi.mock('./corpus-store', () => ({ subscribeCorpus: deps.subscribeCorpus, unsubscribeCorpus: deps.unsubscribeCorpus }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { _resetCorpusSubscriptionsForTest, heldCorpusReferencesForTest, subscribeCorpusFor, unsubscribeCorpusAll, unsubscribeCorpusFor } from './corpus-subscriptions'

beforeEach(() => {
  _resetCorpusSubscriptionsForTest()
  deps.subscribeCorpus.mockClear()
  deps.unsubscribeCorpus.mockClear()
})

describe('corpus subscriptions per connection', () => {
  it('records each reference a subscriber takes and releases exactly those', async () => {
    await subscribeCorpusFor('c1', '/repo')
    await subscribeCorpusFor('c1', '/repo')
    await subscribeCorpusFor('c2', '/repo')
    expect(deps.subscribeCorpus).toHaveBeenCalledTimes(3)
    expect(heldCorpusReferencesForTest('c1', '/repo')).toBe(2)

    unsubscribeCorpusFor('c1', '/repo')
    expect(deps.unsubscribeCorpus).toHaveBeenCalledTimes(1)
    expect(heldCorpusReferencesForTest('c1', '/repo')).toBe(1)
  })

  it('ignores a release from a subscriber holding nothing, so it cannot drop another connection\'s reference', async () => {
    await subscribeCorpusFor('c1', '/repo')
    unsubscribeCorpusFor('c2', '/repo')
    expect(deps.unsubscribeCorpus).not.toHaveBeenCalled()
    expect(heldCorpusReferencesForTest('c1', '/repo')).toBe(1)
  })

  it('releases every reference a departed subscriber held, across projects, and nothing of anyone else\'s', async () => {
    await subscribeCorpusFor('c1', '/a')
    await subscribeCorpusFor('c1', '/a')
    await subscribeCorpusFor('c1', '/b')
    await subscribeCorpusFor('c2', '/a')

    unsubscribeCorpusAll('c1')
    expect(deps.unsubscribeCorpus.mock.calls.map(([p]) => p).sort()).toEqual(['/a', '/a', '/b'])
    expect(heldCorpusReferencesForTest('c1', '/a')).toBe(0)
    expect(heldCorpusReferencesForTest('c1', '/b')).toBe(0)
    expect(heldCorpusReferencesForTest('c2', '/a')).toBe(1)
  })
})
