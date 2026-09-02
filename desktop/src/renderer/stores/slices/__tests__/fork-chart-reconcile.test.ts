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
 * Fork verbs now receive the durable conversation id before they publish the
 * tab. Chart reconciliation therefore runs immediately against the created tab
 * and does not wait for a later session_init handoff.
 */
describe('fork verbs reconcile the durable created conversation', () => {
  const SOURCE_MESSAGES = [
    { id: 'user-1', role: 'user', content: 'chart it', timestamp: 1 },
    {
      id: 'toolu_01', role: 'tool', content: CHART_RESULT, timestamp: 2,
      toolName: 'RenderChart', toolInput: CHART_INPUT, toolStatus: 'completed',
    },
    { id: 'user-2', role: 'user', content: 'follow up', timestamp: 3 },
  ]

  function buildForkHarness() {
    const state: Record<string, any> = {
      tabs: [{
        id: 'source-tab', title: 'Source', customTitle: null,
        conversationId: 'source-conversation', engineProfileId: null,
        workingDirectory: '/repo', hasChosenDirectory: true, additionalDirs: [],
        pillColor: null, pillIcon: null,
      }],
      conversationPanes: new Map([[
        'source-tab',
        {
          activeInstanceId: 'main',
          instances: [{
            id: 'main', messages: SOURCE_MESSAGES, modelOverride: null,
            modelOverrideSource: null, permissionMode: 'auto', thinkingEffort: 'off',
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
        engineFork: vi.fn(async () => ({
          ok: true, newKey: 'created-tab', conversationId: 'created-conversation',
        })),
        engineBroadcastHistory: vi.fn(async () => undefined),
        reconcileCharts: vi.fn(),
        setPermissionMode: vi.fn(),
      },
    }
  })

  it('forkTab records the engine-created identity and reconciles its copied chart rows', async () => {
    const state = buildForkHarness()

    await state.forkTab('source-tab')

    expect(state.tabs.find((tab: { id: string }) => tab.id === 'created-tab')).toMatchObject({
      conversationId: 'created-conversation',
      lastKnownSessionId: 'created-conversation',
    })
    expect(reconcileMock.reconcileChartsForBranch).toHaveBeenCalledWith(
      'created-tab', 'created-conversation', expect.arrayContaining([expect.objectContaining({ toolName: 'RenderChart' })]),
    )
    expect(claimForkPendingChartReconcile('created-tab')).toBe(false)
  })

  it('forkFromMessage creates the prefix before the selected turn', async () => {
    const state = buildForkHarness()

    await state.forkFromMessage('source-tab', 'user-2')

    const instance = state.conversationPanes.get('created-tab').instances[0]
    expect(instance.messages).toHaveLength(2)
    expect(instance.historyHydrated).toBe(true)
    expect(instance.conversationIds).toEqual(['created-conversation'])
    expect((window as any).ion.engineFork).toHaveBeenCalledWith('source-tab', 'created-tab', {
      messageIndex: 1, entryId: 'user-2', userTurnIndex: 1,
    })
    expect((window as any).ion.engineBroadcastHistory).toHaveBeenCalledWith(
      'created-tab', 'main', { queueUntilTabExists: true },
    )
  })
})
