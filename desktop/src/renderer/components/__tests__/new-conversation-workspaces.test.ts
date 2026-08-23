import { describe, expect, it } from 'vitest'
import { filterBranches, filterConversationWorktrees, inventoryEntryToWorktree } from '../new-conversation-workspaces'
import type { WorktreeInventoryEntry } from '../../../shared/types'

const active: WorktreeInventoryEntry = { worktreePath: '/worktrees/feature', branchName: 'wt/feature', label: 'feature', title: 'Feature work', sourceBranch: 'main', head: 'abc', lastCommitSubject: '', isDirty: false, unlandedCommitCount: 0, needsSync: false, safeToDiscard: false }
const landed: WorktreeInventoryEntry = { ...active, worktreePath: '/worktrees/done', branchName: 'wt/done', label: 'done', title: 'Done work', landedAt: 1 }

describe('new conversation workspace helpers', () => {
  it('filters existing worktrees by title, branch, and path while excluding landed rows', () => {
    expect(filterConversationWorktrees([active, landed], '').map((entry) => entry.worktreePath)).toEqual(['/worktrees/feature'])
    expect(filterConversationWorktrees([active], 'feature')).toEqual([active])
    expect(filterConversationWorktrees([active], 'wt/feature')).toEqual([active])
  })

  it('turns an inventory row into creation metadata without guessing source identity', () => {
    expect(inventoryEntryToWorktree('/repo', active)).toEqual({ repoPath: '/repo', worktreePath: '/worktrees/feature', branchName: 'wt/feature', sourceBranch: 'main', landedAt: undefined })
  })

  it('filters branch names case-insensitively', () => {
    expect(filterBranches(['main', 'Release', 'feature/x'], 'rel')).toEqual(['Release'])
  })
})
