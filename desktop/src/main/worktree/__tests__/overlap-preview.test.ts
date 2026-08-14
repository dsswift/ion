import { describe, expect, it, vi } from 'vitest'

vi.mock('../../git-runner', () => ({ runGit: vi.fn() }))
vi.mock('../../integration/merge-tree', () => ({ mergeTree: vi.fn() }))

import { runGit } from '../../git-runner'
import { mergeTree } from '../../integration/merge-tree'
import { previewWorktreeOverlap } from '../overlap-preview'
import type { WorktreeOverlapAnalysis } from '../../../shared/types-worktree-overlap'

const analysis: WorktreeOverlapAnalysis = {
  repoPath: '/repo', sourceBranch: 'main', basis: 'live', computedAt: 0,
  footprints: [{ worktreePath: '/repo/a', branchName: 'a', sourceBranch: 'main', baseSha: 'base', tipSha: 'tip-a', treeHash: 'tree-a', files: [], enrolled: false, landed: false }],
  pairs: [], incompletePaths: [], recommendation: { kind: 'exact', orderedPaths: [], alternatives: [], blockers: [], pairScope: [] },
}

describe('previewWorktreeOverlap', () => {
  it('rejects duplicate paths before creating synthetic commits', async () => {
    const preview = await previewWorktreeOverlap(analysis, ['/repo/a', '/repo/a'])
    expect(preview).toMatchObject({ prediction: 'unavailable', error: 'Each selected worktree may appear only once.' })
    expect(runGit).not.toHaveBeenCalled()
    expect(mergeTree).not.toHaveBeenCalled()
  })
})
