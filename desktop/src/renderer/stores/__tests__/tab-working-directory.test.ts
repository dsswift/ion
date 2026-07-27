// @vitest-environment jsdom
/**
 * setTabWorkingDirectory — changing a tab's directory moves its engine session.
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 * `relocateTabSession` was fully implemented, IPC-exposed, and unit-tested in
 * the main process, with ZERO callers anywhere in the renderer. Every path that
 * changed a tab's directory patched renderer state only, so a live conversation
 * kept working in its old directory while the UI showed the new one:
 *
 *   - setupWorktree / convertToWorktree — agent stays in the base repo
 *   - retireWorktree — conversation left pointed at a DELETED directory
 *
 * These tests assert the IPC relocation actually fires, which is what was
 * missing. A state-only assertion passes on the unfixed code.
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

const mockIon = {
  gitWorktreeAdd: vi.fn(async (dir: string, branch: string) => ({
    ok: true,
    worktree: { worktreePath: WORKTREE, branchName: 'wt/abc', sourceBranch: branch, repoPath: dir },
  })),
  gitWorktreeRetire: vi.fn(async () => ({ ok: true, workingDirectory: REPO })),
  gitWorktreeInventory: vi.fn(async () => ({ worktrees: [] })),
  relocateTabSession: vi.fn(async () => ({ ok: true, conversationId: 'conv-1' })),
}
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.ion = mockIon

import { setTabWorkingDirectory } from '../slices/tab-working-directory'
import { createWorktreeSlice } from '../slices/worktree-slice'
import { createWorktreeInventorySlice } from '../slices/worktree-inventory-slice'

function buildHarness(tabs: any[]) {
  const state: any = { tabs, conversationPanes: new Map(), worktreeInventory: new Map() }
  const set = (updater: any) => {
    const patch = typeof updater === 'function' ? updater(state) : updater
    Object.assign(state, patch)
  }
  const get = () => state
  Object.assign(state, createWorktreeSlice(set, get), createWorktreeInventorySlice(set, get))
  return { state, set, get }
}

function liveTab(over: Partial<any> = {}) {
  return {
    id: 'tab-1',
    workingDirectory: REPO,
    conversationId: 'conv-1',
    worktree: null,
    pendingWorktreeSetup: false,
    ...over,
  }
}

describe('setTabWorkingDirectory', () => {
  beforeEach(() => vi.clearAllMocks())

  it('patches the store AND relocates the live engine session', async () => {
    const { state, set, get } = buildHarness([liveTab()])

    const ok = await setTabWorkingDirectory(set, get, 'tab-1', WORKTREE, { worktree: null })

    expect(ok).toBe(true)
    expect(state.tabs[0].workingDirectory).toBe(WORKTREE)
    expect(mockIon.relocateTabSession).toHaveBeenCalledWith('tab-1', WORKTREE)
  })

  it('skips the relocation when the tab has no conversation yet', async () => {
    // Nothing to move: the directory it was just given is what its first start
    // will use.
    const { state, set, get } = buildHarness([liveTab({ conversationId: null })])

    const ok = await setTabWorkingDirectory(set, get, 'tab-1', WORKTREE)

    expect(ok).toBe(true)
    expect(state.tabs[0].workingDirectory).toBe(WORKTREE)
    expect(mockIon.relocateTabSession).not.toHaveBeenCalled()
  })

  it('keeps the store patch when the relocation fails', async () => {
    // The store must carry the new directory regardless, so the next prompt
    // reconciles the session in the main process.
    mockIon.relocateTabSession.mockResolvedValueOnce({ ok: false, error: 'engine offline' } as any)
    const { state, set, get } = buildHarness([liveTab()])

    const ok = await setTabWorkingDirectory(set, get, 'tab-1', WORKTREE)

    expect(ok).toBe(false)
    expect(state.tabs[0].workingDirectory).toBe(WORKTREE)
  })
})

describe('worktree attach paths relocate the session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrefs.worktreeBranchDefaults = { [REPO]: 'main' }
  })

  it('setupWorktree relocates into the new worktree', async () => {
    const { state } = buildHarness([liveTab()])

    await state.setupWorktree('tab-1', 'main', false)

    expect(mockIon.relocateTabSession).toHaveBeenCalledWith('tab-1', WORKTREE)
    expect(state.tabs[0].workingDirectory).toBe(WORKTREE)
    expect(state.tabs[0].worktree).toMatchObject({ worktreePath: WORKTREE })
  })

  it('convertToWorktree relocates into the new worktree', async () => {
    const { state } = buildHarness([liveTab()])

    await state.convertToWorktree('tab-1')

    expect(mockIon.relocateTabSession).toHaveBeenCalledWith('tab-1', WORKTREE)
    expect(state.tabs[0].workingDirectory).toBe(WORKTREE)
  })

  it('convertToWorktree falls back to the branch picker with no default', async () => {
    mockPrefs.worktreeBranchDefaults = {}
    const { state } = buildHarness([liveTab()])

    await state.convertToWorktree('tab-1')

    expect(mockIon.gitWorktreeAdd).not.toHaveBeenCalled()
    expect(state.tabs[0].pendingWorktreeSetup).toBe(true)
  })
})

describe('retireWorktree', () => {
  beforeEach(() => vi.clearAllMocks())

  // The conversation must not be left pointing at a directory that no longer
  // exists. Before the fix this return value was discarded entirely.
  it('relocates the occupying conversation to the repo before leaving it dead', async () => {
    const { state } = buildHarness([
      liveTab({ workingDirectory: WORKTREE, worktree: { worktreePath: WORKTREE } }),
    ])

    const res = await state.retireWorktree(REPO, WORKTREE, 'wt/abc')

    expect(res.ok).toBe(true)
    expect(mockIon.relocateTabSession).toHaveBeenCalledWith('tab-1', REPO)
    expect(state.tabs[0].workingDirectory).toBe(REPO)
    expect(state.tabs[0].worktree).toBeNull()
  })

  it('relocates nothing when the retire is refused', async () => {
    mockIon.gitWorktreeRetire.mockResolvedValueOnce({ ok: false, error: 'unlanded work' } as any)
    const { state } = buildHarness([liveTab({ workingDirectory: WORKTREE })])

    const res = await state.retireWorktree(REPO, WORKTREE, 'wt/abc')

    expect(res.ok).toBe(false)
    // The worktree still exists, so the conversation must stay in it.
    expect(mockIon.relocateTabSession).not.toHaveBeenCalled()
    expect(state.tabs[0].workingDirectory).toBe(WORKTREE)
  })

  it('retires a worktree with no open conversation without relocating anything', async () => {
    const { state } = buildHarness([liveTab({ workingDirectory: REPO })])

    const res = await state.retireWorktree(REPO, WORKTREE, 'wt/abc')

    expect(res.ok).toBe(true)
    expect(mockIon.relocateTabSession).not.toHaveBeenCalled()
  })
})
