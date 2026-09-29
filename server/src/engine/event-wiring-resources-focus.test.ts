import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * The focus item is created before it is updated. It used to be published as
 * an `update` from the first switch on, so the resource catalog, which has
 * never seen the item created, dropped every one of them with a "delta target
 * missing" warning and never listed the focus item.
 */

const bridge = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../state', () => ({ engineBridge: bridge, state: {} }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

import { publishTabFocus, _resetTabFocusForTest } from './event-wiring-resources'

const ops = (): unknown[] => bridge.request.mock.calls.map((call) => (call[1] as { resourceOp: string }).resourceOp)

describe('publishTabFocus', () => {
  beforeEach(() => {
    bridge.request.mockReset()
    _resetTabFocusForTest()
  })

  it('creates the focus item, then updates it', async () => {
    bridge.request.mockResolvedValue({ ok: true })
    publishTabFocus('tab-1')
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    publishTabFocus('tab-2')
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(2))
    expect(ops()).toEqual(['create', 'update'])
  })

  it('creates again when the create was refused', async () => {
    bridge.request.mockResolvedValueOnce({ ok: false, error: 'no engine' }).mockResolvedValue({ ok: true })
    publishTabFocus('tab-1')
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    publishTabFocus('tab-2')
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(2))
    expect(ops()).toEqual(['create', 'create'])
  })
})
