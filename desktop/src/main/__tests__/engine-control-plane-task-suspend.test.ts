import { vi, describe, it, expect, beforeEach } from 'vitest'

// engine_task_suspended crosses the EngineEvent→NormalizedEvent seam, and the
// two sides describe the suspend differently on purpose: the wire event carries
// COUNTS (taskSuspendAwaitingCount for pending child dispatches,
// taskSuspendAwaitingTaskCount for outstanding background bash commands) while
// the normalized variant's fields are ID ARRAYS.
//
// Before this suite the arm hardcoded `awaitingDispatchIds: undefined` and read
// neither count, so a parked session and a dispatch-suspended one were
// indistinguishable in the log and taskSuspendAwaitingTaskCount was decoded off
// the wire and dropped on the floor. No test crossed the seam, so nothing
// caught it.
const { mockLog, mockDebug } = vi.hoisted(() => ({ mockLog: vi.fn(), mockDebug: vi.fn() }))

vi.mock('../logger', () => ({
  log: mockLog,
  debug: mockDebug,
}))

import { handleStreamSignalEvent } from '../engine-control-plane-stream'

function makeCtx() {
  return { emit: vi.fn() } as any
}

describe('handleStreamSignalEvent — engine_task_suspended', () => {
  beforeEach(() => {
    mockLog.mockClear()
    mockDebug.mockClear()
  })

  it('logs BOTH awaited counts so a parked session is distinguishable from a dispatch suspend', () => {
    const ctx = makeCtx()
    const handled = handleStreamSignalEvent(ctx, 'tab-1', {} as any, {
      type: 'engine_task_suspended',
      taskSuspendAwaitingCount: 2,
      taskSuspendAwaitingTaskCount: 3,
    } as any)

    expect(handled).toBe(true)
    expect(mockDebug).toHaveBeenCalledWith('SessionPlane', 'task_suspended', expect.objectContaining({
      tab_id: 'tab-1',
      awaiting_count: 2,
      awaiting_task_count: 3,
    }))
  })

  it('defaults both counts to 0 when the engine omits them (omitempty on the wire)', () => {
    const ctx = makeCtx()
    handleStreamSignalEvent(ctx, 'tab-1', {} as any, { type: 'engine_task_suspended' } as any)

    expect(mockDebug).toHaveBeenCalledWith('SessionPlane', 'task_suspended', expect.objectContaining({
      awaiting_count: 0,
      awaiting_task_count: 0,
    }))
  })

  it('forwards a task_suspend without fabricating ID arrays from the counts', () => {
    const ctx = makeCtx()
    handleStreamSignalEvent(ctx, 'tab-1', {} as any, {
      type: 'engine_task_suspended',
      taskSuspendAwaitingCount: 1,
      taskSuspendAwaitingTaskCount: 4,
    } as any)

    expect(ctx.emit).toHaveBeenCalledWith('event', 'tab-1', { type: 'task_suspend' })
    // Specifically NOT invented: the wire has no IDs to forward, and a
    // placeholder array would be a lie a consumer could act on.
    const [, , emitted] = ctx.emit.mock.calls[0]
    expect(emitted.awaitingDispatchIds).toBeUndefined()
    expect(emitted.awaitingTaskIds).toBeUndefined()
  })
})
