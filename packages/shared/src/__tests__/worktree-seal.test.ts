import { describe, expect, it } from 'vitest'
import { isWorktreeSealed, isTabWorktreeSealed } from '../worktree-seal'

describe('worktree seal', () => {
  it('seals on landed, and on nothing else', () => {
    expect(isWorktreeSealed({})).toBe(false)
    expect(isWorktreeSealed({ landedAt: 1 })).toBe(true)
    expect(isWorktreeSealed(null)).toBe(false)
  })

  it('a tab is sealed by its worktree landing, never without a worktree', () => {
    expect(isTabWorktreeSealed({ worktree: null })).toBe(false)
    expect(isTabWorktreeSealed({ worktree: { landedAt: null } })).toBe(false)
    expect(isTabWorktreeSealed({ worktree: { landedAt: 2 } })).toBe(true)
    expect(isTabWorktreeSealed({ worktree: {} })).toBe(false)
  })
})
