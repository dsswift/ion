/**
 * Pins the coalescing contract that was missing when overlapping inventory
 * crawls froze the overlay: concurrent readers share ONE crawl, all checkout
 * paths of a repo share one cache entry, mutations bust the cache, and a
 * failed listing is never re-served.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../inventory', () => ({ inventoryWorktreesDetailed: vi.fn() }))

import { inventoryWorktreesDetailed, type WorktreeInventoryResult } from '../inventory'
import { getWorktreeInventory } from '../inventory-service'
import { invalidateWorktreeInventoryCache, _resetInventoryCacheForTests } from '../inventory-cache'
import type { WorktreeInventoryEntry } from '../../../shared/types'

const crawlMock = vi.mocked(inventoryWorktreesDetailed)

function entry(path: string): WorktreeInventoryEntry {
  return {
    worktreePath: path,
    branchName: `wt/${path.split('/').pop()}`,
    label: path.split('/').pop() ?? path,
    sourceBranch: 'main',
    head: 'abc1234',
    lastCommitSubject: 'subject',
    isDirty: false,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: true,
  }
}

function result(canonical: string, aliases: string[], paths: string[]): WorktreeInventoryResult {
  return { canonicalRepoPath: canonical, aliasPaths: aliases, entries: paths.map(entry) }
}

beforeEach(() => {
  _resetInventoryCacheForTests()
  crawlMock.mockReset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getWorktreeInventory', () => {
  it('coalesces concurrent requests for one repo into a single crawl', async () => {
    let release!: (r: WorktreeInventoryResult) => void
    crawlMock.mockImplementation(() => new Promise((resolve) => { release = resolve }))

    const a = getWorktreeInventory('/repo')
    const b = getWorktreeInventory('/repo')
    release(result('/repo', ['/repo', '/wt1'], ['/wt1']))

    const [ra, rb] = await Promise.all([a, b])
    expect(crawlMock).toHaveBeenCalledTimes(1)
    expect(ra).toBe(rb)
  })

  it('serves any checkout path of the repo from one cache entry once aliases are learned', async () => {
    crawlMock.mockResolvedValue(result('/main', ['/main', '/wt1', '/wt2'], ['/wt1', '/wt2']))
    await getWorktreeInventory('/main')

    // Distinct repoPath arguments — the exact shape the directory picker
    // produces (one per open worktree tab) — must not crawl again.
    await getWorktreeInventory('/wt1')
    await getWorktreeInventory('/wt2')
    await getWorktreeInventory('/main')
    expect(crawlMock).toHaveBeenCalledTimes(1)
  })

  it('re-crawls after the TTL expires', async () => {
    crawlMock.mockResolvedValue(result('/main', ['/main'], ['/wt1']))
    await getWorktreeInventory('/main')
    vi.advanceTimersByTime(6000)
    await getWorktreeInventory('/main')
    expect(crawlMock).toHaveBeenCalledTimes(2)
  })

  it('re-crawls immediately after invalidation, ignoring the TTL', async () => {
    crawlMock.mockResolvedValue(result('/main', ['/main'], ['/wt1']))
    await getWorktreeInventory('/main')
    invalidateWorktreeInventoryCache('test mutation')
    await getWorktreeInventory('/main')
    expect(crawlMock).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed listing', async () => {
    crawlMock.mockResolvedValueOnce({ canonicalRepoPath: null, aliasPaths: [], entries: [] })
    expect(await getWorktreeInventory('/broken')).toEqual([])

    // A repo that recovers must be re-crawled, not served the empty failure.
    crawlMock.mockResolvedValueOnce(result('/broken', ['/broken'], ['/wt1']))
    expect(await getWorktreeInventory('/broken')).toHaveLength(1)
    expect(crawlMock).toHaveBeenCalledTimes(2)
  })

  it('starts a fresh crawl for a caller that arrives after the flight resolved', async () => {
    crawlMock.mockResolvedValue(result('/main', ['/main'], ['/wt1']))
    await getWorktreeInventory('/main')
    vi.advanceTimersByTime(6000)
    await getWorktreeInventory('/main')
    vi.advanceTimersByTime(6000)
    await getWorktreeInventory('/main')
    expect(crawlMock).toHaveBeenCalledTimes(3)
  })
})
