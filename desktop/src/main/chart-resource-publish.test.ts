import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Publish-path pins for chart resources.
 *
 * THE BUG THESE EXIST FOR — two defects that combined to produce a chart that
 * rendered in the transcript but never appeared in the attachments panel:
 *
 *  1. WRONG ROUTE. `dispatchResourcePublish` routes on the ITEM's
 *     `conversationId` alone (engine/internal/server/dispatch_resource.go):
 *     empty → global broker, set → the SESSION broker looked up by `cmd.Key`.
 *     A chart always carries a conversationId, so it takes the session route —
 *     but the publish sent `key: ''`, so the engine found no broker and
 *     refused with `no session or broker for key ""`. The `resourceGlobal:
 *     true` flag that was being sent is not read by the publish path at all.
 *
 *  2. INVISIBLE REFUSAL. `EngineBridge.request` RESOLVES with
 *     `{ ok: false, error }` on an engine-side refusal; it does not reject.
 *     The old code logged "chart resource published" inside `try` without
 *     reading `ok`, so a refused publish reported itself as a success. The log
 *     said the chart shipped while the panel stayed empty — the failure was
 *     completely invisible.
 *
 * Both assertions below fail on the pre-fix code.
 */

const logs = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('./logger', () => ({ log: logs.log, warn: logs.warn, error: vi.fn() }))

import { publishChartResource, publishChartResourceRemoval } from './chart-resource-publish'
import type { ChartRecord } from './chart-resource-store'

/** A stand-in for the engine bridge's request method, typed as the real one. */
type RequestFn = (
  cmd: string,
  payload?: Record<string, unknown>,
) => Promise<{ ok: boolean; error?: string }>

/** The payload a request was called with, for assertion. */
function payloadOf(request: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = request.mock.calls[0] as unknown as [string, Record<string, unknown>]
  return call[1]
}

function record(): ChartRecord {
  return {
    chartId: 'chart-1',
    conversationId: 'conv-abc',
    title: 'Series comparison',
    revision: 1,
    toolMessageId: 'msg-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    spec: {
      schemaVersion: 1,
      kind: 'line',
      title: 'Series comparison',
      labels: ['P1', 'P2'],
      datasets: [{ label: 'Series A', data: [1, 2] }],
    },
  }
}

describe('publishChartResource — routing', () => {
  beforeEach(() => { logs.log.mockClear(); logs.warn.mockClear() })

  it('sends the session key, because a conversation-scoped item takes the session route', async () => {
    const request = vi.fn<RequestFn>(async () => ({ ok: true }))
    await publishChartResource({ request }, 'tab-7', 'create', record())

    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toBe('resource_publish')
    const payload = payloadOf(request)
    // The exact defect: an empty key made the engine refuse the publish.
    expect(payload.key).toBe('tab-7')
    expect(payload.resourceKind).toBe('chart')
    expect(payload.resourceOp).toBe('create')
  })

  it('keeps the conversationId on the item so subscribers can scope it to a tab', async () => {
    const request = vi.fn<RequestFn>(async () => ({ ok: true }))
    await publishChartResource({ request }, 'tab-7', 'create', record())

    const item = payloadOf(request).resourceItem as { conversationId?: string }
    expect(item.conversationId).toBe('conv-abc')
  })

  it('routes a removal through the same session key', async () => {
    const request = vi.fn<RequestFn>(async () => ({ ok: true }))
    await publishChartResourceRemoval({ request }, 'tab-7', 'conv-abc', 'chart-1')

    const payload = payloadOf(request)
    expect(payload.key).toBe('tab-7')
    expect(payload.resourceOp).toBe('delete')
  })
})

describe('publishChartResource — a refusal is never reported as success', () => {
  beforeEach(() => { logs.log.mockClear(); logs.warn.mockClear() })

  it('warns, and does not log success, when the engine refuses', async () => {
    // The engine's real refusal shape: resolved, not thrown.
    const request = vi.fn<RequestFn>(async () => ({
      ok: false,
      error: 'resource_publish: no session or broker for key ""',
    }))
    await publishChartResource({ request }, 'tab-7', 'create', record())

    expect(logs.log).not.toHaveBeenCalled()
    expect(logs.warn).toHaveBeenCalledTimes(1)
    // The module's helpers call the logger as (tag, msg, fields).
    const [, , fields] = logs.warn.mock.calls[0] as unknown as [string, string, Record<string, unknown>]
    expect(String(fields.error)).toContain('no session or broker')
  })

  it('logs success only when the engine accepted the publish', async () => {
    const request = vi.fn<RequestFn>(async () => ({ ok: true }))
    await publishChartResource({ request }, 'tab-7', 'create', record())

    expect(logs.warn).not.toHaveBeenCalled()
    expect(logs.log).toHaveBeenCalledTimes(1)
  })

  it('warns when a removal is refused', async () => {
    const request = vi.fn<RequestFn>(async () => ({ ok: false, error: 'nope' }))
    await publishChartResourceRemoval({ request }, 'tab-7', 'conv-abc', 'chart-1')

    expect(logs.log).not.toHaveBeenCalled()
    expect(logs.warn).toHaveBeenCalledTimes(1)
  })

  it('warns when the socket itself throws', async () => {
    const request = vi.fn<RequestFn>(async () => { throw new Error('socket closed') })
    await publishChartResource({ request }, 'tab-7', 'create', record())

    expect(logs.log).not.toHaveBeenCalled()
    expect(logs.warn).toHaveBeenCalledTimes(1)
  })
})
