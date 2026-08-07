/**
 * Worktree pipeline slice — the sync-all state machine's decision points.
 *
 * The mechanics under the pipeline (rebases, rerere, sync-all classification)
 * are pinned against real git in main/__tests__/worktree-sync-mechanics.test.ts.
 * These tests pin the ORCHESTRATION: the confirm gate stops the pipeline
 * before any agent launches (the cost-visibility contract), the zero-conflict
 * run skips the gate, escalation is sequential with a mechanical re-pass
 * between agents (the rerere cascade), a quiet-agent-with-conflicts parks as
 * needs-manual without blocking the rest, phase 4 fires only when a bench
 * exists, and cancel stops between steps.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import { createWorktreePipelineSlice } from '../slices/worktree-pipeline-slice'
import type { State, WorktreePipelineState } from '../session-store-types'
import type { SyncAllResult, SyncAllWorktreeOutcome } from '../../../shared/types'

const REPO = '/Users/test/project'
const BRANCH = 'josh'

function outcome(
  worktreePath: string,
  kind: SyncAllWorktreeOutcome['outcome'],
): SyncAllWorktreeOutcome {
  return { worktreePath, branchName: `wt/${worktreePath.split('/').pop()}`, outcome: kind }
}

function syncAllResult(outcomes: SyncAllWorktreeOutcome[]): SyncAllResult {
  const count = (o: SyncAllWorktreeOutcome['outcome']): number =>
    outcomes.filter((x) => x.outcome === o).length
  return {
    ok: true,
    outcomes,
    summary: {
      synced: count('synced'),
      replayed: count('replayed'),
      conflicted: count('conflicted'),
      skippedDirty: count('skipped-dirty'),
      skippedClean: count('skipped-clean'),
      skippedUnknownSource: count('skipped-unknown-source'),
      failed: count('failed'),
      dropped: outcomes.reduce((total, x) => total + (x.dropped ?? 0), 0),
    },
  }
}

interface HarnessOptions {
  /** Result queue for consecutive gitWorktreeSyncAll calls (last repeats). */
  syncAllResults: SyncAllResult[]
  /** Whether a bench exists for BRANCH (enables phase 4). */
  hasBench?: boolean
  /**
   * Per-directory script for the assist: 'resolve' clears the operation on
   * the first poll; 'stall' leaves it conflicted with the tab idle (the
   * needs-manual path); 'refuse' throws from openConflictAssist.
   */
  assist?: Record<string, 'resolve' | 'stall' | 'refuse'>
}

function harness(opts: HarnessOptions) {
  const resolvedDirs = new Set<string>()
  let syncAllCall = 0

  let state: Record<string, unknown> = {
    worktreePipeline: null,
    tabs: [] as Array<{ id: string; status: string }>,
    benchWorkspaces: new Map(
      opts.hasBench
        ? [[REPO, [{ repoPath: REPO, sourceBranch: BRANCH, benchPath: '/bench', benchBranch: 'ion/bench/josh', members: [], baseSha: '', lastBuiltAt: 0 }]]]
        : [],
    ),
    // Store actions the slice reaches through get():
    benchUpdateAll: vi.fn().mockResolvedValue({ ok: true }),
    refreshWorktreeInventory: vi.fn().mockResolvedValue(undefined),
    refreshBench: vi.fn().mockResolvedValue(undefined),
    closeTab: vi.fn((tabId: string) => {
      state.tabs = (state.tabs as Array<{ id: string; status: string }>).filter((t) => t.id !== tabId)
    }),
    openConflictAssist: vi.fn(async (directory: string) => {
      const script = opts.assist?.[directory] ?? 'resolve'
      if (script === 'refuse') throw new Error('AI Assisted resolution needs a "standard" model tier.')
      if (script === 'resolve') resolvedDirs.add(directory)
      // 'stall' leaves the directory conflicted; the tab below reads idle.
      const tabId = `tab-${directory.split('/').pop()}`
      ;(state.tabs as Array<{ id: string; status: string }>).push({ id: tabId, status: 'idle' })
      return tabId
    }),
  }
  const set = (fn: (s: Record<string, unknown>) => Record<string, unknown>): void => {
    state = { ...state, ...fn(state) }
  }
  const get = (): Record<string, unknown> => state

  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    ion: {
      gitWorktreeSyncAll: vi.fn(async () => {
        const results = opts.syncAllResults
        const r = results[Math.min(syncAllCall, results.length - 1)]
        syncAllCall += 1
        return r
      }),
      gitOpState: vi.fn(async (directory: string) => (
        resolvedDirs.has(directory)
          ? { ok: true, state: null }
          : { ok: true, state: 'rebasing' }
      )),
    },
  }

  const slice = createWorktreePipelineSlice(
    set as unknown as Parameters<typeof createWorktreePipelineSlice>[0],
    get as unknown as Parameters<typeof createWorktreePipelineSlice>[1],
  ) as Partial<State>
  state = { ...state, ...slice }

  return {
    pipeline: () => state.worktreePipeline as WorktreePipelineState | null,
    start: () => (state.startWorktreePipeline as State['startWorktreePipeline'])(REPO, BRANCH),
    confirm: () => (state.confirmWorktreePipelineAi as State['confirmWorktreePipelineAi'])(),
    cancel: () => (state.cancelWorktreePipeline as State['cancelWorktreePipeline'])(),
    dismiss: () => (state.dismissWorktreePipeline as State['dismissWorktreePipeline'])(),
    benchUpdateAll: state.benchUpdateAll as ReturnType<typeof vi.fn>,
    openConflictAssist: state.openConflictAssist as ReturnType<typeof vi.fn>,
    closeTab: state.closeTab as ReturnType<typeof vi.fn>,
    syncAll: () => (globalThis as unknown as { window: { ion: { gitWorktreeSyncAll: ReturnType<typeof vi.fn> } } })
      .window.ion.gitWorktreeSyncAll,
    resolvedDirs,
  }
}

beforeEach(() => {
  // The slice polls with 3s sleeps; fake timers would need manual advancing
  // inside awaits, so instead the poll interval is short-circuited by making
  // setTimeout immediate. Decisions, not durations, are under test.
  vi.useRealTimers()
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout)
})

describe('the confirm gate (cost visibility)', () => {
  it('pauses at awaiting-ai-confirm when conflicts survive the free pass, launching NO agent', async () => {
    const h = harness({
      syncAllResults: [syncAllResult([outcome('/wt/a', 'synced'), outcome('/wt/b', 'conflicted')])],
    })
    await h.start()

    expect(h.pipeline()?.phase).toBe('awaiting-ai-confirm')
    expect(h.pipeline()?.queue).toEqual(['/wt/b'])
    // The contract: not a single agent before the operator says yes.
    expect(h.openConflictAssist).not.toHaveBeenCalled()
  })

  it('skips the gate entirely on a zero-conflict run and goes straight to done', async () => {
    const h = harness({ syncAllResults: [syncAllResult([outcome('/wt/a', 'synced')])] })
    await h.start()

    expect(h.pipeline()?.phase).toBe('done')
    expect(h.openConflictAssist).not.toHaveBeenCalled()
    expect(h.pipeline()?.summary).toContain('1 synced')
  })

  it('declining the gate (cancel) ends the pipeline without agents or assembly', async () => {
    const h = harness({
      syncAllResults: [syncAllResult([outcome('/wt/b', 'conflicted')])],
      hasBench: true,
    })
    await h.start()
    expect(h.pipeline()?.phase).toBe('awaiting-ai-confirm')

    h.cancel()

    expect(h.pipeline()?.phase).toBe('done')
    expect(h.pipeline()?.summary).toContain('Cancelled')
    expect(h.openConflictAssist).not.toHaveBeenCalled()
    expect(h.benchUpdateAll).not.toHaveBeenCalled()
  })
})

describe('sequential escalation with the rerere cascade', () => {
  it('re-runs the mechanical pass between agents so a recorded resolution clears the rest', async () => {
    // Pass 1: two conflicts. After agent #1 resolves /wt/a, pass 2 reports
    // /wt/b as replayed — no second agent may launch.
    const h = harness({
      syncAllResults: [
        syncAllResult([outcome('/wt/a', 'conflicted'), outcome('/wt/b', 'conflicted')]),
        syncAllResult([outcome('/wt/a', 'skipped-clean'), outcome('/wt/b', 'replayed')]),
      ],
      assist: { '/wt/a': 'resolve' },
    })
    await h.start()
    await h.confirm()

    expect(h.openConflictAssist).toHaveBeenCalledTimes(1)
    expect(h.openConflictAssist).toHaveBeenCalledWith('/wt/a')
    expect(h.pipeline()?.phase).toBe('done')
    expect(h.pipeline()?.resolvedByAi).toBe(1)
    expect(h.pipeline()?.needsManual).toEqual([])
  })

  it('parks a quiet-but-unresolved worktree as needs-manual and continues with the rest', async () => {
    const h = harness({
      syncAllResults: [
        syncAllResult([outcome('/wt/a', 'conflicted'), outcome('/wt/b', 'conflicted')]),
        // /wt/a stays conflicted (agent stalled); /wt/b still queued.
        syncAllResult([outcome('/wt/a', 'conflicted'), outcome('/wt/b', 'conflicted')]),
        syncAllResult([outcome('/wt/a', 'conflicted'), outcome('/wt/b', 'skipped-clean')]),
      ],
      assist: { '/wt/a': 'stall', '/wt/b': 'resolve' },
    })
    await h.start()
    await h.confirm()

    expect(h.pipeline()?.needsManual).toEqual(['/wt/a'])
    expect(h.pipeline()?.resolvedByAi).toBe(1)
    expect(h.pipeline()?.phase).toBe('done')
    // A parked worktree is excluded from later queues — no agent retries it.
    const calls = h.openConflictAssist.mock.calls.map((c: unknown[]) => c[0])
    expect(calls.filter((d: unknown) => d === '/wt/a')).toHaveLength(1)
  })

  it('closes a resolved assist tab and keeps a needs-manual one', async () => {
    // A dozen-worktree pipeline must not leave a dozen dead tabs behind: a
    // RESOLVED assist tab's one machine prompt is answered, so it closes
    // (conversation persists, resumable from the session browser). A
    // NEEDS-MANUAL tab stays — its transcript is the operator's evidence for
    // what the agent tried.
    const h = harness({
      syncAllResults: [
        syncAllResult([outcome('/wt/a', 'conflicted'), outcome('/wt/b', 'conflicted')]),
        syncAllResult([outcome('/wt/a', 'skipped-clean'), outcome('/wt/b', 'conflicted')]),
        syncAllResult([outcome('/wt/a', 'skipped-clean'), outcome('/wt/b', 'conflicted')]),
      ],
      assist: { '/wt/a': 'resolve', '/wt/b': 'stall' },
    })
    await h.start()
    await h.confirm()

    expect(h.pipeline()?.resolvedByAi).toBe(1)
    expect(h.pipeline()?.needsManual).toEqual(['/wt/b'])
    // Exactly the resolved tab closed; the stalled one kept for inspection.
    expect(h.closeTab).toHaveBeenCalledTimes(1)
    expect(h.closeTab).toHaveBeenCalledWith('tab-a')
  })

  it('an assist refusal (no model tier) parks the whole queue instead of failing one at a time', async () => {
    const h = harness({
      syncAllResults: [syncAllResult([outcome('/wt/a', 'conflicted'), outcome('/wt/b', 'conflicted')])],
      assist: { '/wt/a': 'refuse' },
    })
    await h.start()
    await h.confirm()

    expect(h.openConflictAssist).toHaveBeenCalledTimes(1)
    expect(h.pipeline()?.needsManual).toEqual(expect.arrayContaining(['/wt/a', '/wt/b']))
    expect(h.pipeline()?.phase).toBe('done')
  })
})

describe('the assembly phase', () => {
  it('runs benchUpdateAll when a bench exists for the branch', async () => {
    const h = harness({
      syncAllResults: [syncAllResult([outcome('/wt/a', 'synced')])],
      hasBench: true,
    })
    await h.start()

    expect(h.benchUpdateAll).toHaveBeenCalledWith(REPO, BRANCH)
    expect(h.pipeline()?.phase).toBe('done')
  })

  it('skips assembly when no bench exists', async () => {
    const h = harness({ syncAllResults: [syncAllResult([outcome('/wt/a', 'synced')])] })
    await h.start()

    expect(h.benchUpdateAll).not.toHaveBeenCalled()
    expect(h.pipeline()?.phase).toBe('done')
  })
})

describe('lifecycle guards', () => {
  it('refuses to start while another pipeline is running', async () => {
    const h = harness({
      syncAllResults: [syncAllResult([outcome('/wt/a', 'conflicted')])],
    })
    await h.start()
    expect(h.pipeline()?.phase).toBe('awaiting-ai-confirm')
    const callsBefore = h.syncAll().mock.calls.length

    await h.start()
    expect(h.syncAll().mock.calls.length).toBe(callsBefore)
  })

  it('dismiss clears a finished pipeline but never a running one', async () => {
    const h = harness({
      syncAllResults: [syncAllResult([outcome('/wt/a', 'conflicted')])],
    })
    await h.start()
    h.dismiss()
    expect(h.pipeline()).not.toBeNull() // still awaiting confirm — kept

    h.cancel()
    expect(h.pipeline()?.phase).toBe('done')
    h.dismiss()
    expect(h.pipeline()).toBeNull()
  })
})
