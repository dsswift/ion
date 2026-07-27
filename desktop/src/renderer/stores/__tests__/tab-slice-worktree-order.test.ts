// @vitest-environment jsdom
/**
 * Worktree resolution happens BEFORE the engine session starts.
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 * `createTabInDirectory` used to create the tab first — which eagerly starts an
 * engine session in whatever directory it was handed — and only afterward create
 * the worktree and patch renderer state. The engine pins a session's working
 * directory at `start_session`, so the session stayed in the base repo while the
 * UI showed the worktree. Five conversations ended up sharing one checkout.
 *
 * The assertion that matters is CALL ORDER, not final state. A state-only
 * assertion ("the tab ends up with the worktree path") passed on the unfixed
 * code, because the renderer patch did happen — it just happened too late to
 * affect the session. So these tests assert that `gitWorktreeAdd` resolves
 * before `ensureEngineSession` is called, and that `ensureEngineSession`
 * receives the worktree path rather than the repo path.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const WORKTREE = '/Users/test/.ion/worktrees/project-a3f1'
const REPO = '/Users/test/project'

// Ordered log of the cross-boundary calls whose sequence is the contract.
const calls: string[] = []

const mockPrefs = {
  defaultBaseDirectory: REPO,
  worktreeBranchDefaults: { [REPO]: 'main' } as Record<string, string>,
  engineProfiles: [] as any[],
  engineDefaultModel: null,
  preferredModel: null,
  tabGroupMode: 'auto',
  tabGroups: [] as any[],
  defaultTallConversation: false,
  addRecentBaseDirectory: vi.fn(),
  incrementDirectoryUsage: vi.fn(),
  setWorktreeBranchDefault: vi.fn(),
}

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => mockPrefs },
  getEffectiveTabGroups: () => [],
}))

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

vi.mock('../../components/TerminalPanel', () => ({ destroyTerminalInstance: vi.fn() }))

vi.mock('../../../shared/clear-divider', () => ({
  formatSessionStartDivider: vi.fn(() => '── Session started ──'),
}))

const mockIon = {
  gitIsRepo: vi.fn(async (dir: string) => {
    calls.push(`gitIsRepo:${dir}`)
    return { isRepo: true }
  }),
  gitWorktreeAdd: vi.fn(async (dir: string, branch: string) => {
    calls.push(`gitWorktreeAdd:${dir}@${branch}`)
    return {
      ok: true,
      worktree: { worktreePath: WORKTREE, branchName: 'wt/abc', sourceBranch: branch, repoPath: dir },
    }
  }),
  createTab: vi.fn(async () => ({ tabId: 'tab-1' })),
  adoptTab: vi.fn(async () => ({ tabId: 'tab-1' })),
  engineStart: vi.fn(async () => ({ ok: true })),
  ensureEngineSession: vi.fn(async (opts: { workingDirectory: string }) => {
    calls.push(`ensureEngineSession:${opts.workingDirectory}`)
    return { ok: true }
  }),
  setPermissionMode: vi.fn(),
  relocateTabSession: vi.fn(async () => ({ ok: true })),
}
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.ion = mockIon

import { createTabSlice } from '../slices/tab-slice'

function buildHarness() {
  const state: any = {
    tabs: [],
    conversationPanes: new Map<string, any>(),
    activeTabId: null,
    tallViewTabId: null,
    terminalTallTabId: null,
    staticInfo: { homePath: '/home/user' },
  }
  const set = (updater: any) => {
    const patch = typeof updater === 'function' ? updater(state) : updater
    Object.assign(state, patch)
  }
  const get = () => state
  const slice: any = createTabSlice(set, get)
  // Slice actions call each other through get(); wire them onto the state.
  Object.assign(state, slice)
  return { state, slice }
}

describe('worktree resolution ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    calls.length = 0
    mockPrefs.worktreeBranchDefaults = { [REPO]: 'main' }
  })

  // THE regression test. On the unfixed code the order was
  // ensureEngineSession(REPO) → gitWorktreeAdd, so the session was pinned to
  // the repo before the worktree existed.
  it('createTabInDirectory resolves the worktree before starting the session', async () => {
    const { slice } = buildHarness()

    await slice.createTabInDirectory(REPO, true, true)
    // ensureEngineSession is fired without await inside createConversationTab;
    // flush the microtask queue so its call is recorded.
    await Promise.resolve()

    const addIdx = calls.findIndex((c) => c.startsWith('gitWorktreeAdd:'))
    const ensureIdx = calls.findIndex((c) => c.startsWith('ensureEngineSession:'))
    expect(addIdx).toBeGreaterThanOrEqual(0)
    expect(ensureIdx).toBeGreaterThanOrEqual(0)
    expect(addIdx).toBeLessThan(ensureIdx)
  })

  it('starts the session in the worktree, not the repo', async () => {
    const { slice } = buildHarness()

    await slice.createTabInDirectory(REPO, true, true)
    await Promise.resolve()

    expect(mockIon.ensureEngineSession).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: WORKTREE }),
    )
    // The repo path must never have been used to start a session.
    expect(calls).not.toContain(`ensureEngineSession:${REPO}`)
  })

  it('leaves the tab carrying its worktree metadata and path', async () => {
    const { state, slice } = buildHarness()

    const tabId = await slice.createTabInDirectory(REPO, true, true)
    const tab = state.tabs.find((t: any) => t.id === tabId)

    expect(tab.workingDirectory).toBe(WORKTREE)
    expect(tab.worktree).toMatchObject({ worktreePath: WORKTREE, sourceBranch: 'main' })
    expect(tab.pendingWorktreeSetup).toBe(false)
  })

  it('marks the tab for the branch picker when the repo has no recorded default', async () => {
    mockPrefs.worktreeBranchDefaults = {}
    const { state, slice } = buildHarness()

    const tabId = await slice.createTabInDirectory(REPO, true, true)
    const tab = state.tabs.find((t: any) => t.id === tabId)

    expect(mockIon.gitWorktreeAdd).not.toHaveBeenCalled()
    expect(tab.pendingWorktreeSetup).toBe(true)
    // Without a branch there is no worktree, so the tab stays in the repo.
    expect(tab.workingDirectory).toBe(REPO)
  })

  it('does not create a worktree when none was requested', async () => {
    const { state, slice } = buildHarness()

    const tabId = await slice.createTabInDirectory(REPO, false, true)
    const tab = state.tabs.find((t: any) => t.id === tabId)

    expect(mockIon.gitWorktreeAdd).not.toHaveBeenCalled()
    expect(mockIon.gitIsRepo).not.toHaveBeenCalled()
    expect(tab.workingDirectory).toBe(REPO)
  })

  it('createTab resolves through the same path', async () => {
    // createTab converged correctly already; this pins that it now shares ONE
    // implementation rather than a second copy that happens to agree.
    const { state, slice } = buildHarness()

    const tabId = await slice.createTab(true)
    const tab = state.tabs.find((t: any) => t.id === tabId)

    expect(mockIon.gitWorktreeAdd).toHaveBeenCalledWith(REPO, 'main')
    expect(tab.workingDirectory).toBe(WORKTREE)
    expect(tab.worktree).toMatchObject({ worktreePath: WORKTREE })
  })
})
