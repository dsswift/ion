/**
 * resource-slice — batched mark-all-read helper
 *
 * Pins the behavior of markResourcesRead, the pure helper backing the
 * notifications panel "Clear all" action:
 *   - unions every id into readResourceIds in one transition
 *   - leaves unrelated state (resources, subscriptions) intact
 *   - an empty list is a no-op (returns state unchanged)
 *   - preserves already-read ids (additive union, never removes)
 *
 * These are the regressions that would fire if the batch helper were dropped
 * back to a single-id mutation or accidentally replaced (rather than unioned)
 * the read set.
 */

import { describe, it, expect } from 'vitest'
import {
  markResourcesRead,
  initialResourceState,
  type ResourceState,
} from '../slices/resource-slice'
import type { ResourceItem } from '@ion/shared/types-engine'

function makeState(overrides: Partial<ResourceState> = {}): ResourceState {
  return { ...initialResourceState, readResourceIds: new Set<string>(), ...overrides }
}

function makeItem(id: string): ResourceItem {
  return {
    id,
    kind: 'briefing',
    content: 'body',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('markResourcesRead', () => {
  it('unions all ids into readResourceIds', () => {
    const state = makeState()
    const next = markResourcesRead(state, ['a', 'b', 'c'])
    expect(next.readResourceIds.has('a')).toBe(true)
    expect(next.readResourceIds.has('b')).toBe(true)
    expect(next.readResourceIds.has('c')).toBe(true)
    expect(next.readResourceIds.size).toBe(3)
  })

  it('preserves already-read ids (additive, never removes)', () => {
    const state = makeState({ readResourceIds: new Set(['existing']) })
    const next = markResourcesRead(state, ['new-1', 'new-2'])
    expect(next.readResourceIds.has('existing')).toBe(true)
    expect(next.readResourceIds.has('new-1')).toBe(true)
    expect(next.readResourceIds.has('new-2')).toBe(true)
  })

  it('is a no-op for an empty list (returns the same state reference)', () => {
    const state = makeState({ readResourceIds: new Set(['x']) })
    const next = markResourcesRead(state, [])
    expect(next).toBe(state)
  })

  it('leaves resources and subscriptions untouched', () => {
    const items: ResourceItem[] = [makeItem('a'), makeItem('b')]
    const state = makeState({
      resources: { briefing: items },
      resourceSubscriptions: { briefing: 'sub-1' },
    })
    const next = markResourcesRead(state, ['a', 'b'])
    expect(next.resources).toBe(state.resources)
    expect(next.resourceSubscriptions).toBe(state.resourceSubscriptions)
  })

  it('does not mutate the input state read set', () => {
    const state = makeState({ readResourceIds: new Set(['x']) })
    markResourcesRead(state, ['y'])
    // Original set is unchanged — a new set is produced.
    expect(state.readResourceIds.has('y')).toBe(false)
    expect(state.readResourceIds.size).toBe(1)
  })
})
