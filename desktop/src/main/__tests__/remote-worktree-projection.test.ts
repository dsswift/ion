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
const REPO_ALIAS = '/Users/dev/.ion/worktrees/ion-a3f1'

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

const remoteWorktreeStates = new Map()
const remoteTransport = { send: vi.fn() }

const mocks = {
  worktrees: [] as ReturnType<typeof inventoryEntry>[],
  workspaces: [] as any[],
  tabs: [] as ReturnType<typeof tab>[],
  workspaceRepoPaths: [] as string[],
  stalenessRepoPaths: [] as string[],
  sourceTipRepoPaths: [] as string[],
  branchDefaults: {} as Record<string, string>,
}

async function loadBuilder() {
  vi.resetModules()
  vi.doMock('../state', () => ({ state: { remoteTransport, remoteWorktreeStates } }))
  vi.doMock('../broadcast', () => ({ broadcast: vi.fn() }))
  // The handler reads through the caching service, not the raw crawl; mocking
  // the service keeps each test in control of exactly what the handler sees.
  vi.doMock('../worktree/inventory-service', () => ({
    getWorktreeInventory: vi.fn(async () => mocks.worktrees),
  }))
  vi.doMock('../worktree/inventory-cache', () => ({
    resolveInventoryAlias: vi.fn((path: string) => path === REPO_ALIAS ? REPO : path),
  }))
  vi.doMock('../worktree/integrate', () => ({
    syncWorktreeFromSource: vi.fn(), landWorktree: vi.fn(),
  }))
  vi.doMock('../integration/bench-ops', () => ({
    listWorkspaces: vi.fn((repoPath: string) => {
      mocks.workspaceRepoPaths.push(repoPath)
      return mocks.workspaces
    }),
    refreshStaleness: vi.fn(async (repoPath: string) => {
      mocks.stalenessRepoPaths.push(repoPath)
      return null
    }),
    sourceBranchTip: vi.fn(async (repoPath: string) => {
      mocks.sourceTipRepoPaths.push(repoPath)
      return ''
    }),
    assembleWorkspace: vi.fn(), updateMember: vi.fn(), updateAllStale: vi.fn(),
    addMember: vi.fn(), removeMember: vi.fn(),
  }))
  vi.doMock('../remote/snapshot', () => ({
    getRemoteTabStates: vi.fn(async () => ({ tabs: mocks.tabs })),
  }))
  vi.doMock('../settings-store', () => ({
    readWorktreeBranchDefault: vi.fn((repoPath: string) => mocks.branchDefaults[repoPath]),
  }))
  const mod = await import('../remote/handlers/worktree')
  return mod
}

beforeEach(() => {
  mocks.worktrees = []
  mocks.workspaces = []
  mocks.tabs = []
  mocks.workspaceRepoPaths = []
  mocks.stalenessRepoPaths = []
  mocks.sourceTipRepoPaths = []
  mocks.branchDefaults = {}
  remoteWorktreeStates.clear()
  remoteTransport.send.mockClear()
})

afterEach(() => { vi.resetModules() })

describe('buildWorktreeState — worktrees', () => {
  it('projects the human title so iOS can render something other than a slug', async () => {
    mocks.worktrees = [inventoryEntry({ title: 'Fix the token expiry check' })]
    const { buildWorktreeState: build } = await loadBuilder()

    const state = await build(REPO)

    expect(state.worktrees[0].title).toBe('Fix the token expiry check')
    // The machine identifiers survive alongside it; the title never replaces
    // them, because land/sync/branch talk still needs them.
    expect(state.worktrees[0].label).toBe('ion-a3f1')
    expect(state.worktrees[0].branchName).toBe('wt/ion-a3f1')
  })

  it('omits the title for a worktree that has never been named', async () => {
    mocks.worktrees = [inventoryEntry()]
    const { buildWorktreeState: build } = await loadBuilder()

    expect((await build(REPO)).worktrees[0].title).toBeUndefined()
  })

  it('projects EVERY conversation open in a worktree, named and indexed', async () => {
    mocks.worktrees = [inventoryEntry()]
    mocks.tabs = [
      tab({ id: 'elsewhere', workingDirectory: REPO }),
      tab({ id: 'wt-1', workingDirectory: WT_A, title: 'Fix the parser', status: 'running' }),
      tab({ id: 'wt-2', workingDirectory: WT_A, title: 'auto', customTitle: 'Add tests' }),
    ]
    const { buildWorktreeState: build } = await loadBuilder()

    const state = await build(REPO)

    expect(state.worktrees[0].openConversations).toEqual([
      { tabId: 'wt-1', title: 'Fix the parser', status: 'running', index: 2 },
      { tabId: 'wt-2', title: 'Add tests', status: 'idle', index: 3 },
    ])
  })

  it('does not count a settled review preview as an open worktree conversation', async () => {
    mocks.worktrees = [inventoryEntry()]
    mocks.tabs = [
      tab({ id: 'settled-preview', workingDirectory: WT_A, title: 'Archived work', inboxState: 'settled', inputLocked: true }),
    ]
    const { buildWorktreeState: build } = await loadBuilder()

    expect((await build(REPO)).worktrees[0].openConversations).toEqual([])
  })

  it('reports an empty list rather than omitting the field when nothing is open', async () => {
    mocks.worktrees = [inventoryEntry()]
    mocks.tabs = [tab({ id: 'elsewhere', workingDirectory: REPO })]
    const { buildWorktreeState: build } = await loadBuilder()

    expect((await build(REPO)).worktrees[0].openConversations).toEqual([])
  })

  it('canonicalizes a worktree request after inventory learns its source repo', async () => {
    mocks.workspaces = [{
      repoPath: REPO,
      sourceBranch: 'josh',
      benchPath: BENCH,
      benchBranch: 'ion/bench/josh',
      baseSha: 'aaaa111',
      lastBuiltAt: 1_700_000_000_000,
      members: [],
    }]
    const { buildWorktreeState: build } = await loadBuilder()

    const state = await build(REPO_ALIAS)

    expect(state.repoPath).toBe(REPO)
    expect(mocks.workspaceRepoPaths).toEqual([REPO])
    expect(mocks.stalenessRepoPaths).toEqual([REPO])
    expect(mocks.sourceTipRepoPaths).toEqual([REPO])
  })

  it('projects the recorded default source branch so iOS can skip the picker', async () => {
    mocks.worktrees = [inventoryEntry()]
    mocks.branchDefaults = { [REPO]: 'josh' }
    const { buildWorktreeState: build } = await loadBuilder()

    expect((await build(REPO)).defaultSourceBranch).toBe('josh')
  })

  it('reads the default under the CANONICAL source repo, not the requested alias', async () => {
    // The renderer records worktreeBranchDefaults[sourceRepoPath]; iOS may
    // request from an alias checkout. The projection must key the lookup by the
    // resolved source repo or the default is silently lost.
    mocks.branchDefaults = { [REPO]: 'josh' }
    const { buildWorktreeState: build } = await loadBuilder()

    expect((await build(REPO_ALIAS)).defaultSourceBranch).toBe('josh')
  })

  it('omits the default source branch when the operator has recorded none', async () => {
    mocks.worktrees = [inventoryEntry()]
    const { buildWorktreeState: build } = await loadBuilder()

    expect((await build(REPO)).defaultSourceBranch).toBeUndefined()
  })

  it('caches and pushes one canonical state after alias refreshes', async () => {
    remoteWorktreeStates.set('/stale-worktree-alias', {
      repoPath: REPO,
      worktrees: [],
      benches: [],
    })
    const { pushWorktreeState: push } = await loadBuilder()

    await push(REPO_ALIAS)

    expect(remoteWorktreeStates.has(REPO_ALIAS)).toBe(false)
    expect(remoteWorktreeStates.has('/stale-worktree-alias')).toBe(false)
    expect(remoteWorktreeStates.get(REPO)?.repoPath).toBe(REPO)
    expect(remoteTransport.send).toHaveBeenCalledWith({
      type: 'desktop_worktree_state',
      states: [{ repoPath: REPO, worktrees: [], benches: [] }],
    })
  })

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
    const { buildWorktreeState: build } = await loadBuilder()

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
    const { buildWorktreeState: build } = await loadBuilder()

    const wt = (await build(REPO)).worktrees[0]

    expect(wt.operationState).toBe('merging')
    expect(wt.conflictedCount).toBeUndefined()
  })

  it('omits both fields for a quiescent worktree', async () => {
    mocks.worktrees = [inventoryEntry()]
    const { buildWorktreeState: build } = await loadBuilder()

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
    vi.doMock('../worktree/inventory-service', () => ({ getWorktreeInventory: vi.fn(async () => mocks.worktrees) }))
    vi.doMock('../worktree/inventory-cache', () => ({
      resolveInventoryAlias: vi.fn((path: string) => path === REPO_ALIAS ? REPO : path),
    }))
    vi.doMock('../worktree/integrate', () => ({ syncWorktreeFromSource: vi.fn(), landWorktree: vi.fn() }))
    vi.doMock('../integration/bench-ops', () => ({
      listWorkspaces: vi.fn(() => []), refreshStaleness: vi.fn(), sourceBranchTip: vi.fn(),
      assembleWorkspace: vi.fn(), updateMember: vi.fn(), updateAllStale: vi.fn(),
      addMember: vi.fn(), removeMember: vi.fn(),
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

describe('buildWorktreeState — membership rides the worktree', () => {
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
      pin: 'current' as const,
      merge: 'merged' as const,
      pinnedSha: 'bbbb222',
      pinnedTreeHash: 't1',
      pinnedBaseSha: 'base1',
      currentTreeHash: 't1',
    }],
  }

  it('attaches membership to the worktree instead of sending a second record', async () => {
    // One worktree, one wire record. The bench used to re-send every member
    // with its own copy of the path, branch, and label, so an enrolled worktree
    // crossed the wire twice and iOS drew it in two sections.
    mocks.worktrees = [
      inventoryEntry({ worktreePath: WT_B, branchName: 'wt/ion-7b0c', label: 'ion-7b0c', title: 'Rework the relay auth' }),
    ]
    mocks.workspaces = [workspace]
    const { buildWorktreeState: build } = await loadBuilder()

    const state = await build(REPO)

    expect(state.worktrees).toHaveLength(1)
    expect(state.worktrees[0].title).toBe('Rework the relay auth')
    expect(state.worktrees[0].membership).toMatchObject({
      sourceBranch: 'josh', pin: 'current', merge: 'merged', order: 1,
    })
    // Nothing duplicated into the bench.
    expect(state.benches[0].orphans).toEqual([])
  })

  it('ships the three axes separately so none can mask another', async () => {
    mocks.worktrees = [inventoryEntry({ worktreePath: WT_B, branchName: 'wt/ion-7b0c', label: 'ion-7b0c' })]
    mocks.workspaces = [{
      ...workspace,
      members: [{
        ...workspace.members[0],
        pin: 'behind' as const, merge: 'conflicted' as const,
        conflictPaths: ['x.ts'],
      }],
    }]
    const { buildWorktreeState: build } = await loadBuilder()

    const membership = (await build(REPO)).worktrees[0].membership!

    // The single `status` field could carry exactly one of these facts.
    expect(membership.pin).toBe('behind')
    expect(membership.merge).toBe('conflicted')
  })

  it('leaves membership absent for an unenrolled worktree', async () => {
    // Absent means this worktree is not in the bench.
    mocks.worktrees = [inventoryEntry({ worktreePath: '/wt/other', branchName: 'wt/other', label: 'other' })]
    mocks.workspaces = [workspace]
    const { buildWorktreeState: build } = await loadBuilder()

    expect((await build(REPO)).worktrees[0].membership).toBeUndefined()
  })

  it('numbers membership by merge position', async () => {
    mocks.worktrees = [
      inventoryEntry({ worktreePath: '/wt/first', branchName: 'wt/first', label: 'first' }),
      inventoryEntry({ worktreePath: WT_B, branchName: 'wt/ion-7b0c', label: 'ion-7b0c' }),
    ]
    mocks.workspaces = [{
      ...workspace,
      members: [
        { ...workspace.members[0], worktreePath: WT_B },
        { ...workspace.members[0], worktreePath: '/wt/first', branchName: 'wt/first' },
      ],
    }]
    const { buildWorktreeState: build } = await loadBuilder()

    const state = await build(REPO)
    const byPath = (p: string) => state.worktrees.find((w) => w.worktreePath === p)!.membership!
    expect(byPath(WT_B).order).toBe(1)
    expect(byPath('/wt/first').order).toBe(2)
  })

  it('reports a membership whose worktree is gone as a bench orphan', async () => {
    // No directory to open, so no row -- but the bench still says what it holds
    // rather than the record vanishing without explanation.
    mocks.worktrees = []
    mocks.workspaces = [workspace]
    const { buildWorktreeState: build } = await loadBuilder()

    const state = await build(REPO)

    expect(state.worktrees).toEqual([])
    expect(state.benches[0].orphans).toHaveLength(1)
    expect(state.benches[0].orphans[0].sourceBranch).toBe('josh')
  })

  it('projects bench auto-fix and analysis work, but keeps worktrees operator-only', async () => {
    mocks.worktrees = [inventoryEntry({ worktreePath: WT_B, label: 'ion-7b0c' })]
    mocks.workspaces = [workspace]
    mocks.tabs = [
      tab({ id: 'bench-1', workingDirectory: BENCH, title: 'Bench build' }),
      tab({ id: 'bench-fix', workingDirectory: BENCH, title: 'Resolve merge', tabRole: 'conflict-auto-fix' }),
      tab({ id: 'bench-analysis', workingDirectory: BENCH, title: 'Check verification', tabRole: 'verification-analysis' }),
      tab({ id: 'bench-shell', workingDirectory: BENCH, isTerminalOnly: true }),
      tab({ id: 'member-1', workingDirectory: WT_B, title: 'Relay auth work' }),
      tab({ id: 'member-fix', workingDirectory: WT_B, title: 'Member fix', tabRole: 'conflict-auto-fix' }),
    ]
    const { buildWorktreeState: build } = await loadBuilder()

    const state = await build(REPO)

    expect(state.benches[0].openConversations).toEqual([
      { tabId: 'bench-1', title: 'Bench build', status: 'idle', index: 1 },
      { tabId: 'bench-fix', title: 'Resolve merge', status: 'idle', index: 2, tabRole: 'conflict-auto-fix' },
      { tabId: 'bench-analysis', title: 'Check verification', status: 'idle', index: 3, tabRole: 'verification-analysis' },
    ])
    // A member's conversations ride its WORKTREE record now, which is the only
    // place that worktree appears. Machine work stays hidden from that ordinary
    // display projection; the bench alone exposes machine integration work.
    expect(state.worktrees[0].openConversations).toEqual([
      { tabId: 'member-1', title: 'Relay auth work', status: 'idle', index: 5 },
    ])
  })
})

describe('buildWorktreeState — the bench terminal', () => {
  const workspace = {
    repoPath: REPO,
    sourceBranch: 'josh',
    benchPath: BENCH,
    benchBranch: 'ion/bench/josh',
    baseSha: 'aaaa111',
    lastBuiltAt: 1_700_000_000_000,
    members: [],
  }

  it('names the bench terminal so iOS can say "Go to" instead of "Open"', async () => {
    mocks.workspaces = [workspace]
    mocks.tabs = [
      tab({ id: 'shell', workingDirectory: BENCH, isTerminalOnly: true, customTitle: 'Bench · josh' }),
    ]
    const { buildWorktreeState: build } = await loadBuilder()

    expect((await build(REPO)).benches[0].benchTerminalTabId).toBe('shell')
  })

  it('adopts an untitled terminal in the bench directory', async () => {
    // Tier 2 of the identity rule, projected: the phone must offer "Go to" for a
    // shell the desktop has not named yet, or it would open a second one.
    mocks.workspaces = [workspace]
    mocks.tabs = [tab({ id: 'stray', workingDirectory: BENCH, isTerminalOnly: true })]
    const { buildWorktreeState: build } = await loadBuilder()

    expect((await build(REPO)).benches[0].benchTerminalTabId).toBe('stray')
  })

  it('is absent when no terminal is open in the bench', async () => {
    mocks.workspaces = [workspace]
    mocks.tabs = [tab({ id: 'talk', workingDirectory: BENCH, title: 'Bench build' })]
    const { buildWorktreeState: build } = await loadBuilder()

    expect((await build(REPO)).benches[0].benchTerminalTabId).toBeUndefined()
  })

  it('never reports a terminal from another directory', async () => {
    mocks.workspaces = [workspace]
    mocks.tabs = [tab({ id: 'elsewhere', workingDirectory: WT_A, isTerminalOnly: true, customTitle: 'Bench · josh' })]
    const { buildWorktreeState: build } = await loadBuilder()

    expect((await build(REPO)).benches[0].benchTerminalTabId).toBeUndefined()
  })

  it('does not count a terminal as an open conversation, in a bench or a worktree', async () => {
    // The wire seam of the same defect the shared helper fixes: a shell used to
    // ride `openConversations`, so the phone offered "Go to conversation" for a
    // directory holding only a terminal -- and landed the operator in it.
    mocks.worktrees = [inventoryEntry()]
    mocks.workspaces = [workspace]
    mocks.tabs = [
      tab({ id: 'bench-shell', workingDirectory: BENCH, isTerminalOnly: true }),
      tab({ id: 'wt-shell', workingDirectory: WT_A, isTerminalOnly: true }),
      tab({ id: 'wt-talk', workingDirectory: WT_A, title: 'Fix the parser' }),
    ]
    const { buildWorktreeState: build } = await loadBuilder()

    const state = await build(REPO)

    expect(state.benches[0].openConversations).toEqual([])
    expect(state.worktrees[0].openConversations).toEqual([
      { tabId: 'wt-talk', title: 'Fix the parser', status: 'idle', index: 3 },
    ])
  })

  it('keeps each bench on its own terminal', async () => {
    mocks.workspaces = [
      workspace,
      { ...workspace, sourceBranch: 'main', benchPath: '/Users/dev/.ion/integration/ion-main', benchBranch: 'ion/bench/main' },
    ]
    mocks.tabs = [
      tab({ id: 'josh-shell', workingDirectory: BENCH, isTerminalOnly: true, customTitle: 'Bench · josh' }),
      tab({ id: 'main-shell', workingDirectory: '/Users/dev/.ion/integration/ion-main', isTerminalOnly: true, customTitle: 'Bench · main' }),
    ]
    const { buildWorktreeState: build } = await loadBuilder()

    const benches = (await build(REPO)).benches
    expect(benches.find((b) => b.sourceBranch === 'josh')!.benchTerminalTabId).toBe('josh-shell')
    expect(benches.find((b) => b.sourceBranch === 'main')!.benchTerminalTabId).toBe('main-shell')
  })
})
