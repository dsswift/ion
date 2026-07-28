/**
 * Git conflict slice — the visibility layer for failed syncs.
 *
 * The defect these pin: a conflicted sync returned
 * `{ ok: false, hasConflicts: true, error: <actionable message> }` and every
 * consumer discarded it. The operator pressed Sync, saw nothing, and believed
 * it succeeded while the worktree sat mid-rebase. These tests assert the
 * signal becomes state, and that the AI-assist action sends its exact prompt.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import { createGitConflictSlice, CONFLICT_ASSIST_PROMPT } from '../slices/git-conflict-slice'
import { createWorktreeInventorySlice } from '../slices/worktree-inventory-slice'
import type { State, GitConflictAlert } from '../session-store-types'

const WT = '/home/dev/.ion/worktrees/proj-a1'

interface Harness {
  slice: Partial<State>
  state: () => Record<string, unknown>
  alerts: () => Map<string, GitConflictAlert>
}

function harness(extra: Record<string, unknown> = {}): Harness {
  let state: Record<string, unknown> = {
    gitConflictAlerts: new Map<string, GitConflictAlert>(),
    worktreeInventory: new Map(),
    tabs: [],
    activeTabId: null,
    ...extra,
  }
  const set = (fn: (s: Record<string, unknown>) => Record<string, unknown>): void => {
    state = { ...state, ...fn(state) }
  }
  const get = (): Record<string, unknown> => state
  const slice = {
    ...createGitConflictSlice(
      set as unknown as Parameters<typeof createGitConflictSlice>[0],
      get as unknown as Parameters<typeof createGitConflictSlice>[1],
    ),
    ...createWorktreeInventorySlice(
      set as unknown as Parameters<typeof createWorktreeInventorySlice>[0],
      get as unknown as Parameters<typeof createWorktreeInventorySlice>[1],
    ),
  } as Partial<State>
  state = { ...state, ...slice, ...extra }
  return {
    slice,
    state: () => state,
    alerts: () => state.gitConflictAlerts as Map<string, GitConflictAlert>,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a failed sync records a visible alert', () => {
  it('records source sync with the operator-facing message', async () => {
    const h = harness()
    ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: {
        gitWorktreeSync: vi.fn().mockResolvedValue({
          ok: false, hasConflicts: true, error: 'Syncing from josh hit a conflict.',
        }),
        gitWorktreeInventory: vi.fn().mockResolvedValue({ worktrees: [] }),
      },
    }

    await h.slice.syncWorktree!(WT, 'josh', '/repo')

    const alert = h.alerts().get(WT)
    expect(alert).toBeDefined()
    expect(alert!.source).toBe('sync')
    expect(alert!.operationState).toBe('rebasing')
    expect(alert!.message).toContain('hit a conflict')
    expect(alert!.dismissed).toBe(false)
  })

  it('records nothing for a non-conflict refusal (dirty worktree)', async () => {
    const h = harness()
    ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: {
        gitWorktreeSync: vi.fn().mockResolvedValue({ ok: false, refusedDirty: true, error: 'dirty' }),
        gitWorktreeInventory: vi.fn().mockResolvedValue({ worktrees: [] }),
      },
    }
    await h.slice.syncWorktree!(WT, 'josh', '/repo')
    expect(h.alerts().get(WT)).toBeUndefined()
  })
})

describe('inventory refresh drives detection and clearing', () => {
  const entry = (operationState?: string) => ({
    worktreePath: WT, branchName: 'wt/a1', label: 'proj-a1', sourceBranch: 'josh',
    head: 'abc', lastCommitSubject: 'x', isDirty: false, unlandedCommitCount: 0,
    needsSync: false, safeToDiscard: false, operationState,
  })

  it('records a detected mid-operation worktree', async () => {
    const h = harness()
    ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: { gitWorktreeInventory: vi.fn().mockResolvedValue({ worktrees: [entry('rebasing')] }) },
    }
    await h.slice.refreshWorktreeInventory!('/repo')
    expect(h.alerts().get(WT)?.source).toBe('detected')
    expect(h.alerts().get(WT)?.operationState).toBe('rebasing')
  })

  it('clears the alert when the operation completes', async () => {
    const h = harness()
    ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: { gitWorktreeInventory: vi.fn().mockResolvedValue({ worktrees: [entry('rebasing')] }) },
    }
    await h.slice.refreshWorktreeInventory!('/repo')
    expect(h.alerts().has(WT)).toBe(true)

    ;(globalThis as unknown as { window: { ion: Record<string, unknown> } }).window.ion
      .gitWorktreeInventory = vi.fn().mockResolvedValue({ worktrees: [entry(undefined)] })
    await h.slice.refreshWorktreeInventory!('/repo')
    expect(h.alerts().has(WT)).toBe(false)
  })

  it('a detection poll does not resurrect a dismissed toast', async () => {
    const h = harness()
    ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: { gitWorktreeInventory: vi.fn().mockResolvedValue({ worktrees: [entry('rebasing')] }) },
    }
    await h.slice.refreshWorktreeInventory!('/repo')
    h.slice.dismissConflictAlert!(WT)
    expect(h.alerts().get(WT)?.dismissed).toBe(true)

    await h.slice.refreshWorktreeInventory!('/repo')
    expect(h.alerts().get(WT)?.dismissed).toBe(true)
  })

  it('a fresh sync failure re-raises a dismissed toast', () => {
    const h = harness()
    h.slice.recordConflictAlert!(WT, { source: 'detected', operationState: 'rebasing' })
    h.slice.dismissConflictAlert!(WT)
    expect(h.alerts().get(WT)?.dismissed).toBe(true)

    // A new failure IS new information: the operator acted (synced) and it
    // failed again — that must not stay hidden behind an old dismissal.
    h.slice.recordConflictAlert!(WT, { source: 'sync', operationState: 'rebasing' })
    expect(h.alerts().get(WT)?.dismissed).toBe(false)
  })
})

describe('openConflictAssist', () => {
  it('creates a conversation in the directory and submits the exact prompt', async () => {
    const submit = vi.fn()
    const createTabInDirectory = vi.fn().mockResolvedValue('tab-new')
    const h = harness({ submit, createTabInDirectory, tabs: [], activeTabId: null })

    const tabId = await h.slice.openConflictAssist!(WT)

    expect(tabId).toBe('tab-new')
    expect(createTabInDirectory).toHaveBeenCalledWith(WT, false, true)
    // The prompt is specified verbatim; any drift is a defect.
    expect(submit).toHaveBeenCalledWith('tab-new', 'Please fix my currently in-progress rebase.')
    expect(CONFLICT_ASSIST_PROMPT).toBe('Please fix my currently in-progress rebase.')
  })

  it('focuses an existing conversation in the directory instead of stacking one', async () => {
    const submit = vi.fn()
    const selectTab = vi.fn()
    const createTabInDirectory = vi.fn()
    const h = harness({
      submit, selectTab, createTabInDirectory,
      tabs: [{ id: 'tab-existing', workingDirectory: WT }],
      activeTabId: 'other',
    })

    const tabId = await h.slice.openConflictAssist!(WT)

    expect(tabId).toBe('tab-existing')
    expect(selectTab).toHaveBeenCalledWith('tab-existing')
    expect(createTabInDirectory).not.toHaveBeenCalled()
    expect(submit).toHaveBeenCalledWith('tab-existing', CONFLICT_ASSIST_PROMPT)
  })
})
