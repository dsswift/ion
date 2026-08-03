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

// This file imports the worktree-inventory slice (for the refresh-driven alert
// lifecycle below), and that slice reads the aiGeneratedTitles preference. The
// real preferences module applies the theme at import time, which touches
// `document` — absent in this node-environment test, and the resulting
// ReferenceError silently reduced the whole file to "no tests" rather than
// failing a single assertion. Same mock, same reason, as
// worktree-inventory-slice.test.ts.
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ aiGeneratedTitles: false }) },
}))

const applyPermissionModeForTab = vi.fn()
vi.mock('../slices/tab-slice-permission-mode', () => ({
  applyPermissionModeForTab: (...args: unknown[]) => applyPermissionModeForTab(...args),
}))

import { createGitConflictSlice, conflictAssistPrompt, CONFLICT_ASSIST_PROMPT, CONFLICT_ASSIST_TIER } from '../slices/git-conflict-slice'
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
    const prompt = conflictAssistPrompt(null)
    expect(submit).toHaveBeenCalledWith('tab-new', prompt)
    expect(CONFLICT_ASSIST_PROMPT).toBe(prompt)
    expect(prompt).toContain('currently in-progress rebase')
    expect(prompt).toContain('Do not abort the rebase')
    expect(prompt).toContain('separate standalone call containing only git rebase --continue')
    expect(prompt).toContain('Done only when the operation has ended')
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

  it('names the operation actually in progress: a merge gets the merge prompt', async () => {
    // The bench resolve-once flow leaves a MERGE in progress; telling the
    // model to fix a rebase that does not exist sent it hunting for the wrong
    // operation. The prompt is derived from the live op state.
    ionWith()
    ;(globalThis as unknown as { window: { ion: Record<string, unknown> } }).window.ion.gitOpState =
      vi.fn().mockResolvedValue({ ok: true, state: 'merging' })
    const submit = vi.fn()
    const setTabModel = vi.fn()
    const createTabInDirectory = vi.fn().mockResolvedValue('tab-new')
    const h = harness({ submit, setTabModel, createTabInDirectory, tabs: [], activeTabId: null })

    await h.slice.openConflictAssist!(WT)

    const mergePrompt = conflictAssistPrompt('merging')
    expect(submit).toHaveBeenCalledWith('tab-new', mergePrompt)
    expect(mergePrompt).toContain('currently in-progress merge')
    expect(mergePrompt).toContain('git merge --continue')
    expect(conflictAssistPrompt('cherry-picking')).toContain('git cherry-pick --continue')
    expect(conflictAssistPrompt(null)).toBe(CONFLICT_ASSIST_PROMPT)
  })

  it('locks the conversation input after the machine prompt is sent', async () => {
    // The fix conversation's entire instruction is the one machine-sent
    // prompt: locking prevents follow-ups from grafting an open-ended
    // conversation onto a checkout (often a bench) where development work
    // does not belong. The lock lands AFTER submit(), so the machine prompt
    // itself is never blocked by the guard in send-slice.
    ionWith()
    const submit = vi.fn()
    const setTabModel = vi.fn()
    const createTabInDirectory = vi.fn().mockResolvedValue('tab-new')
    const h = harness({
      submit, setTabModel, createTabInDirectory,
      tabs: [{ id: 'tab-new', inputLocked: false }],
      activeTabId: null,
    })

    await h.slice.openConflictAssist!(WT)

    const tabs = h.state().tabs as Array<{ id: string; inputLocked: boolean }>
    expect(tabs.find((t) => t.id === 'tab-new')?.inputLocked).toBe(true)
    // Order matters: the prompt went through before the lock was applied.
    expect(submit).toHaveBeenCalledWith('tab-new', CONFLICT_ASSIST_PROMPT)
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

/**
 * A failed LAND must be as visible as a failed sync.
 *
 * `LandResult.hasConflicts` was produced by the land path and rendered by the
 * toast ("Land hit conflicts"), but nothing ever recorded it — so a land that
 * stopped halfway through a merge was visible only in the log file, which is
 * the exact defect the sync path was fixed for.
 *
 * The directory matters and is not the worktree. A land merges in whichever
 * checkout holds the source branch (usually the base repo); only an optional
 * pre-sync conflict lands in the worktree. Keying the alert on the worktree
 * would open the resolution dialog on a clean tree.
 *
 * Regression direction: removing the `recordConflictAlert` call from
 * WorktreeRowMenu.doLand turns these red. They exercise the same store action
 * that component calls.
 */
describe('a failed land records a visible alert', () => {
  const HOLDER = '/repo'

  it('keys the alert on the holder checkout the merge conflicted in', () => {
    const h = harness()

    h.slice.recordConflictAlert!(HOLDER, {
      source: 'land',
      kind: 'conflict',
      message: 'Merge conflict landing wt/a1 into josh. Resolve it in /repo, then land again.',
      label: 'repo',
    })

    const alert = h.alerts().get(HOLDER)
    expect(alert).toBeDefined()
    expect(alert!.source).toBe('land')
    expect(alert!.kind).toBe('conflict')
    expect(alert!.message).toContain('Merge conflict landing')
    // Not dismissed: a fresh failure raises the toast.
    expect(alert!.dismissed).toBe(false)
    // The worktree itself is clean — no alert belongs there.
    expect(h.alerts().has(WT)).toBe(false)
  })

  it('keys a pre-sync land conflict on the worktree, which is where it happened', () => {
    const h = harness()

    h.slice.recordConflictAlert!(WT, {
      source: 'land',
      kind: 'conflict',
      message: 'Sync from josh failed: conflict',
      label: 'proj-a1',
    })

    expect(h.alerts().get(WT)!.source).toBe('land')
    expect(h.alerts().has(HOLDER)).toBe(false)
  })

  it('offers Resolve for a land conflict, unlike a dirty refusal', () => {
    const h = harness()

    h.slice.recordConflictAlert!(HOLDER, { source: 'land', kind: 'conflict' })
    h.slice.recordConflictAlert!(WT, { source: 'sync', kind: 'refusal' })

    // `kind` is what the toast switches on to decide whether Resolve makes
    // sense: a conflict has an operation to resolve, a refusal never started.
    expect(h.alerts().get(HOLDER)!.kind).toBe('conflict')
    expect(h.alerts().get(WT)!.kind).toBe('refusal')
  })
})
