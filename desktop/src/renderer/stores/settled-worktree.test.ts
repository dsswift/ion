import { describe, expect, it } from 'vitest'
import type { TabState } from '../../shared/types'
import { settledRecordRestorableFromInventory } from './settled-worktree'

function tab(worktree: TabState['worktree'], tabRole: TabState['tabRole'] = null): TabState {
  return { id: 'settled', worktree, tabRole } as TabState
}

describe('settled worktree availability', () => {
  it('keeps plain settled conversations restorable', () => {
    expect(settledRecordRestorableFromInventory(tab(null), new Map())).toBe(true)
  })

  it('keeps the action available until inventory is ready', () => {
    const record = tab({ repoPath: '/repo', worktreePath: '/worktree', branchName: 'wt/test', sourceBranch: 'main' })
    expect(settledRecordRestorableFromInventory(record, new Map())).toBe(true)
  })

  it('makes a settled record permanent when its worktree is absent', () => {
    const record = tab({ repoPath: '/repo', worktreePath: '/worktree', branchName: 'wt/test', sourceBranch: 'main' })
    expect(settledRecordRestorableFromInventory(record, new Map([['/repo', []]]))).toBe(false)
  })
})

/**
 * An ephemeral role settles permanently. A bench conversation's checkout is
 * rebuilt from its members' pins, and a machine conversation was never typeable,
 * so neither can return to active work — regardless of what the filesystem or
 * the inventory says.
 */
describe('settled permanence by role', () => {
  const roles = ['bench-conversation', 'conflict-auto-fix', 'verification-analysis'] as const

  for (const role of roles) {
    it(`makes a settled ${role} permanent even with no worktree`, () => {
      expect(settledRecordRestorableFromInventory(tab(null, role), new Map())).toBe(false)
    })

    it(`makes a settled ${role} permanent even while its worktree is present`, () => {
      const record = tab({ repoPath: '/repo', worktreePath: '/worktree', branchName: 'wt/test', sourceBranch: 'main' }, role)
      expect(settledRecordRestorableFromInventory(record, new Map([['/repo', [{ worktreePath: '/worktree' }]]]))).toBe(false)
    })
  }

  it('leaves an ordinary conversation restorable', () => {
    expect(settledRecordRestorableFromInventory(tab(null, null), new Map())).toBe(true)
  })
})
