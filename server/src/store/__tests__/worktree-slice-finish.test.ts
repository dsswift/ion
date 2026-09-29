// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createWorktreeSlice } from '../slices/worktree-slice'

const REPO = '/Users/test/project'
const WORKTREE = '/Users/test/.ion/worktrees/project-a3f1'

function harness(result = { ok: true }) {
  const landAndRetireWorktree = vi.fn(async () => result)
  const state: Record<string, unknown> = {
    tabs: [{ id: 'tab-1', title: 'Work', worktree: { worktreePath: WORKTREE, branchName: 'wt/abc', sourceBranch: 'josh', repoPath: REPO } }],
    landAndRetireWorktree,
  }
  const set = (updater: unknown) => Object.assign(state, typeof updater === 'function' ? (updater as (current: typeof state) => Partial<typeof state>)(state) : updater)
  Object.assign(state, createWorktreeSlice(set as never, (() => state) as never))
  return state as typeof state & { finishWorktreeTab(tabId: string, strategy?: 'merge-ff' | 'merge' | 'pr'): Promise<void>; landAndRetireWorktree: ReturnType<typeof vi.fn> }
}

describe('finishWorktreeTab', () => {
  it('delegates terminal completion with the selected strategy', async () => {
    const state = harness()
    await state.finishWorktreeTab('tab-1', 'merge')
    expect(state.landAndRetireWorktree).toHaveBeenCalledWith(REPO, {
      worktreePath: WORKTREE,
      branchName: 'wt/abc',
      sourceBranch: 'josh',
      label: 'Work',
    }, 'merge')
  })

  it('does not act for a tab without a worktree', async () => {
    const state = harness()
    state.tabs = [{ id: 'plain' }]
    await state.finishWorktreeTab('plain')
    expect(state.landAndRetireWorktree).not.toHaveBeenCalled()
  })
})
