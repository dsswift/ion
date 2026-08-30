import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Reconciliation pins — rebuilding a conversation's chart index onto its
 * active branch and publishing exactly what moved.
 *
 * THE BUG THESE EXIST FOR: `rebuildFromHistory` shipped correct and
 * UNREACHABLE — no production code called it. After a rewind past a chart
 * revision the persisted record and the attachments row still named the
 * abandoned revision, while the transcript (derived live from the visible
 * messages) correctly showed the older card. The panel then offered a jump to
 * a revision the branch could not show.
 *
 * The second half is the publish partition: a rewind rebuilds the WHOLE
 * conversation index, so republishing every record would fan a no-op create to
 * the Overlay, the Studio mirror, and iOS on every branch change.
 */

const publishMock = vi.hoisted(() => ({
  publishChartResource: vi.fn(async (..._args: unknown[]) => undefined),
  publishChartResourceRemoval: vi.fn(async (..._args: unknown[]) => undefined),
}))
vi.mock('./chart-resource-publish', () => publishMock)

const storeMock = vi.hoisted(() => ({ rebuildFromHistory: vi.fn() }))
vi.mock('./chart-resource-store', () => storeMock)

const logs = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('./logger', () => ({ log: logs.log, warn: logs.warn, error: vi.fn() }))

import { reconcileConversationCharts } from './chart-reconcile'

const bridge = { request: vi.fn(async () => ({ ok: true })) }

function record(chartId: string, revision = 1) {
  return {
    chartId, conversationId: 'conv-abc', title: chartId, revision,
    toolMessageId: 'toolu_01', createdAt: '', updatedAt: '', spec: {},
  }
}

function outcome(over: Partial<Record<'records' | 'created' | 'updated' | 'retained' | 'removed', unknown[]>> = {}) {
  return {
    records: [], created: [], updated: [], retained: [], removed: [],
    ...over,
  }
}

const ROWS = [{ toolMessageId: 'toolu_01', toolInput: '{}', resultText: 'id: c1 · x', index: 0 }]

describe('reconcileConversationCharts', () => {
  beforeEach(() => {
    publishMock.publishChartResource.mockClear()
    publishMock.publishChartResourceRemoval.mockClear()
    storeMock.rebuildFromHistory.mockReset()
    logs.log.mockClear()
    logs.warn.mockClear()
  })

  it('rebuilds from the supplied branch rows', async () => {
    storeMock.rebuildFromHistory.mockReturnValue(outcome())
    await reconcileConversationCharts(bridge, 'tab-7', 'conv-abc', ROWS)
    expect(storeMock.rebuildFromHistory).toHaveBeenCalledWith('conv-abc', ROWS)
  })

  it('publishes a create for a chart the branch produced', async () => {
    storeMock.rebuildFromHistory.mockReturnValue(outcome({ created: [record('c1')] }))
    const result = await reconcileConversationCharts(bridge, 'tab-7', 'conv-abc', ROWS)

    expect(publishMock.publishChartResource).toHaveBeenCalledTimes(1)
    const [, key, op] = publishMock.publishChartResource.mock.calls[0] as unknown as [unknown, string, string]
    expect(key).toBe('tab-7')
    expect(op).toBe('create')
    expect(result.created).toBe(1)
  })

  it('publishes an update for a chart whose current revision moved', async () => {
    // The rewind case: the record reverted to an earlier revision, so every
    // subscriber must be told or it keeps rendering the abandoned data.
    storeMock.rebuildFromHistory.mockReturnValue(outcome({ updated: [record('c1', 1)] }))
    await reconcileConversationCharts(bridge, 'tab-7', 'conv-abc', ROWS)

    const [, key, op] = publishMock.publishChartResource.mock.calls[0] as unknown as [unknown, string, string]
    expect(key).toBe('tab-7')
    expect(op).toBe('update')
  })

  it('publishes a removal through the owning session key', async () => {
    storeMock.rebuildFromHistory.mockReturnValue(outcome({ removed: ['c-gone'] }))
    await reconcileConversationCharts(bridge, 'tab-7', 'conv-abc', [])

    expect(publishMock.publishChartResourceRemoval).toHaveBeenCalledTimes(1)
    const [, key, conversationId, chartId] =
      publishMock.publishChartResourceRemoval.mock.calls[0] as unknown as [unknown, string, string, string]
    expect(key).toBe('tab-7')
    expect(conversationId).toBe('conv-abc')
    expect(chartId).toBe('c-gone')
  })

  it('publishes NOTHING for a retained chart', async () => {
    // The no-op guard: without it every rewind refans every chart in the
    // conversation to every surface.
    storeMock.rebuildFromHistory.mockReturnValue(outcome({ retained: [record('c1')] }))
    const result = await reconcileConversationCharts(bridge, 'tab-7', 'conv-abc', ROWS)

    expect(publishMock.publishChartResource).not.toHaveBeenCalled()
    expect(publishMock.publishChartResourceRemoval).not.toHaveBeenCalled()
    expect(result.retained).toBe(1)
  })

  it('refuses without a conversation id, and never rebuilds', async () => {
    // A chart record is conversation-scoped; rebuilding under an empty scope
    // would read an unrelated directory and could delete real records.
    const result = await reconcileConversationCharts(bridge, 'tab-7', '', ROWS)
    expect(storeMock.rebuildFromHistory).not.toHaveBeenCalled()
    expect(result).toEqual({ created: 0, updated: 0, retained: 0, removed: 0 })
    expect(logs.warn).toHaveBeenCalledTimes(1)
  })

  it('refuses without a session key, and never rebuilds', async () => {
    // The item carries a conversationId, so the publish takes the SESSION
    // route: with no key the engine finds no broker and every delta is refused,
    // leaving the corrected index invisible until the next cold load.
    const result = await reconcileConversationCharts(bridge, '', 'conv-abc', ROWS)
    expect(storeMock.rebuildFromHistory).not.toHaveBeenCalled()
    expect(result.created).toBe(0)
    expect(logs.warn).toHaveBeenCalledTimes(1)
  })

  it('reports a rebuild failure without throwing into the caller', async () => {
    // The caller is a history flow (rewind commit, session_init). A throw here
    // would break the conversation, not just the chart index.
    storeMock.rebuildFromHistory.mockImplementation(() => { throw new Error('EIO') })
    const result = await reconcileConversationCharts(bridge, 'tab-7', 'conv-abc', ROWS)
    expect(result.created).toBe(0)
    expect(logs.warn).toHaveBeenCalledTimes(1)
    expect(publishMock.publishChartResource).not.toHaveBeenCalled()
  })
})
