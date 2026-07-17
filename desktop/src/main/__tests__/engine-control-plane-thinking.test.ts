import { vi, describe, it, expect, beforeEach } from 'vitest'

// Pin the log-level demotion of the per-token reasoning stream. A machine-
// freezing wedge was preceded by a flood of INFO-level `thinking_delta` lines
// (2-3 per token, across ~30 concurrent sessions), each of which the main-
// process logger serialized in the hot path. The per-token delta must log at
// TRACE so it is filtered before serialization at the default INFO level; only
// the low-volume block boundaries stay at INFO. If someone re-promotes the
// delta to `log`, this test goes red.
const { mockLog, mockTrace } = vi.hoisted(() => ({ mockLog: vi.fn(), mockTrace: vi.fn() }))

vi.mock('../logger', () => ({
  log: mockLog,
  trace: mockTrace,
}))

import { handleThinkingEvent } from '../engine-control-plane-thinking'

function makeCtx() {
  return { emit: vi.fn() } as any
}

describe('handleThinkingEvent — reasoning-stream log levels', () => {
  beforeEach(() => {
    mockLog.mockClear()
    mockTrace.mockClear()
  })

  it('logs the per-token thinking_delta at TRACE, never at INFO', () => {
    const ctx = makeCtx()
    handleThinkingEvent(ctx, 'tab-1', {} as any, { type: 'engine_thinking_delta', thinkingText: 'reasoning…' } as any)

    // Demoted: routed through trace(). The module wrapper prepends the
    // 'SessionPlane' tag, so the raw logger export sees (tag, msg, fields).
    expect(mockTrace).toHaveBeenCalledWith('SessionPlane', 'thinking_delta', expect.objectContaining({ tab_id: 'tab-1' }))
    // And crucially NOT through the INFO logger — that was the flood.
    const infoCalledForDelta = mockLog.mock.calls.some(([, msg]) => msg === 'thinking_delta')
    expect(infoCalledForDelta).toBe(false)

    // The event is still translated and forwarded — demotion is log-only.
    expect(ctx.emit).toHaveBeenCalledWith('event', 'tab-1', expect.objectContaining({ type: 'thinking_delta', text: 'reasoning…' }))
  })

  it('keeps the low-volume block boundaries at INFO', () => {
    const ctx = makeCtx()
    handleThinkingEvent(ctx, 'tab-1', {} as any, { type: 'engine_thinking_block_start' } as any)
    expect(mockLog).toHaveBeenCalledWith('SessionPlane', 'thinking_block_start', expect.objectContaining({ tab_id: 'tab-1' }))
  })
})
