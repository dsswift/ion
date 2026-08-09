/**
 * Auto-fix lifecycle — close-vs-retain decisions for conflict auto-fix tabs.
 *
 * Pins the retention matrix: only a typed `normal` completion with no denials,
 * no pending ask, and no running children closes the tab; every failure shape
 * retains it for diagnosis. Also pins stale-work rejection (a newer run aborts
 * the deferred close) and the running-children retry path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../lib/window-role', () => ({ isMirrorWindow: () => false }))
vi.mock('../../../rendererLogger', () => ({
  rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))
// event-slice-done-move transitively imports the preferences bootstrap (DOM);
// only hasRunningAgents is consumed, so mock it with the same fold the real
// implementation performs over conversationPanes.
vi.mock('../event-slice-done-move', () => ({
  hasRunningAgents: (panes: Map<string, { instances: Array<{ agentStates: Array<{ status: string }> }> }>, tabId: string) => {
    const pane = panes.get(tabId)
    if (!pane) return false
    return pane.instances.some((i) => i.agentStates.some((a) => a.status === 'running'))
  },
}))

import {
  maybeCloseAutoFixTab,
  retryAutoFixCloseOnTerminalChildren,
  cancelAutoFixClose,
  type AutoFixCompletionEvidence,
} from '../event-slice-auto-fix-lifecycle'

type AnyState = Record<string, unknown>

function makeState(overrides: {
  tabRole?: 'bench-conversation' | 'conflict-auto-fix' | 'verification-analysis' | null
  status?: string
  activeRequestId?: string | null
  runningAgents?: boolean
  closeTab?: (id: string) => void
  /** Where the fix ran. A worktree path yields worktree metadata; a bench path does not. */
  workingDirectory?: string
  worktreeRepoPath?: string | null
  /** Bench records, so a bench-directory fix can resolve its repo. */
  benchWorkspaces?: Map<string, Array<{ benchPath: string }>>
  refreshWorkspaceViews?: (repoPath: string) => Promise<void>
} = {}): () => AnyState {
  const closeTab = overrides.closeTab ?? vi.fn()
  const agentStates = overrides.runningAgents ? [{ status: 'running' }] : [{ status: 'done' }]
  const state = {
    tabs: [{
      id: 'fix-tab',
      tabRole: overrides.tabRole ?? 'conflict-auto-fix',
      status: overrides.status ?? 'completed',
      activeRequestId: overrides.activeRequestId ?? null,
      workingDirectory: overrides.workingDirectory ?? '/wt/mine',
      worktree: overrides.worktreeRepoPath === null
        ? null
        : { repoPath: overrides.worktreeRepoPath ?? '/repo' },
    }],
    conversationPanes: new Map([
      ['fix-tab', { instances: [{ agentStates }] }],
    ]),
    benchWorkspaces: overrides.benchWorkspaces ?? new Map(),
    refreshWorkspaceViews: overrides.refreshWorkspaceViews ?? vi.fn(async () => {}),
    closeTab,
  }
  return () => state as AnyState
}

function evidence(overrides: Partial<AutoFixCompletionEvidence> = {}): AutoFixCompletionEvidence {
  return { reason: 'normal', hadDenials: false, hadPendingAsk: false, runRequestId: null, ...overrides }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cancelAutoFixClose('fix-tab')
  vi.useRealTimers()
})

describe('auto-fix close decision', () => {
  it('closes after a typed normal completion (deferred)', () => {
    const closeTab = vi.fn()
    const get = makeState({ closeTab })
    maybeCloseAutoFixTab('fix-tab', evidence(), get as never)
    expect(closeTab).not.toHaveBeenCalled() // deferred, not immediate
    vi.advanceTimersByTime(1500)
    expect(closeTab).toHaveBeenCalledWith('fix-tab')
  })

  it.each([
    ['max_turns'], ['aborted'], ['backend_exit'], ['some_future_reason'], [undefined],
  ])('retains on completion reason %s', (reason) => {
    const closeTab = vi.fn()
    const get = makeState({ closeTab })
    maybeCloseAutoFixTab('fix-tab', evidence({ reason: reason as string | undefined }), get as never)
    vi.advanceTimersByTime(5000)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('retains when the run ended with permission denials', () => {
    const closeTab = vi.fn()
    const get = makeState({ closeTab })
    maybeCloseAutoFixTab('fix-tab', evidence({ hadDenials: true }), get as never)
    vi.advanceTimersByTime(5000)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('retains when a permission/elicitation ask was pending', () => {
    const closeTab = vi.fn()
    const get = makeState({ closeTab })
    maybeCloseAutoFixTab('fix-tab', evidence({ hadPendingAsk: true }), get as never)
    vi.advanceTimersByTime(5000)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('never touches a tab without the auto-fix role', () => {
    const closeTab = vi.fn()
    const get = makeState({ tabRole: 'bench-conversation', closeTab })
    maybeCloseAutoFixTab('fix-tab', evidence(), get as never)
    vi.advanceTimersByTime(5000)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('defers while children run, then closes when the retry finds them terminal', () => {
    const closeTab = vi.fn()
    const running = makeState({ runningAgents: true, closeTab })
    maybeCloseAutoFixTab('fix-tab', evidence(), running as never)
    vi.advanceTimersByTime(5000)
    expect(closeTab).not.toHaveBeenCalled()

    // Children reach terminal state; the agent_state post-commit hook retries.
    const done = makeState({ runningAgents: false, closeTab })
    retryAutoFixCloseOnTerminalChildren('fix-tab', done as never)
    vi.advanceTimersByTime(1500)
    expect(closeTab).toHaveBeenCalledWith('fix-tab')
  })

  it('aborts a scheduled close when a newer run started (stale-work rejection)', () => {
    const closeTab = vi.fn()
    const get = makeState({ closeTab, status: 'running', activeRequestId: 'newer-run' })
    maybeCloseAutoFixTab('fix-tab', evidence({ runRequestId: 'old-run' }), get as never)
    vi.advanceTimersByTime(1500)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('aborts a scheduled close when the tab is gone', () => {
    const closeTab = vi.fn()
    const present = makeState({ closeTab })
    maybeCloseAutoFixTab('fix-tab', evidence(), present as never)
    // Swap the store out from under the timer: tab list is now empty.
    const gone = () => ({ tabs: [], conversationPanes: new Map(), closeTab }) as AnyState
    void gone
    // The timer re-reads through the SAME get; simulate removal in place.
    ;(present() as { tabs: unknown[] }).tabs.length = 0
    vi.advanceTimersByTime(1500)
    expect(closeTab).not.toHaveBeenCalled()
  })
})

/**
 * The row the fix just repaired must stop advertising the conflict.
 *
 * `closeTab` tears down panes and terminals; it does not touch the worktree
 * inventory or the bench records, and the worktree row is a join of the two. So
 * before this, a resolved conflict kept its red badge until the panel's 5s poll
 * happened to fire — and that poll skips hidden windows entirely, so a
 * backgrounded overlay showed the stale warning indefinitely. That is exactly
 * the reported symptom: the operator looked away, the fix succeeded, and the
 * panel still said conflict.
 */
describe('auto-fix close refreshes the worktree surfaces it changed', () => {
  it('refreshes the repo of a worktree fix after closing', () => {
    const refreshWorkspaceViews = vi.fn(async () => {})
    const get = makeState({ worktreeRepoPath: '/repo', refreshWorkspaceViews })
    maybeCloseAutoFixTab('fix-tab', evidence(), get as never)
    vi.advanceTimersByTime(1500)
    expect(refreshWorkspaceViews).toHaveBeenCalledWith('/repo')
  })

  it('resolves the repo from the bench record when the fix ran in a bench', async () => {
    // A bench auto-fix runs IN the bench directory, which is not a repo root and
    // carries no worktree metadata — the bench record is the only source.
    const refreshWorkspaceViews = vi.fn(async () => {})
    const get = makeState({
      workingDirectory: '/ion/integration/ion-josh',
      worktreeRepoPath: null,
      benchWorkspaces: new Map([['/repo', [{ benchPath: '/ion/integration/ion-josh' }]]]),
      refreshWorkspaceViews,
    })
    maybeCloseAutoFixTab('fix-tab', evidence(), get as never)
    await vi.advanceTimersByTimeAsync(1500)
    expect(refreshWorkspaceViews).toHaveBeenCalledWith('/repo')
  })

  it('reconciles a successful bench auto-fix before refreshing its row', async () => {
    const benchReconcileResolution = vi.fn(async () => ({ reconciled: true }))
    ;(globalThis as unknown as { window: { ion: { benchReconcileResolution: typeof benchReconcileResolution } } })
      .window = { ion: { benchReconcileResolution } }
    const refreshWorkspaceViews = vi.fn(async () => {})
    const get = makeState({
      workingDirectory: '/ion/integration/ion-josh',
      worktreeRepoPath: null,
      benchWorkspaces: new Map([['/repo', [{ benchPath: '/ion/integration/ion-josh' }]]]),
      refreshWorkspaceViews,
    })
    maybeCloseAutoFixTab('fix-tab', evidence(), get as never)
    await vi.advanceTimersByTimeAsync(1500)

    expect((window.ion.benchReconcileResolution as ReturnType<typeof vi.fn>))
      .toHaveBeenCalledWith('/ion/integration/ion-josh')
    expect(refreshWorkspaceViews).toHaveBeenCalledWith('/repo')
  })

  it('does NOT refresh when the tab is retained', () => {
    // A retained tab means the fix did not finish cleanly. Refreshing would
    // clear a badge that is still telling the truth — the refresh must never be
    // able to mask a live failure.
    const refreshWorkspaceViews = vi.fn(async () => {})
    const get = makeState({ refreshWorkspaceViews })
    maybeCloseAutoFixTab('fix-tab', evidence({ reason: 'max_turns' }), get as never)
    vi.advanceTimersByTime(1500)
    expect(refreshWorkspaceViews).not.toHaveBeenCalled()
  })

  it('does NOT refresh when the deferred close is aborted by a newer run', () => {
    const refreshWorkspaceViews = vi.fn(async () => {})
    const get = makeState({ status: 'running', refreshWorkspaceViews })
    maybeCloseAutoFixTab('fix-tab', evidence(), get as never)
    vi.advanceTimersByTime(1500)
    expect(refreshWorkspaceViews).not.toHaveBeenCalled()
  })

  it('closes without refreshing when no repo can be resolved', () => {
    // A plain checkout with no worktree metadata and no bench: there are no
    // worktree surfaces to refresh, which is not a failure. The close still runs.
    const closeTab = vi.fn()
    const refreshWorkspaceViews = vi.fn(async () => {})
    const get = makeState({ worktreeRepoPath: null, closeTab, refreshWorkspaceViews })
    maybeCloseAutoFixTab('fix-tab', evidence(), get as never)
    vi.advanceTimersByTime(1500)
    expect(closeTab).toHaveBeenCalledWith('fix-tab')
    expect(refreshWorkspaceViews).not.toHaveBeenCalled()
  })
})

/**
 * A verification-analysis tab is NOT an auto-fix. It uses a different tabRole
 * and must never be auto-closed. The auto-fix lifecycle logic gates on
 * `tabRole === 'conflict-auto-fix'` and exits early for everything else.
 */
describe('verification-analysis tabs are never auto-closed', () => {
  it('never closes a verification-analysis tab on normal completion', () => {
    const closeTab = vi.fn()
    const get = makeState({ tabRole: 'verification-analysis', closeTab })
    maybeCloseAutoFixTab('fix-tab', evidence(), get as never)
    vi.advanceTimersByTime(5000)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('retryAutoFixCloseOnTerminalChildren is a no-op for verification-analysis', () => {
    const closeTab = vi.fn()
    // First: attempt a close with running children on a verification-analysis tab.
    // The early-return on tabRole means nothing is remembered.
    const running = makeState({ tabRole: 'verification-analysis', runningAgents: true, closeTab })
    maybeCloseAutoFixTab('fix-tab', evidence(), running as never)
    // Children go terminal; the retry should still be a no-op because the
    // initial call never remembered evidence (role gate bailed early).
    const done = makeState({ tabRole: 'verification-analysis', runningAgents: false, closeTab })
    retryAutoFixCloseOnTerminalChildren('fix-tab', done as never)
    vi.advanceTimersByTime(5000)
    expect(closeTab).not.toHaveBeenCalled()
  })
})
