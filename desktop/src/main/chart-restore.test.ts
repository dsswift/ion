import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Restore pins for persisted charts.
 *
 * THE BUG THIS EXISTS FOR: the engine stores no resource content — the
 * producer owns persistence and re-announces its own items. The desktop
 * persisted every chart to disk but only ever published a delta at the moment
 * the tool ran. So after a desktop restart the charts were all still on disk
 * and absent from every surface: the attachments row the operator had been
 * using simply disappeared, with nothing in any log explaining it.
 *
 * `restoreConversationCharts` republishes them once a subscriber exists.
 */

type PublishArgs = [unknown, string, 'create' | 'update', { chartId: string }]
const publishMock = vi.hoisted(() => ({
  publishChartResource: vi.fn(async (..._args: unknown[]) => undefined),
}))
vi.mock('./chart-resource-publish', () => publishMock)

const storeMock = vi.hoisted(() => ({
  loadChartRecords: vi.fn(),
  conversationsWithCharts: vi.fn(() => [] as string[]),
  chartResourceItem: vi.fn((r: { chartId: string; conversationId: string }) => ({
    id: r.chartId, kind: 'chart', conversationId: r.conversationId,
  })),
  CHART_RESOURCE_KIND: 'chart',
}))
vi.mock('./chart-resource-store', () => storeMock)

const catalogMock = vi.hoisted(() => ({ resourceCatalog: { applyFullItem: vi.fn() } }))
vi.mock('./resource-catalog', () => catalogMock)
vi.mock('./broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../shared/types', () => ({ IPC: { RESOURCE_CATALOG_CHANGED: 'ion:resource-catalog-changed' } }))

const logs = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('./logger', () => ({ log: logs.log, warn: logs.warn, error: vi.fn() }))

import { restoreConversationCharts, resetChartRestoreState, hydrateChartCatalogFromDisk } from './chart-restore'

const bridge = { request: vi.fn(async () => ({ ok: true })) }

function record(chartId: string, revision = 1) {
  return { chartId, conversationId: 'conv-abc', title: chartId, revision, toolMessageId: 'm', createdAt: '', updatedAt: '', spec: {} }
}

describe('restoreConversationCharts', () => {
  beforeEach(() => {
    publishMock.publishChartResource.mockClear()
    storeMock.loadChartRecords.mockReset()
    logs.log.mockClear()
    logs.warn.mockClear()
    resetChartRestoreState()
  })

  it('republishes every persisted chart for the conversation', async () => {
    // The exact defect: these existed on disk and reached no surface.
    storeMock.loadChartRecords.mockReturnValue([record('c1'), record('c2', 3)])
    await restoreConversationCharts(bridge, 'tab-7', 'conv-abc')

    expect(publishMock.publishChartResource).toHaveBeenCalledTimes(2)
    const [firstBridge, firstKey, firstOp] =
      publishMock.publishChartResource.mock.calls[0] as unknown as PublishArgs
    expect(firstBridge).toBe(bridge)
    expect(firstKey).toBe('tab-7')
    // `create` because applyDelta upserts by identity — re-announcing an
    // existing chart is idempotent on every consumer.
    expect(firstOp).toBe('create')
  })

  it('runs once per conversation, not once per subscribe', async () => {
    // The subscribe path can fire repeatedly (reconnect, second instance);
    // re-reading disk every time would be pure waste.
    storeMock.loadChartRecords.mockReturnValue([record('c1')])
    await restoreConversationCharts(bridge, 'tab-7', 'conv-abc')
    await restoreConversationCharts(bridge, 'tab-7', 'conv-abc')
    await restoreConversationCharts(bridge, 'tab-9', 'conv-abc')

    expect(storeMock.loadChartRecords).toHaveBeenCalledTimes(1)
    expect(publishMock.publishChartResource).toHaveBeenCalledTimes(1)
  })

  it('restores each conversation independently', async () => {
    storeMock.loadChartRecords.mockReturnValue([record('c1')])
    await restoreConversationCharts(bridge, 'tab-7', 'conv-a')
    await restoreConversationCharts(bridge, 'tab-8', 'conv-b')
    expect(publishMock.publishChartResource).toHaveBeenCalledTimes(2)
  })

  it('publishes nothing when the conversation has no charts', async () => {
    storeMock.loadChartRecords.mockReturnValue([])
    await restoreConversationCharts(bridge, 'tab-7', 'conv-abc')
    expect(publishMock.publishChartResource).not.toHaveBeenCalled()
  })

  it('ignores a call with no conversation id', async () => {
    // A session whose conversation is not resolved yet must not be treated as
    // "restored", or its real charts would never be republished.
    await restoreConversationCharts(bridge, 'tab-7', '')
    expect(storeMock.loadChartRecords).not.toHaveBeenCalled()

    storeMock.loadChartRecords.mockReturnValue([record('c1')])
    await restoreConversationCharts(bridge, 'tab-7', 'conv-abc')
    expect(publishMock.publishChartResource).toHaveBeenCalledTimes(1)
  })

  it('retries on the next subscribe when reading disk fails', async () => {
    // A read failure must not mark the conversation permanently restored.
    storeMock.loadChartRecords.mockImplementationOnce(() => { throw new Error('EIO') })
    await restoreConversationCharts(bridge, 'tab-7', 'conv-abc')
    expect(logs.warn).toHaveBeenCalledTimes(1)

    storeMock.loadChartRecords.mockReturnValue([record('c1')])
    await restoreConversationCharts(bridge, 'tab-7', 'conv-abc')
    expect(publishMock.publishChartResource).toHaveBeenCalledTimes(1)
  })
})

/**
 * THE TIMING BUG THIS EXISTS FOR: subscribe-time restoration is correct but
 * LATE. A session subscribes when the engine attaches to it — measured at
 * 3m40s after the conversation was opened in a real log — and the renderer's
 * first catalog read had long since returned zero charts. The attachments
 * panel painted empty and corrected itself minutes later, violating the
 * view-readiness rule that a panel is complete when it renders.
 *
 * Charts are files on disk keyed by conversation id, so the catalog can be
 * seeded before any renderer reads it, with no session and no engine.
 */
describe('hydrateChartCatalogFromDisk', () => {
  beforeEach(() => {
    catalogMock.resourceCatalog.applyFullItem.mockClear()
    publishMock.publishChartResource.mockClear()
    storeMock.loadChartRecords.mockReset()
    storeMock.conversationsWithCharts.mockReset()
    logs.log.mockClear()
    logs.warn.mockClear()
  })

  it('seeds the catalog from every conversation that has charts on disk', () => {
    storeMock.conversationsWithCharts.mockReturnValue(['conv-a', 'conv-b'])
    storeMock.loadChartRecords.mockImplementation((id: string) =>
      id === 'conv-a' ? [record('c1'), record('c2')] : [record('c3')])

    hydrateChartCatalogFromDisk()

    expect(catalogMock.resourceCatalog.applyFullItem).toHaveBeenCalledTimes(3)
    const kinds = catalogMock.resourceCatalog.applyFullItem.mock.calls.map((c) => c[0])
    expect(new Set(kinds)).toEqual(new Set(['chart']))
  })

  it('needs no session or engine, so it can run before any renderer reads', () => {
    // The whole point: no bridge argument, no session key, no publish.
    storeMock.conversationsWithCharts.mockReturnValue(['conv-a'])
    storeMock.loadChartRecords.mockReturnValue([record('c1')])
    expect(() => hydrateChartCatalogFromDisk()).not.toThrow()
    expect(publishMock.publishChartResource).not.toHaveBeenCalled()
  })

  it('does nothing when no conversation has charts', () => {
    storeMock.conversationsWithCharts.mockReturnValue([])
    hydrateChartCatalogFromDisk()
    expect(catalogMock.resourceCatalog.applyFullItem).not.toHaveBeenCalled()
  })

  it('keeps hydrating when one conversation is unreadable', () => {
    // One bad directory must not cost every other conversation its charts.
    storeMock.conversationsWithCharts.mockReturnValue(['bad', 'good'])
    storeMock.loadChartRecords.mockImplementation((id: string) => {
      if (id === 'bad') throw new Error('EIO')
      return [record('c1')]
    })

    hydrateChartCatalogFromDisk()

    expect(logs.warn).toHaveBeenCalledTimes(1)
    expect(catalogMock.resourceCatalog.applyFullItem).toHaveBeenCalledTimes(1)
  })
})

/**
 * Startup wiring.
 *
 * The hydration function is worthless if nothing calls it before the renderer
 * reads. Reverting the single call site in app-lifecycle left the entire main
 * suite green while reproducing the original defect exactly — a fix that
 * exists but never runs. This pins the call itself.
 *
 * Read as source rather than executed: importing app-lifecycle pulls in
 * Electron, the engine bridge, and window management, none of which belong in
 * a unit test. The seam being protected is "is it wired", which the source
 * answers directly.
 */
describe('startup wiring', () => {
  it('is invoked from app-lifecycle before any renderer can read the catalog', () => {
    const source = readFileSync(join(__dirname, 'app-lifecycle.ts'), 'utf8')
    expect(source).toContain('hydrateChartCatalogFromDisk()')

    // It must run in the synchronous setup body, not inside whenReady: the
    // renderer's first catalog read races app.whenReady, which is the exact
    // ordering that made the panel paint empty.
    const callIndex = source.indexOf('hydrateChartCatalogFromDisk()')
    const readyIndex = source.indexOf('app.whenReady()')
    expect(callIndex).toBeGreaterThan(-1)
    expect(readyIndex).toBeGreaterThan(-1)
    expect(callIndex).toBeLessThan(readyIndex)
  })
})
