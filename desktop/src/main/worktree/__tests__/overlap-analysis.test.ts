import { describe, expect, it } from 'vitest'
import { intersectsHunk, overlapPair } from '../overlap-analysis'
import type { WorktreeFootprint } from '../../../shared/types-worktree-overlap'

function footprint(path: string, start: number): WorktreeFootprint {
  return { worktreePath: path, branchName: path, sourceBranch: 'main', files: [{ path: 'src/a.ts', kind: 'modified', additions: 1, deletions: 1, hunks: [{ start, end: start + 1 }], layers: ['committed'] }], enrolled: false, landed: false }
}

describe('worktree overlap analysis', () => {
  it('distinguishes shared file from same hunk overlap', () => {
    const left = footprint('/left', 4)
    const right = footprint('/right', 20)
    const same = footprint('/same', 5)
    expect(intersectsHunk(left.files[0], right.files[0])).toBe(false)
    expect(overlapPair(left, right).sharedFiles[0]).toMatchObject({ path: 'src/a.ts', sameHunk: false })
    expect(intersectsHunk(left.files[0], same.files[0])).toBe(true)
  })
})
