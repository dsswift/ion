import { describe, expect, it } from 'vitest'
import { generateSpreadPinOrderKeys, pinOrderKeyBetween, planPinnedMove, planPinnedReorder, sortPinnedByOrder } from '../inbox-pin-order'

describe('inbox pin ordering', () => {
  it('creates a key strictly between valid neighbors', () => {
    const key = pinOrderKeyBetween('g', 'm')
    expect(key).not.toBeNull()
    expect(key! > 'g' && key! < 'm').toBe(true)
  })

  it('materializes keyless neighbors before reordering', () => {
    const assignments = planPinnedReorder({ orderedIds: ['b', 'a'], keysById: new Map([['a', null], ['b', null]]), movedId: 'b' })
    expect(assignments).toHaveLength(2)
    expect(assignments[0]!.orderKey < assignments[1]!.orderKey).toBe(true)
  })

  it('plans an adjacent mobile movement', () => {
    const assignments = planPinnedMove({ orderedIds: ['a', 'b'], keysById: new Map([['a', 'g'], ['b', 'm']]), movedId: 'b', direction: 'up' })
    expect(assignments).toEqual([{ id: 'b', orderKey: expect.any(String) }])
  })

  it('keeps keyed pins above keyless pins', () => {
    expect(sortPinnedByOrder([{ id: 'old', createdAt: 1, pinOrderKey: null }, { id: 'arranged', createdAt: 2, pinOrderKey: 'm' }]).map((tab) => tab.id)).toEqual(['arranged', 'old'])
  })

  it('spreads monotonic repair keys', () => {
    expect(generateSpreadPinOrderKeys(4)).toEqual([...generateSpreadPinOrderKeys(4)].sort())
  })
})
