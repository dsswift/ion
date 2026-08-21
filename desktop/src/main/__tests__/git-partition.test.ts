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

  it('preserves spaces and punctuation from NUL-delimited porcelain paths', () => {
    const out = partitionStatus([
      '?? ui-mockups/Ion Landing Directions.dc.html',
      ' M ui-mockups/copy "final".html',
      'R  ui-mockups/new name.html',
      'ui-mockups/old name.html',
      '',
    ].join('\0'))

    expect(out.untracked.map((f) => f.path)).toEqual(['ui-mockups/Ion Landing Directions.dc.html'])
    expect(out.workingTree.map((f) => f.path)).toEqual(['ui-mockups/copy "final".html'])
    expect(out.index).toContainEqual({
      path: 'ui-mockups/new name.html',
      oldPath: 'ui-mockups/old name.html',
      status: 'renamed',
      staged: true,
    })
  })

  it('preserves arbitrary NUL-delimited paths and rename source paths', () => {
    // `git status --porcelain=v1 -z` emits rename destination first, then its
    // source as a second NUL-delimited record. Newlines are valid path bytes,
    // so line-based parsing would split this one file into fake entries.
    const out = partitionStatus([
      'R  renamed\nfile.ts',
      'original\nfile.ts',
      '?? untracked\nfile.ts',
      '',
    ].join('\0'))

    expect(out.index).toEqual([
      expect.objectContaining({
        path: 'renamed\nfile.ts',
        oldPath: 'original\nfile.ts',
        status: 'renamed',
        staged: true,
      }),
    ])
    expect(out.untracked).toEqual([
      expect.objectContaining({
        path: 'untracked\nfile.ts',
        status: 'untracked',
        staged: false,
      }),
    ])
  })

  it('emits both index and workingTree entries when both X and Y are dirty', () => {
    const out = partitionStatus('MM file.ts')
    expect(out.index.length).toBe(1)
    expect(out.workingTree.length).toBe(1)
    expect(out.merge.length).toBe(0)
  })
})
