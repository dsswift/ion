// @vitest-environment jsdom
/**
 * `finishWorktreeTab` now means Land, never Land-and-retire.
 *
 * The old fused action deleted a checkout immediately after integration. Landing
 * now leaves a sealed review record; Retire is the sole explicit destructive
 * action. These tests fail if a future edit reintroduces the fused lifecycle.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const REPO = '/Users/test/project'
const WORKTREE = '/Users/test/.ion/worktrees/project-a3f1'

const preferences = { worktreeCompletionStrategy: 'merge-ff' as 'merge-ff' | 'merge' | 'pr' }
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => preferences },
}))
vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

const ion = {
  gitWorktreeLand: vi.fn(),
}

import { createWorktreeSlice } from '../slices/worktree-slice'

function tab() {
  return {
    id: 'tab-1',
    workingDirectory: WORKTREE,
    worktree: {
      worktreePath: WORKTREE,
      branchName: 'wt/abc',
      sourceBranch: 'josh',
      repoPath: REPO,
    },
  }
}

function harness() {
  const state: Record<string, unknown> = {
    tabs: [tab()],
    sealLandedWorktree: vi.fn(async () => {}),
    refreshWorkspaceViews: vi.fn(async () => {}),
  }
  const set = (updater: unknown) => {
    const patch = typeof updater === 'function'
      ? (updater as (current: typeof state) => Partial<typeof state>)(state)
      : updater
    Object.assign(state, patch)
  }
  const get = () => state
  Object.assign(state, createWorktreeSlice(set as never, get as never))
  return state as typeof state & {
    finishWorktreeTab(tabId: string, strategy?: 'merge-ff' | 'merge' | 'pr'): Promise<void>
    sealLandedWorktree: ReturnType<typeof vi.fn>
    refreshWorkspaceViews: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  preferences.worktreeCompletionStrategy = 'merge-ff'
  ;(globalThis as unknown as { window: { ion: typeof ion } }).window = { ion }
  ion.gitWorktreeLand.mockResolvedValue({ ok: true, mode: 'fast-forward' })
})

describe('finishWorktreeTab — terminal land', () => {
  it('lands, seals review conversations, and never retires the checkout', async () => {
    const state = harness()

    await state.finishWorktreeTab('tab-1')

    expect(ion.gitWorktreeLand).toHaveBeenCalledWith({
      repoPath: REPO,
      worktreePath: WORKTREE,
      worktreeBranch: 'wt/abc',
      sourceBranch: 'josh',
      noFf: false,
      syncFirst: true,
      requireFastForward: true,
    })
    expect(state.sealLandedWorktree).toHaveBeenCalledWith(WORKTREE)
    expect(state.refreshWorkspaceViews).toHaveBeenCalledWith(REPO)
    expect((ion as Record<string, unknown>).gitWorktreeRetire).toBeUndefined()
  })

  it('does not seal or refresh after a refused land', async () => {
    ion.gitWorktreeLand.mockResolvedValueOnce({ ok: false, error: 'source moved' })
    const state = harness()

    await state.finishWorktreeTab('tab-1')

    expect(state.sealLandedWorktree).not.toHaveBeenCalled()
    expect(state.refreshWorkspaceViews).not.toHaveBeenCalled()
  })

  it('honors an explicit merge strategy while preserving the checkout', async () => {
    const state = harness()

    await state.finishWorktreeTab('tab-1', 'merge')

    expect(ion.gitWorktreeLand).toHaveBeenCalledWith(expect.objectContaining({
      noFf: true,
      syncFirst: false,
      requireFastForward: false,
    }))
    expect(state.sealLandedWorktree).toHaveBeenCalledWith(WORKTREE)
  })
})
