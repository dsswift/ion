/**
 * The reconciler must repair an idle plane against a stuck 'connecting' tab.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * This hook is the safety net for a tab stranded in an active-looking status.
 * Its idle-repair branch was gated on `!healthEntry.alive`. But the plane
 * derives `alive` as `status !== 'dead' && status !== 'failed'`
 * (main/engine-control-plane-status.ts), so a healthy idle tab is ALWAYS
 * `alive: true`. The branch was therefore unreachable for the exact stall it
 * existed to repair, and control fell through to the 'already-at-target' log
 * on every poll, forever.
 *
 * Observed live: a conversation held 'connecting' after its run finished, with
 * a locked composer, logging `already-at-target backend_status=idle
 * backend_alive=true` every 1.5 seconds. Every prompt typed into it was
 * refused as "still connecting" and discarded.
 *
 * ── What this pins ──────────────────────────────────────────────────────────
 * The repair fires on the plane's STATUS, not on `alive`; and the plan-ready
 * card survives the repair. The first two tests fail against the `!alive`
 * gate — the tab stays 'connecting'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HealthReport } from '../../../shared/types'

const logTabStatusPatch = vi.fn()
const logTabStatusWrite = vi.fn()
vi.mock('../../stores/slices/tab-status-transition', () => ({
  logTabStatusPatch: (...a: unknown[]) => logTabStatusPatch(...a),
  logTabStatusWrite: (...a: unknown[]) => logTabStatusWrite(...a),
}))
const rDebug = vi.fn()
vi.mock('../../rendererLogger', () => ({ rDebug: (...a: unknown[]) => rDebug(...a) }))

// A minimal store stand-in: the reconciler only reads `tabs` /
// `conversationPanes` and writes them back through setState.
interface FakeState {
  tabs: any[]
  conversationPanes: Map<string, any>
}
let state: FakeState
const setState = vi.fn((fn: (s: FakeState) => Partial<FakeState>) => {
  state = { ...state, ...fn(state) }
})
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => state,
    setState: (fn: (s: FakeState) => Partial<FakeState>) => setState(fn),
  },
}))
vi.mock('../../stores/conversation-instance', () => ({
  commitInstance: (
    panes: Map<string, any>, tabId: string, fn: (inst: any) => any,
  ) => {
    const next = new Map(panes)
    const pane = next.get(tabId)
    if (!pane) return next
    next.set(tabId, { ...pane, instances: pane.instances.map(fn) })
    return next
  },
}))

import { reconcileOnce } from '../useHealthReconciliation'

function seed(tabStatus: string, permissionDenied: unknown = null): void {
  state = {
    tabs: [{
      id: 'tab1', status: tabStatus, currentActivity: 'thinking', activeRequestId: 'req-1',
    }],
    conversationPanes: new Map([['tab1', {
      activeInstanceId: 'main',
      instances: [{ id: 'main', permissionQueue: [{ id: 'p-1' }], permissionDenied }],
    }]]),
  }
}

function health(entry: Partial<HealthReport['tabs'][number]>): void {
  ;(globalThis as any).window = {
    ion: {
      tabHealth: vi.fn(async (): Promise<HealthReport> => ({
        tabs: [{
          tabId: 'tab1', status: 'idle', activeRequestId: null, conversationId: 'c1',
          alive: true, lastActivityAt: 0, ...entry,
        } as HealthReport['tabs'][number]],
        queueDepth: 0,
      })),
    },
  }
}

function instance(): any {
  return state.conversationPanes.get('tab1').instances[0]
}

describe('health reconciliation — idle plane vs stuck tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('moves a stuck connecting tab to completed when the plane reports idle and alive', async () => {
    seed('connecting')
    // alive: true is what the plane ALWAYS reports for a healthy idle tab.
    health({ status: 'idle', alive: true })

    await reconcileOnce()

    // Fails against the `!alive` gate: the tab stayed 'connecting'.
    expect(state.tabs[0].status).toBe('completed')
    expect(state.tabs[0].activeRequestId).toBeNull()
    expect(state.tabs[0].currentActivity).toBe('')
  })

  it('repairs a stuck running tab the same way', async () => {
    seed('running')
    health({ status: 'idle', alive: true })

    await reconcileOnce()

    expect(state.tabs[0].status).toBe('completed')
  })

  it('preserves the plan-ready card while clearing the stale permission queue', async () => {
    const card = { tools: [{ toolName: 'ExitPlanMode' }] }
    seed('connecting', card)
    health({ status: 'idle', alive: true })

    await reconcileOnce()

    // The queue belonged to the finished run; the card is the user's pending
    // decision and must survive the repair.
    expect(instance().permissionQueue).toEqual([])
    expect(instance().permissionDenied).toEqual(card)
  })

  it('records the repair as an applied transition, not already-at-target', async () => {
    seed('connecting')
    health({ status: 'idle', alive: true })

    await reconcileOnce()

    expect(logTabStatusPatch).toHaveBeenCalledWith(
      'tab1', 'connecting', 'completed', 'health.reconcile',
      expect.objectContaining({ backend_status: 'idle' }),
    )
    expect(logTabStatusWrite).not.toHaveBeenCalled()
  })

  it('still reports dead when the plane says the process is gone', async () => {
    seed('running')
    health({ status: 'dead', alive: false })

    await reconcileOnce()

    expect(state.tabs[0].status).toBe('dead')
    // A dead session's pending card is meaningless; both are cleared.
    expect(instance().permissionDenied).toBeNull()
  })

  it('leaves a genuinely running tab alone', async () => {
    seed('running')
    health({ status: 'running', alive: true })

    await reconcileOnce()

    expect(state.tabs[0].status).toBe('running')
    expect(setState).not.toHaveBeenCalled()
    expect(logTabStatusWrite).toHaveBeenCalledWith(
      'tab1', 'running', 'running', 'health.reconcile', 'already-at-target',
      expect.anything(),
    )
  })

  it('logs a failed poll instead of swallowing it', async () => {
    seed('connecting')
    ;(globalThis as any).window = {
      ion: { tabHealth: vi.fn(async () => { throw new Error('engine restarting') }) },
    }

    await reconcileOnce()

    // A reconciler that has stopped reconciling must be visible: the tabs it
    // would have repaired show no symptom of their own.
    expect(rDebug).toHaveBeenCalledWith(
      'tab.status', 'health reconcile poll failed',
      expect.objectContaining({ error: expect.stringContaining('engine restarting') }),
    )
  })
})
