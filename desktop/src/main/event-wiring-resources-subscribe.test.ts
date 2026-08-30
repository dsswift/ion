import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Regression pins for the per-session resource subscription trigger.
 *
 * THE BUG THIS EXISTS FOR: the only subscribe trigger was
 * `engine_command_registry`, which the engine emits solely for a session that
 * loaded an extension. A plain conversation therefore never subscribed to its
 * own session resource broker.
 *
 * That is invisible until the DESKTOP itself publishes a session-scoped
 * resource. A Chart Output's item carries a conversationId, so the engine
 * routes it to the session broker (dispatch_resource.go) — where there was no
 * subscriber. The chart persisted to disk and drew in the transcript, and the
 * attachments panel stayed permanently empty with no error on any surface.
 *
 * Live evidence before the fix: zero `resource_subscribe` lines for the
 * chart-producing session key, and `resource_catalog_bootstrap` reporting
 * `scoped: 0` while three charts sat on disk.
 */

const bridge = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('./state', () => ({ engineBridge: bridge }))
vi.mock('./logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), commandLine: { appendSwitch: vi.fn() }, whenReady: vi.fn() },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  BrowserWindow: class {},
}))

import {
  ensureSessionResourceSubscription,
  clearResourceSubscriptions,
} from './event-wiring-resources'

describe('ensureSessionResourceSubscription', () => {
  beforeEach(() => {
    bridge.request.mockReset()
    bridge.request.mockResolvedValue({ ok: true, data: { subscriptionId: 'sub-1' } })
    clearResourceSubscriptions()
  })

  it('subscribes a session that never emitted engine_command_registry', async () => {
    // The exact defect: a conversation with no extension got no subscription.
    ensureSessionResourceSubscription('tab-7')
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalled())

    const [cmd, payload] = bridge.request.mock.calls[0] as [string, Record<string, unknown>]
    expect(cmd).toBe('resource_subscribe')
    expect(payload.key).toBe('tab-7')
    // Wildcard: the desktop subscribes to every kind, including `chart`.
    expect(payload.resourceKind).toBe('*')
  })

  it('is idempotent, so calling it from a per-event hot path is safe', async () => {
    ensureSessionResourceSubscription('tab-7')
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(1))

    // Simulates the status-event stream firing repeatedly for one session.
    for (let i = 0; i < 25; i += 1) ensureSessionResourceSubscription('tab-7')
    await Promise.resolve()

    expect(bridge.request).toHaveBeenCalledTimes(1)
  })

  it('subscribes each session separately', async () => {
    ensureSessionResourceSubscription('tab-a')
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(1))
    bridge.request.mockResolvedValue({ ok: true, data: { subscriptionId: 'sub-2' } })
    ensureSessionResourceSubscription('tab-b')
    await vi.waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(2))

    const keys = bridge.request.mock.calls.map(
      (call) => (call[1] as Record<string, unknown>).key,
    )
    expect(keys).toEqual(['tab-a', 'tab-b'])
  })

  it('ignores an empty key rather than issuing a keyless subscribe', () => {
    // A keyless subscribe would hit the GLOBAL broker, which is a different
    // scope and already covered by subscribeToGlobalResourceKinds.
    ensureSessionResourceSubscription('')
    expect(bridge.request).not.toHaveBeenCalled()
  })
})
