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

const applyPermissionModeForTab = vi.fn()
vi.mock('../slices/tab-slice-permission-mode', () => ({
  applyPermissionModeForTab: (...args: unknown[]) => applyPermissionModeForTab(...args),
}))

import { createGitConflictSlice, CONFLICT_ASSIST_PROMPT, CONFLICT_ASSIST_TIER } from '../slices/git-conflict-slice'
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

  it('records a REFUSAL alert for a dirty worktree, with the remediation message', async () => {
    // The live incident: sync refused (dirty), logged, and nothing shown — the
    // spinner stopped and the operator was left guessing. A refusal is now an
    // alert of kind 'refusal': toast with the message, no Resolve button
    // (nothing is in progress to resolve).
    const h = harness()
    ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: {
        gitWorktreeSync: vi.fn().mockResolvedValue({
          ok: false, refusedDirty: true,
          error: 'This worktree has uncommitted changes, so it cannot be synced.',
        }),
        gitWorktreeInventory: vi.fn().mockResolvedValue({ worktrees: [] }),
      },
    }
    await h.slice.syncWorktree!(WT, 'josh', '/repo')

    const alert = h.alerts().get(WT)
    expect(alert).toBeDefined()
    expect(alert!.kind).toBe('refusal')
    expect(alert!.source).toBe('sync')
    expect(alert!.operationState).toBeUndefined()
    expect(alert!.message).toContain('uncommitted changes')
  })

  it('clears a refusal alert only when the worktree goes CLEAN', async () => {
    // No git state says "was refused", so the refusal must survive the very
    // next inventory refresh (which reports no operation in progress) while
    // the worktree is still dirty — and clear once it is clean.
    const entry = (isDirty: boolean) => ({
      worktreePath: WT, branchName: 'wt/a1', label: 'proj-a1', sourceBranch: 'josh',
      head: 'abc', lastCommitSubject: 'x', isDirty, unlandedCommitCount: 0,
      needsSync: true, safeToDiscard: false,
    })
    const h = harness()
    h.slice.recordConflictAlert!(WT, { source: 'sync', kind: 'refusal', message: 'dirty' })

    ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: { gitWorktreeInventory: vi.fn().mockResolvedValue({ worktrees: [entry(true)] }) },
    }
    await h.slice.refreshWorktreeInventory!('/repo')
    expect(h.alerts().get(WT)?.kind).toBe('refusal') // survives while dirty

    ;(globalThis as unknown as { window: { ion: Record<string, unknown> } }).window.ion
      .gitWorktreeInventory = vi.fn().mockResolvedValue({ worktrees: [entry(false)] })
    await h.slice.refreshWorktreeInventory!('/repo')
    expect(h.alerts().has(WT)).toBe(false) // clean clears it
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
  /** window.ion with a configured standard tier, overridable per test. */
  function ionWith(tier: Partial<{ model: string; configured: boolean }> = {}): void {
    ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
      ion: {
        resolveModelTier: vi.fn().mockResolvedValue({
          tier: CONFLICT_ASSIST_TIER,
          model: tier.model ?? 'prov/claude-sonnet-4-6',
          fallbacks: [],
          configured: tier.configured ?? true,
        }),
      },
    }
  }

  it('creates a conversation in the directory and submits the exact prompt', async () => {
    ionWith()
    const submit = vi.fn()
    const setTabModel = vi.fn()
    const createTabInDirectory = vi.fn().mockResolvedValue('tab-new')
    const h = harness({ submit, setTabModel, createTabInDirectory, tabs: [], activeTabId: null })

    const tabId = await h.slice.openConflictAssist!(WT)

    expect(tabId).toBe('tab-new')
    expect(createTabInDirectory).toHaveBeenCalledWith(WT, false, true)
    // The prompt is specified verbatim; any drift is a defect.
    expect(submit).toHaveBeenCalledWith('tab-new', 'Please fix my currently in-progress rebase.')
    expect(CONFLICT_ASSIST_PROMPT).toBe('Please fix my currently in-progress rebase.')
  })

  it('creates a FRESH conversation even when one already exists in the directory', async () => {
    // The regression this pins: the first version focused the existing
    // conversation and submitted there — interrupting the operator's live
    // development thread, whose context could also sway the rebase fix. The
    // assist must always get a bare conversation with no prior context.
    ionWith()
    const submit = vi.fn()
    const selectTab = vi.fn()
    const setTabModel = vi.fn()
    const createTabInDirectory = vi.fn().mockResolvedValue('tab-fresh')
    const h = harness({
      submit, selectTab, setTabModel, createTabInDirectory,
      tabs: [{ id: 'tab-existing', workingDirectory: WT }],
      activeTabId: 'tab-existing',
    })

    const tabId = await h.slice.openConflictAssist!(WT)

    expect(tabId).toBe('tab-fresh')
    expect(createTabInDirectory).toHaveBeenCalledWith(WT, false, true)
    // The existing conversation is untouched: not focused, nothing submitted.
    expect(selectTab).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalledWith('tab-existing', CONFLICT_ASSIST_PROMPT)
    expect(submit).toHaveBeenCalledWith('tab-fresh', CONFLICT_ASSIST_PROMPT)
  })

  it('refuses with a remediation message when the standard tier is not configured', async () => {
    // The assist runs on the standard tier by specification — never the
    // operator's default (often a reasoning model), never highest/lowest.
    // No tier, no tab: the refusal must create nothing to clean up.
    ionWith({ configured: false })
    const submit = vi.fn()
    const createTabInDirectory = vi.fn()
    const h = harness({ submit, createTabInDirectory, tabs: [], activeTabId: null })

    await expect(h.slice.openConflictAssist!(WT)).rejects.toThrow(/standard.*models\.json/s)
    expect(createTabInDirectory).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('pins the tier model on the fresh conversation', async () => {
    ionWith({ model: 'prov/claude-sonnet-4-6' })
    const submit = vi.fn()
    const setTabModel = vi.fn()
    const createTabInDirectory = vi.fn().mockResolvedValue('tab-new')
    const h = harness({ submit, setTabModel, createTabInDirectory, tabs: [], activeTabId: null })

    await h.slice.openConflictAssist!(WT)

    expect(setTabModel).toHaveBeenCalledWith('tab-new', 'prov/claude-sonnet-4-6')
  })

  it('forces auto mode on the fresh conversation regardless of the default', async () => {
    // A plan-mode default would park the assist writing a plan for work the
    // operator already requested verbatim.
    ionWith()
    const setTabModel = vi.fn()
    const createTabInDirectory = vi.fn().mockResolvedValue('tab-new')
    const h = harness({ submit: vi.fn(), setTabModel, createTabInDirectory, tabs: [], activeTabId: null })

    await h.slice.openConflictAssist!(WT)

    expect(applyPermissionModeForTab).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'tab-new', 'auto', 'conflict_assist',
    )
  })
})
