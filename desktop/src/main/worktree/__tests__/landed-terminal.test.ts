/**
 * Pins the terminal-state contract: once a worktree is landed, land and sync
 * refuse to operate, and inventory short-circuits expensive git probes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (before imports) ──────────────────────────────────────────────────

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../git-runner', () => ({ runGit: vi.fn() }))
vi.mock('../../git/repositoryManager', () => ({
  repositoryManager: { get: vi.fn(() => ({ queue: { enqueueMutation: (fn: () => unknown) => fn() } })) },
}))
vi.mock('../inventory', () => ({
  lookupWorktreeLandedAt: vi.fn(),
  markWorktreeLanded: vi.fn(),
  lookupSourceBranch: vi.fn(),
  lookupWorktreeTitle: vi.fn(),
  lookupWorktreeStage: vi.fn(),
}))
vi.mock('../../integration/bench-ops', () => ({
  disenrollWorktree: vi.fn(() => ({ removedFrom: 0, prunedBenches: [] })),
}))
vi.mock('../inventory-appraise', () => ({
  appraiseRefPair: vi.fn(),
  commitSubject: vi.fn(async () => 'subject'),
  pruneAppraisalCache: vi.fn(),
}))
vi.mock('../provision-state', () => ({ getProvisionState: vi.fn(() => undefined) }))
vi.mock('../../git/operation-state', () => ({
  probeOperationState: vi.fn(async () => ({ state: undefined, branch: undefined, conflictedPaths: [] })),
  unmergedPaths: vi.fn(async () => []),
}))
vi.mock('../registry', () => ({
  lookupSourceBranch: vi.fn(),
  lookupWorktreeTitle: vi.fn(),
  lookupWorktreeLandedAt: vi.fn(),
  lookupWorktreeStage: vi.fn(),
}))
vi.mock('../../git/rerere', () => ({ ensureRerereEnabled: vi.fn() }))
vi.mock('../../git/untracked-obstruction', () => ({ retryAfterClearingBlockingUntracked: vi.fn() }))
vi.mock('../base-repair', () => ({ repairStaleBase: vi.fn() }))
vi.mock('../patch-identity', () => ({ computeReplayPlan: vi.fn() }))
vi.mock('../inventory-cache', () => ({ invalidateWorktreeInventoryCache: vi.fn() }))

import { lookupWorktreeLandedAt } from '../inventory'
import { runGit } from '../../git-runner'
import { landWorktreeUnqueued } from '../integrate'
import { syncWorktreeFromSource } from '../sync'
const landedAtMock = vi.mocked(lookupWorktreeLandedAt)
const runGitMock = vi.mocked(runGit)

beforeEach(() => {
  vi.resetAllMocks()
})

describe('land: terminal guard', () => {
  it('refuses when worktree is already landed', async () => {
    landedAtMock.mockReturnValue(1700000000000)

    const result = await landWorktreeUnqueued({
      repoPath: '/repo',
      worktreePath: '/repo/.ion/worktrees/wt-1',
      worktreeBranch: 'feat/foo',
      sourceBranch: 'main',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('already been landed')
    expect(result.error).toContain('terminal')
    expect(runGitMock).not.toHaveBeenCalled()
  })

  it('proceeds when worktree is not landed', async () => {
    landedAtMock.mockReturnValue(null)
    runGitMock.mockResolvedValueOnce('M  dirty-file.ts')

    const result = await landWorktreeUnqueued({
      repoPath: '/repo',
      worktreePath: '/repo/.ion/worktrees/wt-1',
      worktreeBranch: 'feat/foo',
      sourceBranch: 'main',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Commit')
    expect(runGitMock).toHaveBeenCalled()
  })
})

describe('sync: terminal guard', () => {
  it('refuses when worktree is already landed', async () => {
    // sync imports from ./inventory which re-exports from ./registry
    // Need to mock the sync module's import path
    const { lookupWorktreeLandedAt: syncLandedAt } = await import('../inventory')
    vi.mocked(syncLandedAt).mockReturnValue(1700000000000)

    const result = await syncWorktreeFromSource('/repo/.ion/worktrees/wt-1', 'main')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('already been landed')
    expect(runGitMock).not.toHaveBeenCalled()
  })

  it('proceeds to dirty check when worktree is not landed', async () => {
    const { lookupWorktreeLandedAt: syncLandedAt } = await import('../inventory')
    vi.mocked(syncLandedAt).mockReturnValue(null)
    runGitMock.mockResolvedValueOnce('M  dirty-file.ts')

    const result = await syncWorktreeFromSource('/repo/.ion/worktrees/wt-1', 'main')

    expect(result.ok).toBe(false)
    expect(result.refusedDirty).toBe(true)
    expect(runGitMock).toHaveBeenCalled()
  })
})
