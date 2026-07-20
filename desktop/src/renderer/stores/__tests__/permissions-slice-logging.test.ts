/**
 * permissions-slice-logging.test.ts — pins that a failed respondPermission /
 * respondElicitation IPC is logged (rError), not silently swallowed. Before the
 * observability pass these used `.catch(() => {})`, so a rejected IPC meant the
 * user's approve/deny never reached the engine while the UI cleared the queue —
 * a silent lost decision.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const rError = vi.fn()
vi.mock('../../rendererLogger', () => ({
  rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: (...a: unknown[]) => rError(...a), rTrace: vi.fn(),
}))
vi.mock('../session-store-helpers', () => ({ nextMsgId: vi.fn(() => 'm1') }))
vi.mock('../conversation-instance', () => ({
  activeInstance: vi.fn(() => null),
  commitInstance: vi.fn((panes: unknown) => panes),
}))

import { createPermissionsSlice } from '../slices/permissions-slice'

describe('permissions-slice logging', () => {
  beforeEach(() => { rError.mockClear() })
  afterEach(() => { vi.restoreAllMocks() })

  it('logs rError when respondPermission IPC rejects', async () => {
    const rejent = new Error('ipc down')
    ;(globalThis as any).window = {
      ion: {
        respondPermission: vi.fn(() => Promise.reject(rejent)),
      },
    }
    const set = vi.fn()
    const get = vi.fn(() => ({ tabs: [], conversationPanes: new Map() })) as never
    const slice = createPermissionsSlice(set as never, get)

    slice.respondPermission!('tab1', 'q1', 'opt1')
    // Let the rejected promise's .catch microtask run.
    await Promise.resolve()
    await Promise.resolve()

    expect(rError).toHaveBeenCalledWith(
      'permissions',
      'respondPermission failed',
      expect.objectContaining({ tab_id: 'tab1' }),
    )
  })
})
