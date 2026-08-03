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
  tabRole?: 'bench-conversation' | 'conflict-auto-fix' | null
  status?: string
  activeRequestId?: string | null
  runningAgents?: boolean
  closeTab?: (id: string) => void
} = {}): () => AnyState {
  const closeTab = overrides.closeTab ?? vi.fn()
  const agentStates = overrides.runningAgents ? [{ status: 'running' }] : [{ status: 'done' }]
  const state = {
    tabs: [{
      id: 'fix-tab',
      tabRole: overrides.tabRole ?? 'conflict-auto-fix',
      status: overrides.status ?? 'completed',
      activeRequestId: overrides.activeRequestId ?? null,
    }],
    conversationPanes: new Map([
      ['fix-tab', { instances: [{ agentStates }] }],
    ]),
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
