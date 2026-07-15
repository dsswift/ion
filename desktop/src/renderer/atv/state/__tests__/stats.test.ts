import { describe, it, expect } from 'vitest'
import { AtvStats } from '../stats'
import type { NormalizedEvent } from '../../../../shared/types'

function end(id: string, agent: string, patch: Record<string, unknown> = {}): NormalizedEvent {
  return {
    type: 'dispatch_end',
    dispatchId: id,
    dispatchAgent: agent,
    dispatchExitCode: 0,
    dispatchElapsed: 10,
    dispatchCost: 0.5,
    dispatchInputTokens: 1000,
    dispatchOutputTokens: 200,
    dispatchToolCount: 3,
    dispatchDepth: 1,
    dispatchParentId: '',
    ...patch,
  } as unknown as NormalizedEvent
}
function status(cost: number): NormalizedEvent {
  return { type: 'status', fields: { state: 'running', conversationCostUsd: cost } } as unknown as NormalizedEvent
}

describe('AtvStats', () => {
  it('accumulates per-agent totals across dispatches', () => {
    const s = new AtvStats()
    s.ingest(end('d1', 'dev'), 0)
    s.ingest(end('d2', 'dev', { dispatchCost: 0.25, dispatchInputTokens: 500 }), 0)
    s.ingest(end('d3', 'gfx'), 0)
    expect(s.totalsFor('dev')).toEqual({ costUsd: 0.75, elapsedSec: 20, inputTokens: 1500, outputTokens: 400, dispatches: 2 })
    expect(s.teamSpend(['dev', 'gfx'])).toBeCloseTo(1.25)
  })

  it('dedupes by dispatchId (backfill replay never double-counts)', () => {
    const s = new AtvStats()
    s.ingest(end('d1', 'dev'), 0)
    s.ingest(end('d1', 'dev'), 0)
    expect(s.totalsFor('dev')!.dispatches).toBe(1)
  })

  it('cost samples: dedupe-by-value, ring cap, and rate over the window', () => {
    const s = new AtvStats()
    s.ingest(status(1.0), 0)
    s.ingest(status(1.0), 30_000) // same value: no new sample
    s.ingest(status(2.0), 60_000)
    expect(s.samples).toHaveLength(2)
    expect(s.ratePerMinute(60_000)).toBeCloseTo(1.0) // $1 over 1 min
    // Old samples fall outside the window.
    expect(s.ratePerMinute(600_000, 60_000)).toBe(0)
  })

  it('rate is 0 with insufficient data', () => {
    const s = new AtvStats()
    expect(s.ratePerMinute(0)).toBe(0)
    s.ingest(status(1), 0)
    expect(s.ratePerMinute(0)).toBe(0)
  })
})
