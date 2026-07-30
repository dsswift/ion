/**
 * Worktree state projection (desktop -> iOS).
 *
 * ── What is under test ──────────────────────────────────────────────────────
 * iOS renders main-process truth, so whatever the desktop rows know about a
 * worktree must reach the projection or the phone silently shows less. Two
 * facts are new and easy to drop:
 *
 *   - the worktree's human `title`, which is the only string in the payload
 *     that says what the work is about, and
 *   - `openConversations`, which replaced a single `openTabId` that could say
 *     "something is open" but never which conversations or how many.
 *
 * Bench members carry the title too, RESOLVED from the worktree inventory
 * rather than stored on the member record -- a second copy would drift the
 * moment the worktree is renamed. That resolution is pinned here.
 *
 * Regression direction: reverting the projection to `openTabId: openTabs.get(...)`
 * turns every openConversations assertion red; dropping the inventory lookup in
 * the member map turns the bench-member-title test red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

const WT_A = '/Users/dev/.ion/worktrees/ion-a3f1'
const WT_B = '/Users/dev/.ion/worktrees/ion-7b0c'
const BENCH = '/Users/dev/.ion/integration/ion-josh'
const REPO = '/Users/dev/src/ion'

/** A tab as the renderer snapshot projects it. */
function tab(over: Record<string, unknown> & { id: string }) {
  return { title: 'New Tab', customTitle: null, status: 'idle', workingDirectory: '', ...over }
}

function inventoryEntry(over: Record<string, unknown> = {}) {
  return {
    worktreePath: WT_A,
    branchName: 'wt/ion-a3f1',
    label: 'ion-a3f1',
    title: undefined as string | undefined,
    sourceBranch: 'josh',
    head: 'abc1234',
    lastCommitSubject: 'fix token expiry',
    isDirty: false,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: true,
    operationState: undefined as string | undefined,
    conflictedPaths: undefined as string[] | undefined,
    ...over,
  }
}

const mocks = {
  worktrees: [] as ReturnType<typeof inventoryEntry>[],
  workspaces: [] as any[],
  tabs: [] as ReturnType<typeof tab>[],
}

async function loadBuilder() {
  vi.resetModules()
  vi.doMock('../state', () => ({ state: { remoteTransport: null } }))
  vi.doMock('../broadcast', () => ({ broadcast: vi.fn() }))
  vi.doMock('../worktree/inventory', () => ({
    inventoryWorktrees: vi.fn(async () => mocks.worktrees),
  }))
  vi.doMock('../worktree/integrate', () => ({
    syncWorktreeFromSource: vi.fn(), landWorktree: vi.fn(),
  }))
  vi.doMock('../integration/bench-ops', () => ({
    listWorkspaces: vi.fn(() => mocks.workspaces),
    refreshStaleness: vi.fn(async () => null),
    sourceBranchTip: vi.fn(async () => ''),
    rebuildWorkspace: vi.fn(), updateMember: vi.fn(), updateAllStale: vi.fn(),
    setMemberEnabled: vi.fn(), addMember: vi.fn(), removeMember: vi.fn(),
  }))
  vi.doMock('../remote/snapshot', () => ({
    getRemoteTabStates: vi.fn(async () => ({ tabs: mocks.tabs })),
  }))
  const mod = await import('../remote/handlers/worktree')
  return mod.buildWorktreeState
}

beforeEach(() => {
  mocks.worktrees = []
  mocks.workspaces = []
  mocks.tabs = []
})

afterEach(() => { vi.resetModules() })

describe('buildWorktreeState — worktrees', () => {
  it('projects the human title so iOS can render something other than a slug', async () => {
    mocks.worktrees = [inventoryEntry({ title: 'Fix the token expiry check' })]
    const build = await loadBuilder()

    const state = await build(REPO)

    expect(state.worktrees[0].title).toBe('Fix the token expiry check')
    // The machine identifiers survive alongside it; the title never replaces
    // them, because land/sync/branch talk still needs them.
    expect(state.worktrees[0].label).toBe('ion-a3f1')
    expect(state.worktrees[0].branchName).toBe('wt/ion-a3f1')
  })

  it('omits the title for a worktree that has never been named', async () => {
    mocks.worktrees = [inventoryEntry()]
    const build = await loadBuilder()

    expect((await build(REPO)).worktrees[0].title).toBeUndefined()
  })

  it('projects EVERY conversation open in a worktree, named and indexed', async () => {
    mocks.worktrees = [inventoryEntry()]
    mocks.tabs = [
      tab({ id: 'elsewhere', workingDirectory: REPO }),
      tab({ id: 'wt-1', workingDirectory: WT_A, title: 'Fix the parser', status: 'running' }),
      tab({ id: 'wt-2', workingDirectory: WT_A, title: 'auto', customTitle: 'Add tests' }),
    ]
    const build = await loadBuilder()

    const state = await build(REPO)

    expect(state.worktrees[0].openConversations).toEqual([
      { tabId: 'wt-1', title: 'Fix the parser', status: 'running', index: 2 },
      { tabId: 'wt-2', title: 'Add tests', status: 'idle', index: 3 },
    ])
  })

  it('reports an empty list rather than omitting the field when nothing is open', async () => {
    mocks.worktrees = [inventoryEntry()]
    mocks.tabs = [tab({ id: 'elsewhere', workingDirectory: REPO })]
    const build = await loadBuilder()

    expect((await build(REPO)).worktrees[0].openConversations).toEqual([])
  })

  // ── In-progress operations ────────────────────────────────────────────────
  //
  // iOS renders a conflict chip from `operationState` + `conflictedCount`, and
  // its wire test decodes both. Neither reached the payload: the projection
  // spread the inventory entry, which carries `conflictedPaths` (an array iOS
  // has no surface for) and no count at all — so every merge-conflicted
  // worktree read as the generic "rebasing" fallback on the phone while the
  // desktop row showed the real number.
  //
  // Regression direction: dropping `conflictedCount: w.conflictedPaths?.length`
  // from the projection turns the count assertions red; reverting to `...w`
  // turns the "does not ship the paths" assertion red.
  it('projects the operation and a conflicted COUNT, not the paths', async () => {
    mocks.worktrees = [inventoryEntry({
      operationState: 'rebasing',
      conflictedPaths: ['src/a.ts', 'src/b.ts', 'docs/c.md'],
    })]
    const build = await loadBuilder()

    const wt = (await build(REPO)).worktrees[0]

    expect(wt.operationState).toBe('rebasing')
    expect(wt.conflictedCount).toBe(3)
    // The paths are desktop-only: only the desktop can resolve a conflict, so
    // only it has a surface for them. Shipping the array would be bytes no
    // client reads.
    expect(wt).not.toHaveProperty('conflictedPaths')
  })

  it('projects an operation with no conflicts as a zero count', async () => {
    // A clean rebase mid-flight: the operation is real, nothing is unmerged.
    mocks.worktrees = [inventoryEntry({ operationState: 'merging', conflictedPaths: undefined })]
    const build = await loadBuilder()

    const wt = (await build(REPO)).worktrees[0]

    expect(wt.operationState).toBe('merging')
    expect(wt.conflictedCount).toBeUndefined()
  })

  it('omits both fields for a quiescent worktree', async () => {
    mocks.worktrees = [inventoryEntry()]
    const build = await loadBuilder()

    const wt = (await build(REPO)).worktrees[0]

    expect(wt.operationState).toBeUndefined()
    expect(wt.conflictedCount).toBeUndefined()
  })

  // The projection must survive a snapshot failure: losing the "open" hint is
  // acceptable, losing the worktree list is not.
  it('still returns worktrees when the tab snapshot is unavailable', async () => {
    mocks.worktrees = [inventoryEntry({ title: 'Named anyway' })]
    vi.resetModules()
    vi.doMock('../state', () => ({ state: { remoteTransport: null } }))
    vi.doMock('../broadcast', () => ({ broadcast: vi.fn() }))
    vi.doMock('../worktree/inventory', () => ({ inventoryWorktrees: vi.fn(async () => mocks.worktrees) }))
    vi.doMock('../worktree/integrate', () => ({ syncWorktreeFromSource: vi.fn(), landWorktree: vi.fn() }))
    vi.doMock('../integration/bench-ops', () => ({
      listWorkspaces: vi.fn(() => []), refreshStaleness: vi.fn(), sourceBranchTip: vi.fn(),
      rebuildWorkspace: vi.fn(), updateMember: vi.fn(), updateAllStale: vi.fn(),
      setMemberEnabled: vi.fn(), addMember: vi.fn(), removeMember: vi.fn(),
    }))
    vi.doMock('../remote/snapshot', () => ({
      getRemoteTabStates: vi.fn(async () => { throw new Error('renderer gone') }),
    }))
    const { buildWorktreeState } = await import('../remote/handlers/worktree')

    const state = await buildWorktreeState(REPO)

    expect(state.worktrees[0].title).toBe('Named anyway')
    expect(state.worktrees[0].openConversations).toEqual([])
  })
})

describe('buildWorktreeState — benches', () => {
  const workspace = {
    repoPath: REPO,
    sourceBranch: 'josh',
    benchPath: BENCH,
    benchBranch: 'ion/bench/josh',
    baseSha: 'aaaa111',
    lastBuiltAt: 1_700_000_000_000,
    members: [{
      worktreePath: WT_B,
      branchName: 'wt/ion-7b0c',
      label: 'ion-7b0c',
      enabled: true,
      pinnedSha: 'bbbb222',
      pinnedTreeHash: 't1',
      currentTreeHash: 't1',
      status: 'integrated' as const,
    }],
  }

  it('resolves a member title from the worktree inventory, never a stored copy', async () => {
    mocks.worktrees = [
      inventoryEntry({ worktreePath: WT_B, branchName: 'wt/ion-7b0c', label: 'ion-7b0c', title: 'Rework the relay auth' }),
    ]
    mocks.workspaces = [workspace]
    const build = await loadBuilder()

    const state = await build(REPO)

    expect(state.benches[0].members[0].title).toBe('Rework the relay auth')
  })

  it('leaves the member title undefined when its worktree has no name yet', async () => {
    mocks.worktrees = [inventoryEntry({ worktreePath: WT_B, label: 'ion-7b0c' })]
    mocks.workspaces = [workspace]
    const build = await loadBuilder()

    expect((await build(REPO)).benches[0].members[0].title).toBeUndefined()
  })

  it('projects conversations open in the bench and, separately, in each member', async () => {
    mocks.worktrees = [inventoryEntry({ worktreePath: WT_B, label: 'ion-7b0c' })]
    mocks.workspaces = [workspace]
    mocks.tabs = [
      tab({ id: 'bench-1', workingDirectory: BENCH, title: 'Bench build' }),
      tab({ id: 'member-1', workingDirectory: WT_B, title: 'Relay auth work' }),
    ]
    const build = await loadBuilder()

    const state = await build(REPO)

    expect(state.benches[0].openConversations).toEqual([
      { tabId: 'bench-1', title: 'Bench build', status: 'idle', index: 1 },
    ])
    // A member's conversations live in the MEMBER's worktree, not the bench.
    expect(state.benches[0].members[0].openConversations).toEqual([
      { tabId: 'member-1', title: 'Relay auth work', status: 'idle', index: 2 },
    ])
  })
})
