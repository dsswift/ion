import { describe, expect, it } from 'vitest'
import { groupInboxTabs, inboxProjectFor } from './inbox-grouping'
import type { TabState, WorktreeInventoryEntry } from '../../../shared/types'

function tab(overrides: Partial<TabState>): TabState {
  return {
    id: 'tab', workingDirectory: '/repo', worktree: null, ...overrides,
  } as TabState
}

describe('inbox grouping', () => {
  it('uses a friendly worktree title before the generated directory label', () => {
    const repo = '/source/ion'
    const path = '/Users/test/.ion/worktrees/ion-6d15c16e'
    const inventory = new Map<string, readonly WorktreeInventoryEntry[]>([[repo, [{
      worktreePath: path, branchName: 'wt/ion-6d15c16e', label: 'ion-6d15c16e', title: 'Inbox enhancements',
    } as WorktreeInventoryEntry]]])
    const groups = groupInboxTabs([
      tab({ workingDirectory: path, worktree: { repoPath: repo, worktreePath: path, branchName: 'wt/ion-6d15c16e', sourceBranch: 'josh' } }),
    ], new Map(), inventory)
    expect(groups[0]!.worktrees[0]!.worktree.label).toBe('Inbox enhancements')
    expect(groups[0]!.worktrees[0]!.worktree.hash).toBe('6d15c16e')
  })


  it('uses the inventory label and then the branch as worktree fallbacks', () => {
    const repo = '/source/ion'
    const path = '/Users/test/.ion/worktrees/ion-fallback'
    const worktree = { repoPath: repo, worktreePath: path, branchName: 'wt/fallback', sourceBranch: 'main' }

    const labeled = groupInboxTabs([tab({ workingDirectory: path, worktree })], new Map(), new Map([[repo, [{ ...worktree, label: 'Friendly label', head: '', lastCommitSubject: '', isDirty: false, unlandedCommitCount: 0, needsSync: false, safeToDiscard: false }]]]))
    const branched = groupInboxTabs([tab({ workingDirectory: path, worktree })], new Map(), new Map())

    expect(labeled[0]!.worktrees[0]!.worktree.label).toBe('Friendly label')
    expect(branched[0]!.worktrees[0]!.worktree.label).toBe('wt/fallback')
  })
  it('collapses worktrees and integration benches into their source repository', () => {
    const repo = '/source/ion'
    const benches = new Map([[repo, [{ repoPath: repo, sourceBranch: 'josh', benchPath: '/Users/test/.ion/integration/ion-josh', benchBranch: 'ion/bench/josh', members: [], baseSha: '', lastBuiltAt: 0 }]]])
    const groups = groupInboxTabs([
      tab({ id: 'source', workingDirectory: repo }),
      tab({ id: 'worktree', workingDirectory: '/Users/test/.ion/worktrees/ion-abcd', worktree: { repoPath: repo, worktreePath: '/Users/test/.ion/worktrees/ion-abcd', branchName: 'wt/ion-abcd', sourceBranch: 'josh' } }),
      tab({ id: 'bench', workingDirectory: '/Users/test/.ion/integration/ion-josh' }),
    ], benches)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.project.name).toBe('ion')
    expect(groups[0]!.worktrees).toHaveLength(3)
    expect(inboxProjectFor(groups[0]!.worktrees[1]!.tabs[0]!, benches).key).toBe(repo)
  })
})
