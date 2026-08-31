import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * The fork → durable-conversation chart handoff.
 *
 * THE TIMING BUG THIS EXISTS FOR: a fork copies its source's active-branch
 * messages, chart rows included, but is born with `conversationId: null`. A
 * chart resource is CONVERSATION-SCOPED, so reconciling at fork creation would
 * publish into a scope that does not exist — the engine has no broker to route
 * to, and the index would be written under an empty conversation nothing reads.
 *
 * The engine mints the id later, and `session_init` is the one place every
 * conversation kind learns it. So the fork leaves a marker and the reconcile
 * happens there — exactly once, because session_init fires at the start of
 * EVERY run and re-reconciling would republish the same index forever.
 */

const reconcileMock = vi.hoisted(() => ({ reconcileChartsForBranch: vi.fn() }))
vi.mock('../../../lib/chart-reconcile-request', () => reconcileMock)
vi.mock('../../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({})),
  nextMsgId: vi.fn(() => 'forked-row-id'),
}))

import {
  markForkPendingChartReconcile,
  maybeReconcileForkedCharts,
  claimForkPendingChartReconcile,
  _resetForkChartReconcileForTest,
} from '../fork-chart-reconcile'
import { createForkSlice } from '../resume-slice-fork'

const CHART_INPUT = '{"schemaVersion":1,"kind":"line","title":"Series","labels":["A"],"datasets":[{"label":"S","data":[1]}]}'
const CHART_RESULT = 'Chart rendered in the conversation. id: tool-gate-1787864702164461001-1 · title: "Series" · line · 1 series · 1 points.'

const MESSAGES = [
  { id: 'msg-1', role: 'user', content: 'chart it', timestamp: 1 },
  {
    id: 'toolu_01', role: 'tool', content: CHART_RESULT, timestamp: 2,
    toolName: 'RenderChart', toolInput: CHART_INPUT, toolStatus: 'completed',
  },
]

function makeGet(conversationId: string | null, messages: unknown[] = MESSAGES) {
  return () => ({
    tabs: [{ id: 'fork-tab', conversationId }],
    conversationPanes: new Map([
      ['fork-tab', { activeInstanceId: 'main', instances: [{ id: 'main', messages }] }],
    ]),
  }) as never
}

describe('fork chart reconciliation handoff', () => {
  beforeEach(() => {
    reconcileMock.reconcileChartsForBranch.mockClear()
    _resetForkChartReconcileForTest()
  })

  it('reconciles a marked fork once its durable conversation id arrives', () => {
    markForkPendingChartReconcile('fork-tab')
    maybeReconcileForkedCharts('fork-tab', makeGet('conv-forked'))

    expect(reconcileMock.reconcileChartsForBranch).toHaveBeenCalledTimes(1)
    const [tabId, conversationId, messages] =
      reconcileMock.reconcileChartsForBranch.mock.calls[0] as [string, string, unknown[]]
    expect(tabId).toBe('fork-tab')
    expect(conversationId).toBe('conv-forked')
    expect(messages).toEqual(MESSAGES)
  })

  it('reconciles exactly once across repeated session inits', () => {
    // session_init fires at the start of every run; a second reconcile would
    // republish the same index for the life of the conversation.
    markForkPendingChartReconcile('fork-tab')
    maybeReconcileForkedCharts('fork-tab', makeGet('conv-forked'))
    maybeReconcileForkedCharts('fork-tab', makeGet('conv-forked'))

    expect(reconcileMock.reconcileChartsForBranch).toHaveBeenCalledTimes(1)
  })

  it('ignores a tab that was never forked', () => {
    // Every ordinary conversation reaches session_init; the cost must be one
    // Set lookup and nothing else.
    maybeReconcileForkedCharts('plain-tab', makeGet('conv-plain'))
    expect(reconcileMock.reconcileChartsForBranch).not.toHaveBeenCalled()
  })

  it('does not reconcile while the fork still has no durable id', () => {
    markForkPendingChartReconcile('fork-tab')
    maybeReconcileForkedCharts('fork-tab', makeGet(null))
    expect(reconcileMock.reconcileChartsForBranch).not.toHaveBeenCalled()
  })

  it('claims a marker only once', () => {
    markForkPendingChartReconcile('fork-tab')
    expect(claimForkPendingChartReconcile('fork-tab')).toBe(true)
    expect(claimForkPendingChartReconcile('fork-tab')).toBe(false)
  })
})

/**
 * The marker is left by the fork VERBS, and it must name the tab they just
 * created — never the tab they forked from.
 *
 * The helper suite above proves the handoff mechanism in isolation, which is
 * exactly why it cannot catch this: it marks and drains the same id by
 * construction. A source-tab marker would satisfy every assertion up there
 * while the real fork silently never reconciles, because the source tab
 * already has its durable conversation id and never reaches the drain with a
 * marker pending. So these cases drive the real slice and assert on the id the
 * verb actually registered.
 */
describe('fork verbs register the created tab', () => {
  const SOURCE_MESSAGES = [
    { id: 'user-1', role: 'user', content: 'chart it', timestamp: 1 },
    {
      id: 'toolu_01', role: 'tool', content: CHART_RESULT, timestamp: 2,
      toolName: 'RenderChart', toolInput: CHART_INPUT, toolStatus: 'completed',
    },
    { id: 'user-2', role: 'user', content: 'follow up', timestamp: 3 },
  ]

  /** A store harness whose fork verbs run for real against a live source tab. */
  function buildForkHarness() {
    const state: Record<string, any> = {
      tabs: [{
        id: 'source-tab',
        title: 'Source',
        customTitle: null,
        conversationId: 'source-conversation',
        engineProfileId: null,
        workingDirectory: '/repo',
        hasChosenDirectory: true,
        additionalDirs: [],
        pillColor: null,
        pillIcon: null,
      }],
      conversationPanes: new Map([[
        'source-tab',
        {
          activeInstanceId: 'main',
          instances: [{
            id: 'main',
            messages: SOURCE_MESSAGES,
            modelOverride: null,
            modelOverrideSource: null,
            permissionMode: 'auto',
            thinkingEffort: 'off',
          }],
        },
      ]]),
      activeTabId: 'source-tab',
      isExpanded: false,
    }
    const set = (partial: unknown): void => {
      const patch = typeof partial === 'function'
        ? (partial as (current: Record<string, any>) => Record<string, any>)(state)
        : partial
      Object.assign(state, patch)
    }
    Object.assign(state, createForkSlice(set as never, (() => state) as never))
    return state
  }

  beforeEach(() => {
    vi.clearAllMocks()
    _resetForkChartReconcileForTest()
    ;(globalThis as any).window = {
      ion: {
        createTab: vi.fn(async () => ({ tabId: 'created-tab' })),
        setPermissionMode: vi.fn(),
      },
    }
  })

  it('marks the tab forkTab created, not the source tab', async () => {
    const state = buildForkHarness()

    await state.forkTab('source-tab')

    expect(claimForkPendingChartReconcile('created-tab')).toBe(true)
    expect(claimForkPendingChartReconcile('source-tab')).toBe(false)
  })

  it('marks the tab forkFromMessage created, not the source tab', async () => {
    const state = buildForkHarness()

    await state.forkFromMessage('source-tab', 'user-2')

    expect(claimForkPendingChartReconcile('created-tab')).toBe(true)
    expect(claimForkPendingChartReconcile('source-tab')).toBe(false)
  })

  it('reconciles the fork against its own conversation once session_init lands', async () => {
    // End to end through the real verb: fork, mint the durable id, drain. The
    // copied chart row must reach main under the CREATED tab and the new
    // conversation — the pairing a source-tab marker would never produce.
    const state = buildForkHarness()
    await state.forkFromMessage('source-tab', 'user-2')

    const created = state.tabs.find((tab: { id: string }) => tab.id === 'created-tab')
    created.conversationId = 'created-conversation'
    maybeReconcileForkedCharts('created-tab', (() => state) as never)

    expect(reconcileMock.reconcileChartsForBranch).toHaveBeenCalledTimes(1)
    const [tabId, conversationId, messages] =
      reconcileMock.reconcileChartsForBranch.mock.calls[0] as [string, string, Array<{ toolName?: string }>]
    expect(tabId).toBe('created-tab')
    expect(conversationId).toBe('created-conversation')
    expect(messages.some((row) => row.toolName === 'RenderChart')).toBe(true)
  })

  it('does not reconcile the source tab when its own session_init arrives', async () => {
    // The source keeps running and reaches session_init on its next turn. It
    // owes no reconcile: its branch did not change.
    const state = buildForkHarness()
    await state.forkFromMessage('source-tab', 'user-2')

    maybeReconcileForkedCharts('source-tab', (() => state) as never)

    expect(reconcileMock.reconcileChartsForBranch).not.toHaveBeenCalled()
  })
})
