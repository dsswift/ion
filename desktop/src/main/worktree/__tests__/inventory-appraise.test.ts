/**
 * Pins the sha-keyed appraisal cache: a (HEAD, tip) pair that has not moved
 * costs zero git spawns, a moved sha recomputes, and a failure is answered
 * conservatively and never cached.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../git-runner', () => ({ runGit: vi.fn() }))

import { runGit } from '../../git-runner'
import {
  appraiseRefPair, commitSubject, pruneAppraisalCache,
  _resetAppraisalCacheForTests, type AppraisalCounters,
} from '../inventory-appraise'

const runGitMock = vi.mocked(runGit)

const HEAD = 'a'.repeat(40)
const TIP = 'b'.repeat(40)
const OTHER = 'c'.repeat(40)

beforeEach(() => {
  _resetAppraisalCacheForTests()
  runGitMock.mockReset()
})

describe('appraiseRefPair', () => {
  it('computes ahead/behind from one rev-list spawn when not behind', async () => {
    runGitMock.mockResolvedValueOnce('0\t3\n')
    const pair = await appraiseRefPair('/wt', HEAD, TIP)
    expect(pair).toEqual({ ahead: 3, behind: 0, treesDiffer: false })
    // behind === 0 → the tree-comparison spawn must not run.
    expect(runGitMock).toHaveBeenCalledTimes(1)
    expect(runGitMock.mock.calls[0][1]).toEqual([
      'rev-list', '--left-right', '--count', `${TIP}...${HEAD}`,
    ])
  })

  it('compares trees only when behind, and reports whether a sync would change content', async () => {
    runGitMock
      .mockResolvedValueOnce('2\t0\n')
      .mockResolvedValueOnce('tree-a\ntree-b\n')
    const pair = await appraiseRefPair('/wt', HEAD, TIP)
    expect(pair).toEqual({ ahead: 0, behind: 2, treesDiffer: true })

    _resetAppraisalCacheForTests()
    runGitMock.mockReset()
    runGitMock
      .mockResolvedValueOnce('1\t0\n')
      .mockResolvedValueOnce('same-tree\nsame-tree\n')
    // Behind but identical trees: its own work just landed — sync gains nothing.
    expect(await appraiseRefPair('/wt', HEAD, TIP)).toEqual({ ahead: 0, behind: 1, treesDiffer: false })
  })

  it('serves an unchanged sha pair from cache with zero spawns', async () => {
    runGitMock.mockResolvedValueOnce('0\t1\n')
    const counters: AppraisalCounters = { hits: 0, misses: 0 }
    await appraiseRefPair('/wt', HEAD, TIP, counters)
    const again = await appraiseRefPair('/wt', HEAD, TIP, counters)
    expect(again).toEqual({ ahead: 1, behind: 0, treesDiffer: false })
    expect(runGitMock).toHaveBeenCalledTimes(1)
    expect(counters).toEqual({ hits: 1, misses: 1 })
  })

  it('recomputes when either sha moves', async () => {
    runGitMock.mockResolvedValue('0\t1\n')
    await appraiseRefPair('/wt', HEAD, TIP)
    await appraiseRefPair('/wt', OTHER, TIP)
    await appraiseRefPair('/wt', OTHER, HEAD)
    expect(runGitMock).toHaveBeenCalledTimes(3)
  })

  it('returns null on git failure and does not cache the failure', async () => {
    runGitMock.mockRejectedValueOnce(new Error('bad object'))
    expect(await appraiseRefPair('/wt', HEAD, TIP)).toBeNull()

    runGitMock.mockResolvedValueOnce('0\t0\n')
    // The retry reaches git again instead of being served a cached null.
    expect(await appraiseRefPair('/wt', HEAD, TIP)).toEqual({ ahead: 0, behind: 0, treesDiffer: false })
  })

  it('returns null on unparseable rev-list output', async () => {
    runGitMock.mockResolvedValueOnce('not-a-count\n')
    expect(await appraiseRefPair('/wt', HEAD, TIP)).toBeNull()
  })

  it('drops pruned paths so a retired worktree cannot pin stale state', async () => {
    runGitMock.mockResolvedValue('0\t1\n')
    await appraiseRefPair('/wt', HEAD, TIP)
    pruneAppraisalCache(new Set(['/other-wt']))
    await appraiseRefPair('/wt', HEAD, TIP)
    expect(runGitMock).toHaveBeenCalledTimes(2)
  })
})

describe('commitSubject', () => {
  it('caches the subject under its sha', async () => {
    runGitMock.mockResolvedValueOnce('fix: the thing\n')
    expect(await commitSubject('/wt', HEAD)).toBe('fix: the thing')
    expect(await commitSubject('/other-checkout', HEAD)).toBe('fix: the thing')
    expect(runGitMock).toHaveBeenCalledTimes(1)
  })

  it('degrades to empty string on failure without caching it', async () => {
    runGitMock.mockRejectedValueOnce(new Error('unknown revision'))
    expect(await commitSubject('/wt', HEAD)).toBe('')
    runGitMock.mockResolvedValueOnce('recovered\n')
    expect(await commitSubject('/wt', HEAD)).toBe('recovered')
  })
})
