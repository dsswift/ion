import { describe, expect, it } from 'vitest'
import { filterOverlapAnalysis } from './filter-analysis'
import type { WorktreeOverlapAnalysis } from '../../shared/types-worktree-overlap'

const analysis: WorktreeOverlapAnalysis = {
  repoPath: '/repo', sourceBranch: 'main', basis: 'live', computedAt: 0, incompletePaths: ['a'], recommendation: { kind: 'exact', orderedPaths: [], alternatives: [], blockers: [], pairScope: [] },
  footprints: [
    { worktreePath: 'a', branchName: 'a', sourceBranch: 'main', files: [{ path: 'src/a.ts', kind: 'modified', additions: 1, deletions: 0, hunks: [], layers: ['committed'] }], enrolled: false, landed: false },
    { worktreePath: 'b', branchName: 'b', sourceBranch: 'main', files: [{ path: 'docs/b.md', kind: 'modified', additions: 1, deletions: 0, hunks: [], layers: ['committed'] }], enrolled: false, landed: false },
  ],
  pairs: [{ leftPath: 'a', rightPath: 'b', sharedDirectories: [], sharedFiles: [], advisoryFiles: [], ancestry: 'diverged', prediction: 'clean', conflictPaths: [] }],
}

describe('filterOverlapAnalysis', () => {
  it('filters footprints, pairs, and incomplete coverage by changed path', () => {
    const result = filterOverlapAnalysis(analysis, 'SRC/A')!
    expect(result.footprints.map((item) => item.worktreePath)).toEqual(['a'])
    expect(result.pairs).toEqual([])
    expect(result.incompletePaths).toEqual(['a'])
  })
  it('preserves complete analysis when filter is empty', () => {
    expect(filterOverlapAnalysis(analysis, '')).toBe(analysis)
  })
})
