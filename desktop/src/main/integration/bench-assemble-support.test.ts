import { describe, it, expect } from 'vitest'
import { classifyMergeFailure } from '../integration/bench-assemble-support'

describe('classifyMergeFailure', () => {
  // The regression this pins: BEFORE the fix, a zero-paths failure produced
  // the bare fallback `"<branch> could not be merged. The bench is empty
  // until this is resolved."` — discarding the actual git error entirely.
  // This test fails if the message reverts to that bare fallback.
  it('classifies a zero-unmerged-paths failure as obstructed and surfaces the real git error verbatim', () => {
    const gitError = 'error: The following untracked working tree files would be overwritten by merge:\n'
      + '\tdesktop/src/main/worktree/sync.ts\n'
      + 'Please move or remove them before you merge.\n'
      + 'Aborting\n'
      + 'Merge with strategy ort failed.'

    const result = classifyMergeFailure('wt/ion-351c7dd4', [], [], gitError)

    expect(result.failureKind).toBe('obstructed')
    expect(result.failureError).toContain('wt/ion-351c7dd4')
    expect(result.failureError).toContain('would be overwritten by merge')
    expect(result.failureError).toContain('desktop/src/main/worktree/sync.ts')
    // Never the bare, detail-free fallback this replaced.
    expect(result.failureError).not.toBe(
      'wt/ion-351c7dd4 could not be merged. The bench is empty until this is resolved.',
    )
  })

  // The structural signal: at least one unmerged path is what makes it a
  // genuine content conflict, never a guess based on matching error text.
  it('classifies a merge failure with at least one unmerged path as a conflict', () => {
    const result = classifyMergeFailure('wt/a', ['shared.txt'], ['wt/b'], 'CONFLICT (content): Merge conflict in shared.txt')

    expect(result.failureKind).toBe('conflict')
    expect(result.failureError).toContain('wt/a')
    expect(result.failureError).toContain('conflicts on 1 file')
    expect(result.failureError).toContain('wt/b')
  })

  it('pluralizes the file count correctly', () => {
    const result = classifyMergeFailure('wt/a', ['a.txt', 'b.txt'], [], 'error')
    expect(result.failureError).toContain('conflicts on 2 files')
  })

  it('omits the "with <branches>" clause when nothing collided', () => {
    const result = classifyMergeFailure('wt/a', ['a.txt'], [], 'error')
    expect(result.failureError).not.toContain(' with ')
  })
})
