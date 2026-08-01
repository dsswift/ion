/**
 * Worktree inventory store actions — the re-entry path after a tab close.
 *
 * The behaviour that matters: opening a worktree conversation must FOCUS an
 * existing tab rather than creating a second conversation in the same directory.
 * Without that, the surface built to solve "I lost my way back in" creates a new
 * problem: a pile of duplicate conversations on one worktree.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The real preferences module touches localStorage/DOM, which this
// node-environment test does not have.
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ aiGeneratedTitles: false }) },
}))

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
function harness(initial: {
  tabs?: Array<{ id: string; workingDirectory: string }>
  activeTabId?: string | null
} = {}) {
  const state: Record<string, any> = {
    // Tabs carry the fields collectDirConversations reads; the tests supply
    // only id + directory, so fill the display fields in here.
    tabs: (initial.tabs ?? []).map((t) => ({ title: 'New Tab', customTitle: null, status: 'idle', ...t })),
    activeTabId: initial.activeTabId ?? null,
    worktreeInventory: new Map<string, WorktreeInventoryEntry[]>(),
    // Conflict/refusal alert plumbing the slice feeds on sync failures and
    // inventory refreshes (owned by git-conflict-slice in the real store).
    gitConflictAlerts: new Map(),
    recordConflictAlert: vi.fn(),
    clearConflictAlert: vi.fn(),
    selectTab: vi.fn((id: string) => { state.activeTabId = id }),
    createTabInDirectory: vi.fn(async (dir: string) => {
      const id = `tab-${state.tabs.length + 1}`
      state.tabs = [...state.tabs, { id, workingDirectory: dir, worktree: null, title: 'New Tab', customTitle: null, status: 'idle' }]
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
  // The REGISTRY lookup, which is where a worktree's owning repo comes from.
  // Deliberately returns a repo that is NOT a key in the inventory cache, so a
  // test cannot pass by accidentally scanning that cache instead.
  gitWorktreeRegistration: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as any).window = { ion }
  ion.gitWorktreeInventory.mockResolvedValue({ worktrees: [entry()] })
  ion.gitWorktreeRegistration.mockResolvedValue({
    registration: { repoPath: REPO, branchName: 'wt/a3f1', sourceBranch: 'josh', title: null },
  })
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
    // The REGISTRY is what carries the source branch now. A hand-created
    // worktree has a registration with sourceBranch null -- Ion genuinely does
    // not know what it was cut from and must not invent one.
    ion.gitWorktreeRegistration.mockResolvedValueOnce({
      registration: { repoPath: REPO, branchName: 'wt/a3f1', sourceBranch: null, title: null },
    })
    await slice.refreshWorktreeInventory!(REPO)

    const id = await slice.openWorktreeConversation!(WT_A)

    expect(state.tabs.find((t: any) => t.id === id).worktree).toBeNull()
  })

  // ── Rotation across several conversations in one worktree ──
  //
  // Regression direction: reverting the action to `tabs.find(...)` +
  // selectTab(first) turns every test below red — it would return 'wt-1' on
  // every click, leaving the second and third conversations unreachable from
  // the row.
  describe('with several conversations open in the same worktree', () => {
    const threeTabs = [
      { id: 'wt-1', workingDirectory: WT_A },
      { id: 'other', workingDirectory: WT_B },
      { id: 'wt-2', workingDirectory: WT_A },
      { id: 'wt-3', workingDirectory: WT_A },
    ]

    it('advances to the next conversation on each click, wrapping at the end', async () => {
      const { state, slice } = harness({ tabs: threeTabs, activeTabId: 'wt-1' })

      // selectTab updates activeTabId in the harness, exactly as the real store
      // does — which is what makes the stateless rotation advance.
      expect(await slice.openWorktreeConversation!(WT_A)).toBe('wt-2')
      expect(await slice.openWorktreeConversation!(WT_A)).toBe('wt-3')
      expect(await slice.openWorktreeConversation!(WT_A)).toBe('wt-1')

      expect(state.createTabInDirectory).not.toHaveBeenCalled()
      expect(state.selectTab).toHaveBeenNthCalledWith(1, 'wt-2')
      expect(state.selectTab).toHaveBeenNthCalledWith(2, 'wt-3')
      expect(state.selectTab).toHaveBeenNthCalledWith(3, 'wt-1')
    })

    it('starts at the first conversation when the operator is elsewhere', async () => {
      const { state, slice } = harness({ tabs: threeTabs, activeTabId: 'other' })

      expect(await slice.openWorktreeConversation!(WT_A)).toBe('wt-1')
      expect(state.createTabInDirectory).not.toHaveBeenCalled()
    })

    it('never creates a duplicate while any conversation is open there', async () => {
      const { state, slice } = harness({ tabs: threeTabs, activeTabId: 'wt-3' })

      await slice.openWorktreeConversation!(WT_A)

      expect(state.createTabInDirectory).not.toHaveBeenCalled()
      expect(state.tabs).toHaveLength(4)
    })
  })
})

/**
 * newWorktreeConversation — the explicit "another conversation here" verb.
 *
 * The defect these pin: the row menu called `createTabInDirectory` directly and
 * skipped the metadata attachment, so the new tab had no `worktree`. The git
 * panel resolves which repo's worktrees to list THROUGH that metadata, so the
 * second conversation in a worktree showed the worktree's own `git worktree
 * list` -- the main clone as a row, "source unknown", no bench -- while the first
 * conversation in the same worktree showed the correct panel.
 */
describe('newWorktreeConversation', () => {
  it('always creates, even when a conversation is already open here', async () => {
    const { state, slice } = harness({ tabs: [{ id: 'tab-existing', workingDirectory: WT_A }] })
    await slice.refreshWorktreeInventory!(REPO)

    const id = await slice.newWorktreeConversation!(WT_A)

    expect(id).not.toBe('tab-existing')
    expect(state.createTabInDirectory).toHaveBeenCalledWith(WT_A, false, true)
  })

  it('attaches the worktree metadata, which is what the git panel resolves through', async () => {
    // RED before the fix: the tab was created with no `worktree`, so the panel
    // fell back to the worktree directory and listed the wrong repo.
    const { state, slice } = harness()
    await slice.refreshWorktreeInventory!(REPO)

    const id = await slice.newWorktreeConversation!(WT_A)

    expect(state.tabs.find((t: any) => t.id === id).worktree).toEqual({
      worktreePath: WT_A,
      branchName: 'wt/a3f1',
      sourceBranch: 'josh',
      repoPath: REPO,
    })
  })

  it('gives the second conversation the same metadata as the first', async () => {
    // The symptom as reported: two conversations in one worktree disagreed about
    // what the worktree panel should show.
    const { state, slice } = harness()
    await slice.refreshWorktreeInventory!(REPO)

    const first = await slice.openWorktreeConversation!(WT_A)
    const second = await slice.newWorktreeConversation!(WT_A)

    const byId = (id: string) => state.tabs.find((t: any) => t.id === id).worktree
    expect(second).not.toBe(first)
    expect(byId(second)).toEqual(byId(first))
  })

  it('leaves metadata unset when the source branch is unknown', async () => {
    const { state, slice } = harness()
    ion.gitWorktreeRegistration.mockResolvedValueOnce({
      registration: { repoPath: REPO, branchName: 'wt/a3f1', sourceBranch: null, title: null },
    })
    await slice.refreshWorktreeInventory!(REPO)

    const id = await slice.newWorktreeConversation!(WT_A)

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
