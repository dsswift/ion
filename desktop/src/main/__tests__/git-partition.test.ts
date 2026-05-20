import { describe, it, expect } from 'vitest'
import { partitionStatus } from '../git/diffs'

describe('partitionStatus', () => {
  it('groups index / workingTree / untracked / merge correctly', () => {
    const porcelain = [
      'M  staged-modified.ts',
      ' M unstaged-modified.ts',
      'A  staged-added.ts',
      ' D unstaged-deleted.ts',
      '?? new-file.ts',
      'UU conflict.ts',
      'AA both-added.ts',
      'R  oldname.ts -> newname.ts',
    ].join('\n')

    const out = partitionStatus(porcelain)

    expect(out.index.map((f) => f.path)).toEqual(['staged-modified.ts', 'staged-added.ts', 'newname.ts'])
    expect(out.workingTree.map((f) => f.path)).toEqual(['unstaged-modified.ts', 'unstaged-deleted.ts'])
    expect(out.untracked.map((f) => f.path)).toEqual(['new-file.ts'])
    expect(out.merge.map((f) => f.path)).toEqual(['conflict.ts', 'both-added.ts'])
    expect(out.merge[0].conflictKind).toBe('UU')
    expect(out.merge[1].conflictKind).toBe('AA')

    const renamed = out.index.find((f) => f.path === 'newname.ts')
    expect(renamed?.oldPath).toBe('oldname.ts')
  })

  it('emits both index and workingTree entries when both X and Y are dirty', () => {
    const out = partitionStatus('MM file.ts')
    expect(out.index.length).toBe(1)
    expect(out.workingTree.length).toBe(1)
    expect(out.merge.length).toBe(0)
  })
})
