/**
 * Worktree inventory store actions — the re-entry path after a tab close.
 *
 * The behaviour that matters: opening a worktree conversation must FOCUS an
 * existing tab rather than creating a second conversation in the same directory.
 * Without that, the surface built to solve "I lost my way back in" creates a new
 * problem: a pile of duplicate conversations on one worktree.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import { createWorktreeInventorySlice } from '../slices/worktree-inventory-slice'
import type { WorktreeInventoryEntry } from '../../../shared/types'

const REPO = '/Users/test/project'
const WT_A = '/Users/test/.ion/worktrees/project-a3f1'
const WT_B = '/Users/test/.ion/worktrees/project-7b0c'

function entry(over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    worktreePath: WT_A,
    branchName: 'wt/a3f1',
    label: 'project-a3f1',
    sourceBranch: 'josh',
    head: 'abc1234',
    lastCommitSubject: 'fix token expiry',
    isDirty: false,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: true,
    ...over,
  }
}

/** Minimal store harness: the slice only needs these members. */
function harness(initial: { tabs?: Array<{ id: string; workingDirectory: string }> } = {}) {
  const state: Record<string, any> = {
    tabs: initial.tabs ?? [],
    worktreeInventory: new Map<string, WorktreeInventoryEntry[]>(),
    // Conflict/refusal alert plumbing the slice feeds on sync failures and
    // inventory refreshes (owned by git-conflict-slice in the real store).
    gitConflictAlerts: new Map(),
    recordConflictAlert: vi.fn(),
    clearConflictAlert: vi.fn(),
    selectTab: vi.fn(),
    createTabInDirectory: vi.fn(async (dir: string) => {
      const id = `tab-${state.tabs.length + 1}`
      state.tabs = [...state.tabs, { id, workingDirectory: dir, worktree: null }]
      return id
    }),
  }
  const get = () => state as any
  const set = (patch: any) => {
    const next = typeof patch === 'function' ? patch(state) : patch
    Object.assign(state, next)
  }
  const slice = createWorktreeInventorySlice(set as any, get as any)
  Object.assign(state, slice)
  return { state, slice }
}

const ion = {
  gitWorktreeInventory: vi.fn(),
  gitWorktreeSync: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as any).window = { ion }
  ion.gitWorktreeInventory.mockResolvedValue({ worktrees: [entry()] })
  ion.gitWorktreeSync.mockResolvedValue({ ok: true })
})

describe('refreshWorktreeInventory', () => {
  it('stores the inventory keyed by repo path', async () => {
    const { state, slice } = harness()

    await slice.refreshWorktreeInventory!(REPO)

    expect(state.worktreeInventory.get(REPO)).toHaveLength(1)
    expect(state.worktreeInventory.get(REPO)![0].branchName).toBe('wt/a3f1')
  })

  // Keying by repo is what lets several projects be open at once without their
  // inventories clobbering each other.
  it('keeps separate projects separate', async () => {
    const { state, slice } = harness()
    ion.gitWorktreeInventory.mockResolvedValueOnce({ worktrees: [entry()] })
    await slice.refreshWorktreeInventory!(REPO)
    ion.gitWorktreeInventory.mockResolvedValueOnce({
      worktrees: [entry({ worktreePath: '/other/wt', branchName: 'wt/other' })],
    })
    await slice.refreshWorktreeInventory!('/Users/test/other')

    expect(state.worktreeInventory.get(REPO)![0].branchName).toBe('wt/a3f1')
    expect(state.worktreeInventory.get('/Users/test/other')![0].branchName).toBe('wt/other')
  })

  it('skips an unset directory rather than querying', async () => {
    const { slice } = harness()

    await slice.refreshWorktreeInventory!('~')

    expect(ion.gitWorktreeInventory).not.toHaveBeenCalled()
  })

  it('survives an IPC failure without throwing', async () => {
    const { state, slice } = harness()
    ion.gitWorktreeInventory.mockRejectedValueOnce(new Error('boom'))

    await expect(slice.refreshWorktreeInventory!(REPO)).resolves.toBeUndefined()
    expect(state.worktreeInventory.has(REPO)).toBe(false)
  })
})

describe('openWorktreeConversation', () => {
  // THE property. A second conversation in the same worktree is the failure
  // mode this surface must not introduce.
  it('focuses an existing tab instead of creating a duplicate', async () => {
    const { state, slice } = harness({ tabs: [{ id: 'tab-existing', workingDirectory: WT_A }] })

    const id = await slice.openWorktreeConversation!(WT_A)

    expect(id).toBe('tab-existing')
    expect(state.selectTab).toHaveBeenCalledWith('tab-existing')
    expect(state.createTabInDirectory).not.toHaveBeenCalled()
    expect(state.tabs).toHaveLength(1)
  })

  it('creates a conversation when none is open on that worktree', async () => {
    const { state, slice } = harness({ tabs: [{ id: 'tab-other', workingDirectory: WT_B }] })
    await slice.refreshWorktreeInventory!(REPO)

    const id = await slice.openWorktreeConversation!(WT_A)

    expect(id).toBe('tab-2')
    // useWorktree=false: the worktree already exists and must not be nested.
    expect(state.createTabInDirectory).toHaveBeenCalledWith(WT_A, false, true)
  })

  it('attaches worktree metadata so the tab gets the lifecycle verbs', async () => {
    const { state, slice } = harness()
    await slice.refreshWorktreeInventory!(REPO)

    const id = await slice.openWorktreeConversation!(WT_A)

    const tab = state.tabs.find((t: any) => t.id === id)
    expect(tab.worktree).toEqual({
      worktreePath: WT_A,
      branchName: 'wt/a3f1',
      sourceBranch: 'josh',
      repoPath: REPO,
    })
  })

  // Without a known source branch, land/sync are unanswerable. Leaving the
  // metadata unset is correct: inventing a source branch would land work in the
  // wrong place.
  it('leaves worktree metadata unset when the source branch is unknown', async () => {
    const { state, slice } = harness()
    ion.gitWorktreeInventory.mockResolvedValueOnce({ worktrees: [entry({ sourceBranch: null })] })
    await slice.refreshWorktreeInventory!(REPO)

    const id = await slice.openWorktreeConversation!(WT_A)

    expect(state.tabs.find((t: any) => t.id === id).worktree).toBeNull()
  })
})

describe('syncWorktree', () => {
  it('refreshes the inventory after a successful sync so the badge clears', async () => {
    const { slice } = harness()

    const result = await slice.syncWorktree!(WT_A, 'josh', REPO)

    expect(result.ok).toBe(true)
    expect(ion.gitWorktreeSync).toHaveBeenCalledWith(WT_A, 'josh')
    expect(ion.gitWorktreeInventory).toHaveBeenCalledWith(REPO)
  })

  // A refused sync must still refresh: the refusal reason (dirty tree) is state
  // the operator needs reflected in the row.
  it('refreshes the inventory even when the sync is refused', async () => {
    const { slice } = harness()
    ion.gitWorktreeSync.mockResolvedValueOnce({ ok: false, refusedDirty: true, error: 'uncommitted changes' })

    const result = await slice.syncWorktree!(WT_A, 'josh', REPO)

    expect(result.ok).toBe(false)
    expect(result.refusedDirty).toBe(true)
    expect(ion.gitWorktreeInventory).toHaveBeenCalledWith(REPO)
  })
})
