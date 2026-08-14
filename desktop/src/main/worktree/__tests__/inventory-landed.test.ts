/**
 * Pins: the inventory short-circuits expensive git probes (status, appraiseRefPair)
 * for worktrees whose `landedAt` is set, reporting known-terminal values instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../git-runner', () => ({ runGit: vi.fn() }))
vi.mock('../inventory-appraise', () => ({
  appraiseRefPair: vi.fn(),
  commitSubject: vi.fn(async () => 'feat: some commit'),
  pruneAppraisalCache: vi.fn(),
}))
vi.mock('../provision-state', () => ({ getProvisionState: vi.fn(() => undefined) }))
vi.mock('../../git/operation-state', () => ({
  probeOperationState: vi.fn(async () => ({ state: undefined, branch: undefined, conflictedPaths: [] })),
}))
vi.mock('../registry', () => ({
  lookupSourceBranch: vi.fn(),
  lookupWorktreeTitle: vi.fn(),
  lookupWorktreeLandedAt: vi.fn(),
  lookupWorktreeStage: vi.fn(),
}))

import { runGit } from '../../git-runner'
import { appraiseRefPair } from '../inventory-appraise'
import { lookupWorktreeLandedAt, lookupSourceBranch, lookupWorktreeTitle, lookupWorktreeStage } from '../registry'
import { inventoryWorktrees } from '../inventory'

const runGitMock = vi.mocked(runGit)
const appraiseMock = vi.mocked(appraiseRefPair)
const landedAtMock = vi.mocked(lookupWorktreeLandedAt)

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(lookupSourceBranch).mockReturnValue('main')
  vi.mocked(lookupWorktreeTitle).mockReturnValue(null)
  vi.mocked(lookupWorktreeStage).mockReturnValue(null)
})

const WORKTREE_LIST =
  'worktree /repo\nHEAD abc1234567890\nbranch refs/heads/main\n\n' +
  'worktree /repo/.ion/worktrees/wt-1\nHEAD def5678901234\nbranch refs/heads/feat/foo\n\n'

describe('inventory landed short-circuit', () => {
  it('skips git status and appraisal for landed worktrees', async () => {
    landedAtMock.mockReturnValue(1700000000000)

    runGitMock
      .mockResolvedValueOnce(WORKTREE_LIST)
      .mockResolvedValueOnce('main abc1234567890')

    const entries = await inventoryWorktrees('/repo')

    expect(entries).toHaveLength(1)
    expect(entries[0].safeToDiscard).toBe(true)
    expect(entries[0].landedAt).toBe(1700000000000)
    expect(entries[0].isDirty).toBe(false)
    expect(entries[0].unlandedCommitCount).toBe(0)
    expect(entries[0].needsSync).toBe(false)

    expect(appraiseMock).not.toHaveBeenCalled()
    const statusCalls = runGitMock.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1][0] === 'status',
    )
    expect(statusCalls).toHaveLength(0)
  })

  it('runs git status and appraisal for non-landed worktrees', async () => {
    landedAtMock.mockReturnValue(null)
    appraiseMock.mockResolvedValue({ ahead: 2, behind: 1, treesDiffer: true })

    runGitMock
      .mockResolvedValueOnce(WORKTREE_LIST)
      .mockResolvedValueOnce('main abc1234567890')
      .mockResolvedValueOnce('M  some-file.ts')

    const entries = await inventoryWorktrees('/repo')

    expect(entries).toHaveLength(1)
    expect(entries[0].isDirty).toBe(true)
    expect(entries[0].unlandedCommitCount).toBe(2)
    expect(entries[0].needsSync).toBe(true)
    expect(entries[0].safeToDiscard).toBe(false)

    expect(appraiseMock).toHaveBeenCalledOnce()
    const statusCalls = runGitMock.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1][0] === 'status',
    )
    expect(statusCalls).toHaveLength(1)
  })
})
