import { beforeEach, describe, expect, it, vi } from 'vitest'

const { analysis, save, capture, workspaces } = vi.hoisted(() => ({
  analysis: {
    repoPath: '/repo', sourceBranch: 'main', basis: 'live' as const, computedAt: 0,
    footprints: [
      { worktreePath: '/repo/new', branchName: 'new', sourceBranch: 'main', baseSha: 'base', tipSha: 'tip', treeHash: 'tree', files: [], enrolled: false, landed: false },
    ], pairs: [], incompletePaths: [], recommendation: { kind: 'exact' as const, orderedPaths: [], alternatives: [], blockers: [], pairScope: [] },
  },
  save: vi.fn(), capture: vi.fn(), workspaces: vi.fn(),
}))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../../git/repositoryManager', () => ({ repositoryManager: { get: () => ({ queue: { enqueueMutation: (work: () => unknown) => work() } }) } }))
vi.mock('../../integration/bench-snapshot', () => ({ captureContribution: (...args: unknown[]) => capture(...args) }))
vi.mock('../../integration/bench-store', () => ({
  loadWorkspaces: () => workspaces(), findWorkspace: (items: Array<{ repoPath: string; sourceBranch: string }>, repoPath: string, sourceBranch: string) => items.find((item) => item.repoPath === repoPath && item.sourceBranch === sourceBranch),
  makeWorkspace: (repoPath: string, sourceBranch: string) => ({ repoPath, sourceBranch, members: [] }),
  makeMember: (member: Record<string, unknown>) => ({ ...member }), saveWorkspaces: (...args: unknown[]) => save(...args),
}))
vi.mock('../overlap-service', () => ({ getWorktreeOverlap: vi.fn(() => analysis), invalidateWorktreeOverlap: vi.fn() }))
vi.mock('../overlap-preview', () => ({ previewWorktreeOverlap: vi.fn(async () => ({ prediction: 'clean', conflictPaths: [] })) }))

import { applyOverlapRecommendation } from '../overlap-apply'

beforeEach(() => {
  vi.clearAllMocks(); workspaces.mockReturnValue([]); save.mockReturnValue(true)
  capture.mockResolvedValue({ sha: 'tip', treeHash: 'tree', baseSha: 'base' })
})

describe('applyOverlapRecommendation', () => {
  it('persists custom ordered selection as durable bench members', async () => {
    await expect(applyOverlapRecommendation({ repoPath: '/repo', sourceBranch: 'main' }, 'live', ['/repo/new'])).resolves.toMatchObject({ ok: true, applied: { newlyEnrolled: 1 } })
    expect(capture).toHaveBeenCalledWith('/repo/new', 'main', 'new')
    expect(save).toHaveBeenCalledWith([expect.objectContaining({ repoPath: '/repo', sourceBranch: 'main', members: [expect.objectContaining({ worktreePath: '/repo/new' })] })])
  })

  it('removes existing members that are not selected', async () => {
    workspaces.mockReturnValue([{
      repoPath: '/repo', sourceBranch: 'main',
      members: [
        { worktreePath: '/repo/new', branchName: 'new', pinnedSha: 'tip', pinnedTreeHash: 'tree', pinnedBaseSha: 'base', currentTreeHash: 'tree', pin: 'current', merge: 'unbuilt' },
        { worktreePath: '/repo/removed', branchName: 'removed', pinnedSha: 'tip', pinnedTreeHash: 'tree', pinnedBaseSha: 'base', currentTreeHash: 'tree', pin: 'current', merge: 'unbuilt' },
      ],
    }])

    await expect(applyOverlapRecommendation({ repoPath: '/repo', sourceBranch: 'main' }, 'live', ['/repo/new'])).resolves.toMatchObject({ ok: true, applied: { newlyEnrolled: 0, removed: 1 } })
    expect(save).toHaveBeenCalledWith([expect.objectContaining({
      members: [expect.objectContaining({ worktreePath: '/repo/new' })],
    })])
  })

  it('reports persistence failure without claiming selection applied', async () => {
    save.mockReturnValue(false)
    await expect(applyOverlapRecommendation({ repoPath: '/repo', sourceBranch: 'main' }, 'live', ['/repo/new'])).resolves.toEqual({ ok: false, error: 'Could not persist bench membership. No selection was applied.' })
  })
})
