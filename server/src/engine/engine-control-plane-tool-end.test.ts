/**
 * A tool that starts background work reports the work's ID on engine_tool_end.
 * The server must pass it on, or the tool row loses its only link to the live
 * task and reads as finished while the task still runs.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), trace: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { handleEngineEvent } from './engine-control-plane-events'
import type { EventEmitterContext, TabEntry } from './engine-control-plane-events'

function toolResultFor(event: Record<string, unknown>) {
  const emit = vi.fn()
  const ctx = { emit, bridge: {}, setStatus: vi.fn(), checkDrain: vi.fn() } as unknown as EventEmitterContext
  handleEngineEvent(ctx, 'tab-1', { status: 'running' } as unknown as TabEntry, event as never)
  return emit.mock.calls.find((call) => call[0] === 'event' && call[2]?.type === 'tool_result')?.[2]
}

describe('engine_tool_end', () => {
  it('carries the background task id to the tool_result', () => {
    const result = toolResultFor({ type: 'engine_tool_end', toolId: 'toolu_1', result: 'Background task started: bash-1-1', backgroundTaskId: 'bash-1-1' })
    expect(result).toMatchObject({ toolId: 'toolu_1', backgroundTaskId: 'bash-1-1', isError: false })
  })

  it('omits the field for a tool that started nothing', () => {
    const result = toolResultFor({ type: 'engine_tool_end', toolId: 'toolu_2', result: 'ok' })
    expect(result).toBeDefined()
    expect(result).not.toHaveProperty('backgroundTaskId')
  })
})
