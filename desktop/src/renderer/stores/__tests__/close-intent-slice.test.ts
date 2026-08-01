/**
 * close-intent slice — the close-confirmation flow.
 *
 * ── The defect these pin ────────────────────────────────────────────────────
 * `decideWorktreeClose` shipped fully written and fully tested with NO
 * production caller: the appraisal IPC existed, the decision function existed,
 * and the close call site was never written. So the documented behaviour —
 * "closing tells you when you are walking away from unlanded work" — did not
 * happen. Closing a worktree conversation sitting on 4 unlanded commits was
 * indistinguishable from closing an empty scratch tab.
 *
 * Close also confirmed two different ways (inline Yes/No in the pill vs. the
 * Cmd+W dialog), so one verb had two behaviours and the narrow one had no room
 * for the warning.
 *
 * These tests fail against that state: no warning is ever produced, because
 * nothing calls the decision.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { createCloseIntentSlice } from '../slices/close-intent-slice'
import type { State, StoreSet, StoreGet } from '../session-store-types'
import type { WorktreeAppraisalWire } from '../../../shared/types-git'

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

const WT = '/Users/test/.ion/worktrees/ion-a3f1'

function appraisal(over: Partial<WorktreeAppraisalWire> = {}): WorktreeAppraisalWire {
  return {
    hasUncommittedChanges: false,
    uncommittedPaths: [],
    unlandedCommitCount: 0,
    fullyLanded: true,
    safeToDiscard: true,
    ...over,
  }
}

function worktreeTab(id = 't-wt') {
  return {
    id,
    title: 'Worktree work',
    customTitle: null,
    workingDirectory: WT,
    status: 'idle',
    worktree: {
      worktreePath: WT,
      branchName: 'wt/ion-a3f1',
      sourceBranch: 'main',
      repoPath: '/Users/test/src/ion',
    },
  }
}

function plainTab(id = 't-plain') {
  return {
    id,
    title: 'Plain chat',
    customTitle: null,
    workingDirectory: '/Users/test/src/ion',
    status: 'idle',
    worktree: null,
  }
}

/**
 * Minimal store harness. The slice reads tabs/conversationPanes and calls
 * closeTab, so those are all that need standing up.
 */
function harness(tabs: unknown[], panes = new Map<string, unknown>()) {
  let state: Record<string, unknown> = {
    tabs,
    conversationPanes: panes,
    closeIntent: null,
    closeTab: vi.fn(),
  }
  const set = ((patch: unknown) => {
    const next = typeof patch === 'function'
      ? (patch as (s: Record<string, unknown>) => Record<string, unknown>)(state)
      : patch as Record<string, unknown>
    state = { ...state, ...next }
  }) as unknown as StoreSet
  const get = (() => state) as unknown as StoreGet
  const slice = createCloseIntentSlice(set, get) as unknown as Record<string, (...a: unknown[]) => unknown>
  state = { ...state, ...slice }
  return {
    get state() { return state as unknown as State },
    requestCloseTab: (id: string) => (state.requestCloseTab as (i: string) => Promise<void>)(id),
    confirmCloseTab: () => (state.confirmCloseTab as () => void)(),
    cancelCloseTab: () => (state.cancelCloseTab as () => void)(),
    closeTab: () => state.closeTab as ReturnType<typeof vi.fn>,
  }
}

let appraise: ReturnType<typeof vi.fn>

beforeEach(() => {
  appraise = vi.fn().mockResolvedValue(appraisal())
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    ion: { gitWorktreeAppraise: appraise },
  }
})

describe('requestCloseTab', () => {
  it('raises an intent with no warning for a plain conversation', async () => {
    const h = harness([plainTab()])
    await h.requestCloseTab('t-plain')

    expect(h.state.closeIntent).toMatchObject({ tabId: 't-plain', warning: null })
    // A plain tab has no worktree, so it must not pay for a git appraisal.
    expect(appraise).not.toHaveBeenCalled()
  })

  it('raises an intent with no warning for a clean, fully-landed worktree', async () => {
    const h = harness([worktreeTab()])
    await h.requestCloseTab('t-wt')

    expect(appraise).toHaveBeenCalledWith(WT, 'main')
    expect(h.state.closeIntent).toMatchObject({ tabId: 't-wt', warning: null })
  })

  it('warns with the unlanded commit count', async () => {
    appraise.mockResolvedValue(appraisal({
      unlandedCommitCount: 4, fullyLanded: false, safeToDiscard: false,
    }))
    const h = harness([worktreeTab()])
    await h.requestCloseTab('t-wt')

    expect(h.state.closeIntent?.warning).toContain('4 commits not yet landed')
    // Reassurance is part of the contract: the operator must know the close is
    // not destructive.
    expect(h.state.closeIntent?.warning).toMatch(/nothing is deleted/i)
  })

  it('warns about uncommitted files', async () => {
    appraise.mockResolvedValue(appraisal({
      hasUncommittedChanges: true, uncommittedPaths: ['a.ts', 'b.ts'], safeToDiscard: false,
    }))
    const h = harness([worktreeTab()])
    await h.requestCloseTab('t-wt')

    expect(h.state.closeIntent?.warning).toContain('2 uncommitted files')
  })

  // Fail-closed: an appraisal that throws must not read as "nothing to warn".
  it('warns conservatively when the appraisal throws', async () => {
    appraise.mockRejectedValue(new Error('git exploded'))
    const h = harness([worktreeTab()])
    await h.requestCloseTab('t-wt')

    expect(h.state.closeIntent?.warning).toMatch(/could not be verified/i)
  })

  it('raises nothing for an unknown tab', async () => {
    const h = harness([plainTab()])
    await h.requestCloseTab('nope')

    expect(h.state.closeIntent).toBeNull()
  })

  // The running-work guard short-circuits before a dialog is raised, so the
  // operator never answers a dialog that would then be refused.
  it('refuses to raise an intent while work is in flight', async () => {
    const panes = new Map<string, unknown>([['t-wt', {
      instances: [{ id: 'main', statusFields: { state: 'running' }, agentStates: [] }],
    }]])
    const h = harness([worktreeTab()], panes)
    await h.requestCloseTab('t-wt')

    expect(h.state.closeIntent).toBeNull()
  })
})

describe('confirmCloseTab / cancelCloseTab', () => {
  it('closes the tab and clears the intent on confirm', async () => {
    const h = harness([worktreeTab()])
    await h.requestCloseTab('t-wt')
    h.confirmCloseTab()

    expect(h.closeTab()).toHaveBeenCalledWith('t-wt')
    expect(h.state.closeIntent).toBeNull()
  })

  it('clears the intent without closing on cancel', async () => {
    const h = harness([worktreeTab()])
    await h.requestCloseTab('t-wt')
    h.cancelCloseTab()

    expect(h.closeTab()).not.toHaveBeenCalled()
    expect(h.state.closeIntent).toBeNull()
  })

  it('is a no-op when there is no pending intent', () => {
    const h = harness([worktreeTab()])
    h.confirmCloseTab()

    expect(h.closeTab()).not.toHaveBeenCalled()
  })
})
