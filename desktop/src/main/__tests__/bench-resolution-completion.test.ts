import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../integration/bench-store', () => ({
  loadWorkspaces: vi.fn(),
  saveWorkspaces: vi.fn(),
}))
vi.mock('../git/operation-state', () => ({ probeOperationState: vi.fn() }))
vi.mock('../git-runner', () => ({ runGit: vi.fn() }))
vi.mock('../git/repositoryManager', () => ({
  repositoryManager: { get: vi.fn(() => ({ queue: { enqueueMutation: (fn: () => Promise<boolean>) => fn() } })) },
}))

import { loadWorkspaces, saveWorkspaces } from '../integration/bench-store'
import { probeOperationState } from '../git/operation-state'
import { runGit } from '../git-runner'
import {
  clearResolvedBenchConflict,
  reconcileCompletedBenchResolution,
} from '../integration/bench-resolution-completion'

const workspaces = vi.mocked(loadWorkspaces)
const save = vi.mocked(saveWorkspaces)
const operation = vi.mocked(probeOperationState)
const git = vi.mocked(runGit)

const failedBench = {
  repoPath: '/repo',
  sourceBranch: 'main',
  benchPath: '/bench',
  benchBranch: 'ion/bench/main',
  baseSha: 'base',
  lastBuiltAt: 1,
  lastAssembly: 'failed' as const,
  lastAssemblyError: 'wt/a conflicted in shared.txt',
  lastAssemblyFailure: 'conflict' as const,
  members: [
    {
      worktreePath: '/wt/a', branchName: 'wt/a', enabled: true,
      pin: 'current' as const, merge: 'conflicted' as const,
      pinnedSha: 'target', pinnedTreeHash: 't', pinnedBaseSha: 'base', currentTreeHash: 't',
      conflictPaths: ['shared.txt'], conflictsWith: ['wt/b'],
      priorResolutions: [{
        path: 'shared.txt', memberBranch: 'wt/a', collidedWith: ['wt/b'], resolvedAt: 1, verified: false, rationale: '',
      }],
    },
    {
      worktreePath: '/wt/b', branchName: 'wt/b', enabled: true,
      pin: 'behind' as const, merge: 'unbuilt' as const,
      pinnedSha: 'other', pinnedTreeHash: 'o', pinnedBaseSha: 'base', currentTreeHash: 'new',
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  workspaces.mockReturnValue([failedBench] as never)
  save.mockReturnValue(true)
  operation.mockResolvedValue({ conflictedPaths: [] })
  git.mockResolvedValue('target\n')
})

describe('clearResolvedBenchConflict', () => {
  it('clears only matched conflict verdict while preserving failure and other member state', () => {
    expect(clearResolvedBenchConflict('/bench', 'target')).toBe(true)

    const persisted = save.mock.calls[0][0][0]
    expect(persisted).toMatchObject({
      lastAssembly: 'failed',
      lastAssemblyError: 'wt/a conflicted in shared.txt',
      lastAssemblyFailure: 'conflict',
    })
    expect(persisted.members[0]).toMatchObject({ pinnedSha: 'target', merge: 'unbuilt', pin: 'current' })
    expect(persisted.members[0].conflictPaths).toBeUndefined()
    expect(persisted.members[0].conflictsWith).toBeUndefined()
    expect(persisted.members[0].priorResolutions).toBeUndefined()
    expect(persisted.members[1]).toEqual(failedBench.members[1])
  })

  it('does not persist when no conflicted member matches exact merge parent', () => {
    expect(clearResolvedBenchConflict('/bench', 'unrelated')).toBe(false)
    expect(save).not.toHaveBeenCalled()
  })
})

describe('reconcileCompletedBenchResolution', () => {
  it('uses completed merge second parent to clear correct row', async () => {
    await expect(reconcileCompletedBenchResolution('/bench')).resolves.toBe(true)
    expect(operation).toHaveBeenCalledWith('/bench')
    expect(git).toHaveBeenCalledWith('/bench', ['rev-parse', 'HEAD^2'])
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('does not clear a row while the auto-fix left a merge open', async () => {
    operation.mockResolvedValue({ state: 'merging', conflictedPaths: ['shared.txt'] })

    await expect(reconcileCompletedBenchResolution('/bench')).resolves.toBe(false)
    expect(git).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('does not clear a row when head has no merge parent', async () => {
    git.mockRejectedValue(new Error('not a merge'))

    await expect(reconcileCompletedBenchResolution('/bench')).resolves.toBe(false)
    expect(save).not.toHaveBeenCalled()
  })
})
