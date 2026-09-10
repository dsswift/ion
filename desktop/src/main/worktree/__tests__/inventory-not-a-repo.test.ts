import { describe, it, expect, vi, beforeEach } from 'vitest'

const crawlMock = vi.fn()
vi.mock('../inventory', () => ({ inventoryWorktreesDetailed: (p: string) => crawlMock(p) }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn() }))

import { getWorktreeInventory } from '../inventory-service'
import { _resetInventoryCacheForTests } from '../inventory-cache'

const PLAIN = '/Users/someone'

beforeEach(() => {
  _resetInventoryCacheForTests()
  crawlMock.mockReset()
})

describe('inventory caching for a directory that is not a repository', () => {
  // The defect: a conversation opened in a home directory made the 5s
  // freshness poll spawn `git worktree list` forever. The listing failed with
  // "not a git repository", the result was treated as a failure, nothing was
  // cached, and the next tick tried again -- for a directory that will never
  // become a repository.
  it('crawls once and serves the cached empty answer after that', async () => {
    crawlMock.mockResolvedValue({
      canonicalRepoPath: null,
      aliasPaths: [],
      entries: [],
      notARepository: true,
    })

    expect(await getWorktreeInventory(PLAIN)).toEqual([])
    expect(await getWorktreeInventory(PLAIN)).toEqual([])
    expect(await getWorktreeInventory(PLAIN)).toEqual([])

    expect(crawlMock).toHaveBeenCalledTimes(1)
  })

  // A real failure against something that may be a repository must NOT be
  // cached: git briefly unavailable, a lock held, a permissions blip. Caching
  // the empty answer there would outlive the problem.
  it('does not cache a genuine crawl failure', async () => {
    crawlMock.mockResolvedValue({
      canonicalRepoPath: null,
      aliasPaths: [],
      entries: [],
      notARepository: false,
    })

    await getWorktreeInventory('/some/repo')
    await getWorktreeInventory('/some/repo')

    expect(crawlMock).toHaveBeenCalledTimes(2)
  })
})
