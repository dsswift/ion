/**
 * engine_status(starting) is a session attaching. A restored conversation at
 * server boot passes through it with nothing asked of it, and must read as
 * 'starting'. A submitted prompt waiting on the attach must stay 'connecting',
 * so the conversation reads as working from the submit to the run.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@ion/server/automation/runtime', () => ({
  getAutomationRuntime: () => ({ triggerStatus: vi.fn(), triggerCompletion: vi.fn() }),
}))

import { handleStatusEvent } from './engine-control-plane-status-event'
import type { EventEmitterContext, TabEntry } from './engine-control-plane-events-types'

function statusAfterStarting(tab: Partial<TabEntry>) {
  const setStatus = vi.fn()
  const ctx = { emit: vi.fn(), bridge: {}, setStatus, checkDrain: vi.fn() } as unknown as EventEmitterContext
  handleStatusEvent(ctx, 'tab-1', tab as TabEntry, { type: 'engine_status', fields: { state: 'starting' } } as never)
  return setStatus
}

describe('engine_status starting', () => {
  it('marks a bare session attach as starting', () => {
    const setStatus = statusAfterStarting({ status: 'idle', activeRequestId: null, startedAt: 0 })
    expect(setStatus).toHaveBeenCalledWith('tab-1', 'starting')
  })

  it('keeps a submitted prompt connecting while its session attaches', () => {
    const setStatus = statusAfterStarting({ status: 'connecting', activeRequestId: 'req-1', startedAt: 1 })
    expect(setStatus).not.toHaveBeenCalled()
  })
})
