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
  addRecentBaseDirectory: vi.fn(),
  setWorktreeBranchDefault: vi.fn(),
}

vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: { getState: () => mockPrefs },
}))

vi.mock('../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

vi.mock('../../components/TerminalPanel', () => ({ destroyTerminalInstance: vi.fn() }))

// session-store-helpers.ts imports a binary asset (notification.mp3) that
// resolves fine under the desktop's Vite config but not here; stub the pure
// helpers tab-slice.ts actually uses.
vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn((..._a: any[]) => ({
    id: 'local-id',
    title: 'New Tab',
    conversationId: null,
    historicalSessionIds: [],
    lastKnownSessionId: null,
    status: 'idle',
    activeRequestId: null,
    lastEventAt: null,
    hasUnread: false,
    currentActivity: '',
    attachments: [],
    lastResult: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '~',
    hasChosenDirectory: false,
    additionalDirs: [],
    permissionMode: 'auto',
    bashResults: [],
    bashExecuting: false,
    bashExecId: null,
    pillColor: null,
    forkedFromSessionId: null,
    worktree: null,
    pendingWorktreeSetup: false,
    contextTokens: null,
    contextPercent: null,
    contextWindow: null,
    isCompacting: false,
    isTerminalOnly: false,
    engineProfileId: null,
  })),
  isReusableBlankConversationTab: vi.fn((..._a: any[]) => false),
  initialModelOverride: vi.fn((..._a: any[]) => null),
  initialPermissionMode: vi.fn((..._a: any[]) => 'auto'),
  initialThinkingEffort: vi.fn((..._a: any[]) => 'off'),
  nextMsgId: vi.fn((..._a: any[]) => `msg-${Math.random().toString(36).slice(2, 8)}`),
  playNotificationIfHidden: vi.fn(async (..._a: any[]) => {}),
}))

vi.mock('@ion/shared/clear-divider', () => ({
  formatSessionStartDivider: vi.fn((..._a: any[]) => '── Session started ──'),
}))

const mockIon = {
  worktreesOffered: vi.fn(async () => true),
  gitIsRepo: vi.fn(async (dir: string) => {
    calls.push(`gitIsRepo:${dir}`)
    return { isRepo: true }
  }),
  gitWorktreeAdd: vi.fn(async (dir: string, branch: string, conversation?: { ephemeral?: boolean }) => {
    calls.push(`gitWorktreeAdd:${dir}@${branch}`)
    return {
      ok: true,
      worktree: { worktreePath: WORKTREE, branchName: 'wt/abc', sourceBranch: branch, repoPath: dir },
      ephemeral: conversation?.ephemeral === true,
    }
  }),
  gitWorktreeSetEphemeralOwner: vi.fn(async (worktreePath: string, tabId: string) => {
    calls.push(`gitWorktreeSetEphemeralOwner:${worktreePath}@${tabId}`)
    return { ok: true }
  }),
  createTab: vi.fn(async (..._a: any[]) => ({ tabId: 'tab-1' })),
  adoptTab: vi.fn(async (..._a: any[]) => ({ tabId: 'tab-1' })),
  engineStart: vi.fn(async (..._a: any[]) => ({ ok: true })),
  ensureEngineSession: vi.fn(async (opts: { workingDirectory: string }) => {
    calls.push(`ensureEngineSession:${opts.workingDirectory}`)
    return { ok: true }
  }),
  setPermissionMode: vi.fn(),
  relocateTabSession: vi.fn(async (..._a: any[]) => ({ ok: true })),
}

vi.mock('../host-api', () => ({
  echoUserTurnToStudio: vi.fn(),
  // A new conversation's directory is checked against this machine
  // (engine-slice-create.ts). These tests name fixture paths, so the check
  // answers yes and the ordering under test is what is exercised.
  fsExists: vi.fn(async () => ({ exists: true })),
  gitIsRepo: (...args: [string]) => mockIon.gitIsRepo(...args),
  worktreesOffered: () => mockIon.worktreesOffered(),
  gitWorktreeAdd: (...args: [string, string, { ephemeral?: boolean }?]) => mockIon.gitWorktreeAdd(...args),
  gitWorktreeSetEphemeralOwner: (...args: [string, string]) => mockIon.gitWorktreeSetEphemeralOwner(...args),
  createTab: (...args: any[]) => mockIon.createTab(...(args as [])),
  adoptTab: (...args: any[]) => mockIon.adoptTab(...(args as [])),
  engineStart: (...args: any[]) => mockIon.engineStart(...args),
  ensureEngineSession: (...args: [{ workingDirectory: string }]) => mockIon.ensureEngineSession(...args),
  setPermissionMode: (...args: any[]) => mockIon.setPermissionMode(...args),
  relocateTabSession: (...args: any[]) => mockIon.relocateTabSession(...args),
  closeTab: vi.fn(),
  deleteTabContent: vi.fn(),
  saveSessionLabel: vi.fn(),
  start: vi.fn(),
  tabMetaChanged: vi.fn(),
  terminalDestroy: vi.fn(),
}))

import { createTabSlice } from '../slices/tab-slice'
import { createConversationTabAction } from '../slices/engine-slice-create'

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
  return { state, slice, set, get }
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

  it('opens in the directory itself, with no branch picker, where worktrees are not offered', async () => {
    mockIon.worktreesOffered.mockResolvedValueOnce(false)
    mockPrefs.worktreeBranchDefaults = {}
    const { state, slice } = buildHarness()

    const tabId = await slice.createTabInDirectory(REPO, true, true)
    const tab = state.tabs.find((t: any) => t.id === tabId)

    expect(mockIon.gitIsRepo).not.toHaveBeenCalled()
    expect(mockIon.gitWorktreeAdd).not.toHaveBeenCalled()
    expect(tab.pendingWorktreeSetup).toBeFalsy()
    expect(tab.workingDirectory).toBe(REPO)
  })

  it('uses an explicitly selected branch instead of the saved default', async () => {
    const { state, slice } = buildHarness()

    const tabId = await slice.createTabInDirectory(REPO, true, true, 'release')
    const tab = state.tabs.find((item: any) => item.id === tabId)

    expect(mockIon.gitWorktreeAdd).toHaveBeenCalledWith(REPO, 'release', { ephemeral: undefined })
    expect(tab.worktree).toMatchObject({ sourceBranch: 'release' })
    // Not ephemeral, so there is no owner to bind.
    expect(mockIon.gitWorktreeSetEphemeralOwner).not.toHaveBeenCalled()
  })

  it('binds an ephemeral worktree to the new conversation before the tab exists', async () => {
    const { state, set, get } = buildHarness()

    const tabId = await createConversationTabAction(set, get)(REPO, { useWorktree: true, ephemeralWorktree: true })

    expect(mockIon.gitWorktreeAdd).toHaveBeenCalledWith(REPO, 'main', { ephemeral: true })
    expect(mockIon.gitWorktreeSetEphemeralOwner).toHaveBeenCalledWith(WORKTREE, tabId)
    expect(state.tabs.find((t: any) => t.id === tabId)?.workingDirectory).toBe(WORKTREE)
    const bindIdx = calls.findIndex((c) => c.startsWith('gitWorktreeSetEphemeralOwner:'))
    const ensureIdx = calls.findIndex((c) => c.startsWith('ensureEngineSession:'))
    expect(bindIdx).toBeGreaterThanOrEqual(0)
    expect(ensureIdx === -1 || bindIdx < ensureIdx).toBe(true)
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

    // createTab mints the id first, so the owner rides the create itself.
    expect(mockIon.gitWorktreeAdd).toHaveBeenCalledWith(REPO, 'main', { ownerTabId: tabId })
    expect(tab.workingDirectory).toBe(WORKTREE)
    expect(tab.worktree).toMatchObject({ worktreePath: WORKTREE })
  })
})
