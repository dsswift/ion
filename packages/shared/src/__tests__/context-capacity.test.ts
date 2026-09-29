import { describe, expect, it } from 'vitest'
import {
  contextCapacityState,
  resolveContextCapacity,
  selectedModelContextLimit,
} from '../context-capacity'

describe('context capacity', () => {
  it('uses occupancy and the selected model effective limit', () => {
    const limit = selectedModelContextLimit(200_000, 20_000)
    const capacity = resolveContextCapacity(167_000, limit)

    expect(limit).toBe(167_000)
    expect(capacity?.percent).toBe(100)
    expect(contextCapacityState(capacity)).toBe('full')
  })

  it('warns at 80 percent before it blocks', () => {
    const capacity = resolveContextCapacity(133_600, 167_000)
    expect(contextCapacityState(capacity)).toBe('warning')
  })

  it('reports full capacity without imposing client-side prompt admission', () => {
    const full = resolveContextCapacity(167_000, 167_000)
    expect(contextCapacityState(full)).toBe('full')
  })
})
