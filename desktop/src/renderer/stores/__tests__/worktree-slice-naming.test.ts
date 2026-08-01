/**
 * Worktree creation seeds its name from the conversation it was cut for.
 *
 * ── The behaviour under test ─────────────────────────────────────────────────
 * The `abc` case: a conversation the operator named (or that titled itself from
 * an earlier prompt) is converted into a worktree, and the worktree is born
 * carrying that same name. Before this, a converted conversation named `abc`
 * produced a worktree row reading `ion-a3f1` — a hex slug the operator then had
 * to reconcile against the tab strip by hand.
 *
 * A tab still on a placeholder (`New Tab`, `Resumed Session`) has nothing worth
 * carrying, so it seeds NOTHING and the worktree waits to be named by the first
 * real prompt sent in it. That is the panel's "New worktree" path, where the tab
 * is born as `New Tab`.
 *
 * Regression direction: dropping the `seedWorktreeFromTab` call from
 * convertToWorktree/setupWorktree turns the named cases red; dropping the
 * placeholder guard turns the `New Tab` cases red by seeding a worktree with the
 * literal string "New Tab".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => ({
      worktreeBranchDefaults: { '/Users/test/project': 'josh' },
      setWorktreeBranchDefault: vi.fn(),
      worktreeCompletionStrategy: 'merge-ff' as const,
    }),
  },
}))

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

// session-store-helpers constructs an Audio element at import time, which this
// node-environment suite has no DOM for.
vi.mock('../session-store-helpers', () => ({
  bumpMsgCounter: vi.fn(() => 1),
}))

// The real helper relocates a live engine session; this suite is about the seed,
// so it is stubbed to a no-op that still resolves.
vi.mock('../slices/tab-working-directory', () => ({
  setTabWorkingDirectory: vi.fn(async () => {}),
}))

import { createWorktreeSlice } from '../slices/worktree-slice'

const REPO = '/Users/test/project'
const WT = '/Users/test/.ion/worktrees/project-a3f1'

const mockWorktreeAdd = vi.fn(async () => ({
  ok: true,
  worktree: { worktreePath: WT, branchName: 'wt/project-a3f1', sourceBranch: 'josh', repoPath: REPO },
}))
const mockSeedTitle = vi.fn(async () => ({ ok: true, title: 'seeded' }))
const mockSetTitle = vi.fn(async () => ({ ok: true, title: 'renamed' }))

;(globalThis as any).window = {
  ion: {
    gitWorktreeAdd: mockWorktreeAdd,
    gitWorktreeSeedTitle: mockSeedTitle,
    gitWorktreeSetTitle: mockSetTitle,
  },
}

/** Minimal store harness: the slice reads tabs and calls set(). */
function harness(tab: { title: string; customTitle: string | null }) {
  const state: Record<string, any> = {
    tabs: [{ id: 'tab-1', workingDirectory: REPO, ...tab }],
    activeTabId: 'tab-1',
    conversationPanes: new Map(),
  }
  const set = vi.fn((updater: any) => {
    const patch = typeof updater === 'function' ? updater(state) : updater
    Object.assign(state, patch)
  })
  const get = () => state as any
  Object.assign(state, createWorktreeSlice(set, get))
  return state
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('convertToWorktree — name seeding', () => {
  it('carries a generated conversation title onto the new worktree', async () => {
    const state = harness({ title: 'Fix the token expiry check', customTitle: null })

    await state.convertToWorktree('tab-1')

    expect(mockSeedTitle).toHaveBeenCalledWith(WT, 'Fix the token expiry check')
  })

  // The operator's own name wins over the generated one, exactly as it does
  // everywhere else the tab's display name is resolved.
  it('prefers the operator customTitle over the generated title', async () => {
    const state = harness({ title: 'A generated title', customTitle: 'abc' })

    await state.convertToWorktree('tab-1')

    expect(mockSeedTitle).toHaveBeenCalledWith(WT, 'abc')
  })

  it('seeds nothing for a tab still on the New Tab placeholder', async () => {
    const state = harness({ title: 'New Tab', customTitle: null })

    await state.convertToWorktree('tab-1')

    expect(mockSeedTitle).not.toHaveBeenCalled()
  })

  it('seeds nothing for a tab still on the Resumed Session placeholder', async () => {
    const state = harness({ title: 'Resumed Session', customTitle: null })

    await state.convertToWorktree('tab-1')

    expect(mockSeedTitle).not.toHaveBeenCalled()
  })

  it('seeds nothing when worktree creation was refused', async () => {
    mockWorktreeAdd.mockResolvedValueOnce({ ok: false } as any)
    const state = harness({ title: 'Fix the token expiry check', customTitle: null })

    await state.convertToWorktree('tab-1')

    expect(mockSeedTitle).not.toHaveBeenCalled()
  })
})

describe('setupWorktree — name seeding', () => {
  // The branch-picker completion path. Same rule: a named conversation carries
  // its name; a placeholder does not.
  it('carries the conversation name onto the worktree the picker created', async () => {
    const state = harness({ title: 'Fix the token expiry check', customTitle: null })

    await state.setupWorktree('tab-1', 'josh', false)

    expect(mockSeedTitle).toHaveBeenCalledWith(WT, 'Fix the token expiry check')
  })

  it('seeds nothing for a placeholder tab', async () => {
    const state = harness({ title: 'New Tab', customTitle: null })

    await state.setupWorktree('tab-1', 'josh', false)

    expect(mockSeedTitle).not.toHaveBeenCalled()
  })
})

/**
 * The combined rename verb — the ONE path that changes both names.
 *
 * Ordinary renames are independent by design: renaming a tab leaves its worktree
 * alone and vice versa, because a worktree's topic does not follow every
 * relabelling of a conversation inside it. This action exists so the operator
 * can deliberately change both, rather than the app guessing when a tab rename
 * ought to propagate.
 *
 * It is a single act, not a synchronization: nothing here establishes an ongoing
 * link, and afterwards the two records are independent again.
 *
 * Regression direction: dropping the `renameTab` call leaves the tab untouched;
 * dropping the `gitWorktreeSetTitle` call leaves the worktree on its old name.
 */
describe('renameTabAndWorktree', () => {
  function renameHarness(tab: {
    title: string
    customTitle: string | null
    worktree?: { worktreePath: string; branchName: string; sourceBranch: string; repoPath: string } | null
  }) {
    const state: Record<string, any> = {
      tabs: [{ id: 'tab-1', workingDirectory: WT, worktree: null, ...tab }],
      activeTabId: 'tab-1',
      conversationPanes: new Map(),
    }
    const set = vi.fn((updater: any) => {
      const patch = typeof updater === 'function' ? updater(state) : updater
      Object.assign(state, patch)
    })
    const get = () => state as any
    Object.assign(state, createWorktreeSlice(set, get))
    // The real renameTab lives in tab-slice; stub the observable part.
    state.renameTab = vi.fn((tabId: string, title: string) => {
      state.tabs = state.tabs.map((t: any) => (t.id === tabId ? { ...t, customTitle: title } : t))
    })
    return state
  }

  const worktree = {
    worktreePath: WT, branchName: 'wt/project-a3f1', sourceBranch: 'josh', repoPath: REPO,
  }

  it('applies the one name to the tab AND the worktree', async () => {
    const state = renameHarness({ title: 'Old name', customTitle: null, worktree })

    await state.renameTabAndWorktree('tab-1', 'What it is really about')

    expect(state.renameTab).toHaveBeenCalledWith('tab-1', 'What it is really about')
    expect(mockSetTitle).toHaveBeenCalledWith({
      worktreePath: WT, repoPath: REPO, title: 'What it is really about',
    })
  })

  it('trims the name before applying either half', async () => {
    const state = renameHarness({ title: 'Old name', customTitle: null, worktree })

    await state.renameTabAndWorktree('tab-1', '   Padded name   ')

    expect(state.renameTab).toHaveBeenCalledWith('tab-1', 'Padded name')
    expect(mockSetTitle).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Padded name' }),
    )
  })

  // An empty name would blank both surfaces, which is never what someone typing
  // into a rename field is asking for.
  it('refuses an empty name and touches neither surface', async () => {
    const state = renameHarness({ title: 'Old name', customTitle: null, worktree })

    await state.renameTabAndWorktree('tab-1', '   ')

    expect(state.renameTab).not.toHaveBeenCalled()
    expect(mockSetTitle).not.toHaveBeenCalled()
  })

  // Defensive: the menu item is gated on tab.worktree, but the action re-checks
  // rather than renaming a worktree that does not exist.
  it('renames only the tab when it has no worktree', async () => {
    const state = renameHarness({ title: 'Old name', customTitle: null, worktree: null })

    await state.renameTabAndWorktree('tab-1', 'A new name')

    expect(state.renameTab).toHaveBeenCalledWith('tab-1', 'A new name')
    expect(mockSetTitle).not.toHaveBeenCalled()
  })

  // The tab half already applied, so a failed worktree half must not throw and
  // undo the operator's visible rename.
  it('keeps the tab rename when the worktree half is refused', async () => {
    mockSetTitle.mockResolvedValueOnce({ ok: false, error: 'A title cannot be empty.' } as any)
    const state = renameHarness({ title: 'Old name', customTitle: null, worktree })

    await state.renameTabAndWorktree('tab-1', 'A new name')

    expect(state.tabs[0].customTitle).toBe('A new name')
  })

  it('keeps the tab rename when the worktree half throws', async () => {
    mockSetTitle.mockRejectedValueOnce(new Error('ipc exploded'))
    const state = renameHarness({ title: 'Old name', customTitle: null, worktree })

    await state.renameTabAndWorktree('tab-1', 'A new name')

    expect(state.tabs[0].customTitle).toBe('A new name')
  })
})
