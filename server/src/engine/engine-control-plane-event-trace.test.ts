/**
 * The engine stamps every event of a run with the run's trace position. The
 * translation to NormalizedEvent builds fresh objects, and a client joins its
 * `prompt.visible` span to the run by the `trace_id` on the text_chunk it
 * renders, so the translation must carry both ids across.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), trace: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { handleEngineEvent } from './engine-control-plane-events'
import type { EventEmitterContext, TabEntry } from './engine-control-plane-events'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN = '00f067aa0ba902b7'

function emitted(event: Record<string, unknown>) {
  const emit = vi.fn()
  const ctx = { emit, bridge: {}, setStatus: vi.fn(), checkDrain: vi.fn() } as unknown as EventEmitterContext
  handleEngineEvent(ctx, 'tab-1', { status: 'running', toolCallCount: 0 } as unknown as TabEntry, event as never)
  return emit.mock.calls.filter((call) => call[0] === 'event').map((call) => call[2])
}

describe('engine event trace position', () => {
  it('rides the text_chunk translated from a stamped text delta', () => {
    const [chunk] = emitted({ type: 'engine_text_delta', text: 'hi', trace_id: TRACE, span_id: SPAN })
    expect(chunk).toEqual({ type: 'text_chunk', text: 'hi', trace_id: TRACE, span_id: SPAN })
  })

  it('rides a tool_call too', () => {
    const [call] = emitted({ type: 'engine_tool_start', toolName: 'Read', toolId: 't1', trace_id: TRACE, span_id: SPAN })
    expect(call).toMatchObject({ type: 'tool_call', trace_id: TRACE, span_id: SPAN })
  })

  it('adds nothing to an event emitted outside a run', () => {
    const [chunk] = emitted({ type: 'engine_text_delta', text: 'hi' })
    expect(chunk).toEqual({ type: 'text_chunk', text: 'hi' })
  })
})
