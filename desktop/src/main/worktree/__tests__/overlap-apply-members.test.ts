import { describe, expect, it } from 'vitest'
import { applyRecommendationMembers } from '../overlap-apply-members'
import { validateOverlapApplySelection } from '../overlap-apply'
import type { WorktreeOverlapAnalysis } from '../../../shared/types-worktree-overlap'

function member(path: string, enabled = true) {
  return { worktreePath: path, branchName: path, enabled, pinnedSha: path, pinnedTreeHash: path, pinnedBaseSha: 'base', currentTreeHash: path, pin: 'current' as const, merge: 'unbuilt' as const }
}

describe('applyRecommendationMembers', () => {
  it('enables fast lane, disables remainder, and persists one ordered member list', () => {
    const result = applyRecommendationMembers([member('a'), member('b'), member('c', false)], ['c', 'a'], [])
    expect(result.members.map((item) => [item.worktreePath, item.enabled])).toEqual([['c', true], ['a', true], ['b', false]])
    expect(result).toMatchObject({ enabled: 1, disabled: 1, reordered: 3 })
  })
  it('rejects duplicate selected paths rather than persisting duplicate members', () => {
    expect(() => applyRecommendationMembers([member('a')], ['a', 'a'], [])).toThrow('Duplicate worktree paths')
  })
  it('rejects duplicate members and unavailable selected paths', () => {
    expect(() => applyRecommendationMembers([member('a')], ['a'], [member('a')])).toThrow('Duplicate worktree members')
    expect(() => applyRecommendationMembers([], ['missing'], [])).toThrow('Selected worktree member is unavailable')
  })
  it('merges newly enrolled selections before disabled remainder', () => {
    const result = applyRecommendationMembers([member('old')], ['new', 'old'], [member('new')])
    expect(result.members.map((item) => [item.worktreePath, item.enabled])).toEqual([['new', true], ['old', true]])
  })
  it.each([
    [[member('a'), member('a')], ['a'], [], 'Duplicate worktree members'],
    [[member('a')], ['a'], [member('a')], 'Duplicate worktree members'],
    [[member('a')], ['a'], [member('b'), member('b')], 'Duplicate worktree members'],
    [[member('a')], ['missing'], [], 'Selected worktree member is unavailable'],
  ])('rejects non-durable membership %j', (existing, paths, additions, error) => {
    expect(() => applyRecommendationMembers(existing, paths, additions)).toThrow(error)
  })
})

describe('validateOverlapApplySelection', () => {
  const analysis: WorktreeOverlapAnalysis = {
    repoPath: '/repo', sourceBranch: 'main', basis: 'live', computedAt: 0,
    footprints: [{ worktreePath: 'a', branchName: 'a', sourceBranch: 'main', baseSha: 'base', tipSha: 'tip', treeHash: 'tree', files: [], enrolled: false, landed: false }],
    pairs: [], incompletePaths: [], recommendation: { kind: 'exact', orderedPaths: [], alternatives: [], blockers: [], pairScope: [] },
  }
  it.each([
    [[], 'at least one'],
    [['a', 'a'], 'only once'],
    [['missing'], 'no longer available'],
  ])('rejects invalid selection %j', (paths, message) => {
    expect(validateOverlapApplySelection(analysis, paths)).toContain(message)
  })
  it.each([
    [{ landed: true }, 'landed'],
    [{ incompleteReason: 'crawl failed' }, 'incomplete'],
    [{ tipSha: undefined }, 'missing tip'],
    [{ treeHash: undefined }, 'missing tree'],
    [{ baseSha: undefined }, 'missing base'],
    [{ baseSha: 'tip' }, 'empty contribution'],
  ])('rejects ineligible footprint %j', (changes, _reason: string) => {
    expect(validateOverlapApplySelection({ ...analysis, footprints: [{ ...analysis.footprints[0], ...changes }] }, ['a'])).toContain('no eligible')
  })
})
