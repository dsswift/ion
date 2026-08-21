// @vitest-environment jsdom
/**
 * convertToWorktree — the action-layer busy guard.
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 * Converting a tab to a worktree relocates it, and relocation restarts the
 * engine session: setTabWorkingDirectory -> relocateTabSession ->
 * restartTabEntry -> stopSession. Converting a RUNNING tab therefore aborted
 * its in-flight work, and the operator had to re-enter the tab and ask the
 * agent to resume.
 *
 * The context-menu row is disabled while the tab is busy, but the row is not
 * the only entry point — convertToWorktree is a FORWARDED Studio mirror action, so
 * the mirror window can dispatch it against state that has since moved. These
 * tests pin the guard at the action seam, where every entry point funnels.
 *
 * The busy signal is deliberately broader than `tab.status`: a tab can be idle
 * at the tab level while a dispatched sub-agent or a background build is still
 * running, and the session restart kills those too.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const REPO = '/Users/test/project'
const WORKTREE = '/Users/test/.ion/worktrees/project-a3f1'

const mockPrefs = {
  worktreeBranchDefaults: { [REPO]: 'main' } as Record<string, string>,
  setWorktreeBranchDefault: vi.fn(),
  gitOpsMode: 'worktree',
}

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => mockPrefs },
  getEffectiveTabGroups: () => [],
}))

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

// The titling seam reaches for the worktree registry over IPC; the guard has
// nothing to do with naming, so stub it out.
vi.mock('../slices/event-slice-titling', () => ({
  seedWorktreeFromTab: vi.fn(),
}))

const mockIon = {
  gitWorktreeAdd: vi.fn(async (dir: string, branch: string) => ({
    ok: true,
    worktree: { worktreePath: WORKTREE, branchName: 'wt/abc', sourceBranch: branch, repoPath: dir },
  })),
  relocateTabSession: vi.fn(async () => ({ ok: true, conversationId: 'conv-1' })),
}
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.ion = mockIon

import { createWorktreeSlice } from '../slices/worktree-slice'

function buildHarness(tabs: any[], panes: Map<string, any> = new Map()) {
  const state: any = { tabs, conversationPanes: panes }
  const set = (updater: any) => {
    const patch = typeof updater === 'function' ? updater(state) : updater
    Object.assign(state, patch)
  }
  const get = () => state
  Object.assign(state, createWorktreeSlice(set, get))
  return state
}

function tabIn(over: Partial<any> = {}) {
  return {
    id: 'tab-1',
    workingDirectory: REPO,
    conversationId: 'conv-1',
    status: 'idle',
    bashExecuting: false,
    worktree: null,
    pendingWorktreeSetup: false,
    ...over,
  }
}

/** A pane whose single instance carries the given status fields / agents. */
function paneWith(inst: Partial<any>) {
  return new Map([
    ['tab-1', { instances: [{ id: 'main', statusFields: { state: 'idle' }, agentStates: [], ...inst }] }],
  ])
}

/** Every way the conversion could have proceeded past the guard. */
function expectNoConversion(state: any) {
  expect(mockIon.gitWorktreeAdd).not.toHaveBeenCalled()
  expect(mockIon.relocateTabSession).not.toHaveBeenCalled()
  expect(state.tabs[0].pendingWorktreeSetup).toBe(false)
  expect(state.tabs[0].worktree).toBeNull()
  expect(state.tabs[0].workingDirectory).toBe(REPO)
}

describe('convertToWorktree — busy guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrefs.worktreeBranchDefaults = { [REPO]: 'main' }
  })

  it('refuses while the orchestrator is running', async () => {
    const state = buildHarness([tabIn({ status: 'running' })])

    await state.convertToWorktree('tab-1')

    expectNoConversion(state)
  })

  it('refuses while the tab is connecting', async () => {
    const state = buildHarness([tabIn({ status: 'connecting' })])

    await state.convertToWorktree('tab-1')

    expectNoConversion(state)
  })

  it('refuses while a user bash command is executing', async () => {
    const state = buildHarness([tabIn({ bashExecuting: true })])

    await state.convertToWorktree('tab-1')

    expectNoConversion(state)
  })

  it('refuses when an instance is running though the tab reads idle', async () => {
    // The case a tab.status-only guard misses.
    const state = buildHarness([tabIn()], paneWith({ statusFields: { state: 'running' } }))

    await state.convertToWorktree('tab-1')

    expectNoConversion(state)
  })

  it('refuses while a dispatched background agent is still running', async () => {
    const state = buildHarness([tabIn()], paneWith({ agentStates: [{ status: 'running' }] }))

    await state.convertToWorktree('tab-1')

    expectNoConversion(state)
  })

  it('refuses while a background shell is outstanding', async () => {
    // Relocation kills the session's background processes, so a running build
    // blocks conversion exactly as it blocks close.
    const state = buildHarness([tabIn()], paneWith({ statusFields: { state: 'idle', backgroundShells: 1 } }))

    await state.convertToWorktree('tab-1')

    expectNoConversion(state)
  })
})

describe('convertToWorktree — still converts when idle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrefs.worktreeBranchDefaults = { [REPO]: 'main' }
  })

  // Guards against over-blocking: the fix must refuse busy tabs without
  // breaking the verb for the idle case it exists to serve.
  it('converts an idle tab and relocates its live session', async () => {
    const state = buildHarness([tabIn()], paneWith({}))

    await state.convertToWorktree('tab-1')

    expect(mockIon.gitWorktreeAdd).toHaveBeenCalledWith(REPO, 'main')
    expect(mockIon.relocateTabSession).toHaveBeenCalledWith('tab-1', WORKTREE)
    expect(state.tabs[0].workingDirectory).toBe(WORKTREE)
  })

  it('converts when the tab has no pane at all', async () => {
    const state = buildHarness([tabIn()])

    await state.convertToWorktree('tab-1')

    expect(mockIon.gitWorktreeAdd).toHaveBeenCalledWith(REPO, 'main')
    expect(state.tabs[0].workingDirectory).toBe(WORKTREE)
  })

  it('falls back to the branch picker for an idle tab with no default branch', async () => {
    mockPrefs.worktreeBranchDefaults = {}
    const state = buildHarness([tabIn()], paneWith({}))

    await state.convertToWorktree('tab-1')

    expect(mockIon.gitWorktreeAdd).not.toHaveBeenCalled()
    expect(state.tabs[0].pendingWorktreeSetup).toBe(true)
  })

  it('does not raise the branch picker for a busy tab with no default branch', async () => {
    // The guard must precede the picker fallback: parking
    // pendingWorktreeSetup would pop the dialog and convert on selection.
    mockPrefs.worktreeBranchDefaults = {}
    const state = buildHarness([tabIn({ status: 'running' })], paneWith({}))

    await state.convertToWorktree('tab-1')

    expect(state.tabs[0].pendingWorktreeSetup).toBe(false)
  })
})
