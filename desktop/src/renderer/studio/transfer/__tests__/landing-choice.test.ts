/**
 * landing-choice — the Worktree and From branch fields add up to one
 * landing, and a move within one machine never lands where it already is.
 */
import { describe, expect, it } from 'vitest'
import { buildLanding, defaultBaseBranch, landsWhereItIs, offersWorktrees, parseWorktreeChoice, worktreeChoiceValue } from '../landing-choice'

const options = { worktrees: [{ worktreePath: '/wt/a', branchName: 'wt/a', title: 'A' }], branches: ['josh', 'main'], currentBranch: 'main' }

describe('defaultBaseBranch', () => {
  it("prefers the conversation's own base branch when the destination has it", () => {
    expect(defaultBaseBranch(options, 'josh')).toBe('josh')
  })
  it('falls back to the branch the destination checkout is on, then the first branch', () => {
    expect(defaultBaseBranch(options, 'gone')).toBe('main')
    expect(defaultBaseBranch({ ...options, currentBranch: null }, null)).toBe('josh')
    expect(defaultBaseBranch({ ...options, branches: [], currentBranch: null }, null)).toBe('')
  })
})

describe('buildLanding', () => {
  it('turns each pick into its landing', () => {
    expect(buildLanding('/src/ion', { kind: 'checkout' }, '')).toEqual({ kind: 'checkout', dir: '/src/ion' })
    expect(buildLanding('/src/ion', { kind: 'worktree', worktreePath: '/wt/a' }, '')).toEqual({ kind: 'worktree', worktreePath: '/wt/a' })
    expect(buildLanding('/src/ion', { kind: 'new' }, 'josh')).toEqual({ kind: 'new-worktree', projectDir: '/src/ion', baseBranch: 'josh' })
  })
  it('is null while a required pick is missing', () => {
    expect(buildLanding('', { kind: 'checkout' }, '')).toBeNull()
    expect(buildLanding('/src/ion', { kind: 'new' }, '')).toBeNull()
  })
})

describe('landsWhereItIs', () => {
  it('is true only for the exact checkout or worktree the conversation lives in', () => {
    expect(landsWhereItIs({ kind: 'checkout', dir: '/src/ion' }, '/src/ion')).toBe(true)
    expect(landsWhereItIs({ kind: 'worktree', worktreePath: '/wt/a' }, '/wt/a')).toBe(true)
    expect(landsWhereItIs({ kind: 'checkout', dir: '/src/ion' }, '/wt/a')).toBe(false)
    expect(landsWhereItIs({ kind: 'new-worktree', projectDir: '/src/ion', baseBranch: 'main' }, '/src/ion')).toBe(false)
  })
})

describe('the Worktree field', () => {
  it('appears only for a project git can read', () => {
    expect(offersWorktrees(options)).toBe(true)
    expect(offersWorktrees({ worktrees: [], branches: [], currentBranch: null })).toBe(false)
    expect(offersWorktrees(null)).toBe(false)
  })
  it('round-trips every choice through its menu value', () => {
    for (const choice of [{ kind: 'checkout' as const }, { kind: 'new' as const }, { kind: 'worktree' as const, worktreePath: '/wt/a' }]) {
      expect(parseWorktreeChoice(worktreeChoiceValue(choice))).toEqual(choice)
    }
  })
})
