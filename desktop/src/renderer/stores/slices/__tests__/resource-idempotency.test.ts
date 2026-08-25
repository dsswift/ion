/**
 * resource-idempotency — duplicate-ID idempotency behavior tests.
 *
 * Pins:
 *   - applyResourceSnapshot deduplicates items by ID (last occurrence wins).
 *   - applyResourceDelta create op upserts when an item with the same ID
 *     already exists (in-place update, no duplicate append).
 *   - create op appends normally when no duplicate exists.
 *   - existing ops (update, delete, mark_read) are unaffected.
 */

import { describe, it, expect } from 'vitest'
import {
  applyResourceSnapshot,
  applyResourceDelta,
  initialResourceState,
  type ResourceState,
} from '../resource-slice'
import type { ResourceItem, ResourceDelta } from '../../../../shared/types-engine'
import { resourceIdentity } from '../../../../shared/resource-identity'

function makeItem(id: string, content = 'body', read = false): ResourceItem {
  return { id, kind: 'briefing', content, createdAt: '2026-01-01T00:00:00Z', read }
}

function stateWithItems(kind: string, items: ResourceItem[]): ResourceState {
  return { ...initialResourceState, resources: { [kind]: items } }
}

describe('applyResourceSnapshot — ID normalization', () => {
  it('deduplicates items with the same ID, last occurrence wins', () => {
    const items = [
      makeItem('a', 'old-a'),
      makeItem('b', 'b-content'),
      makeItem('a', 'new-a'),
    ]
    const result = applyResourceSnapshot(initialResourceState, 'briefing', 'sub-1', items)
    const briefings = result.resources['briefing']
    expect(briefings).toHaveLength(2)
    const aItem = briefings.find((i) => i.id === 'a')
    expect(aItem?.content).toBe('new-a')
  })

  it('preserves order after dedup (earlier non-dup items keep position)', () => {
    const items = [
      makeItem('x', 'x1'),
      makeItem('y', 'y1'),
      makeItem('x', 'x2'),
    ]
    const result = applyResourceSnapshot(initialResourceState, 'briefing', 'sub-1', items)
    const ids = result.resources['briefing'].map((i) => i.id)
    expect(ids).toEqual(['y', 'x'])
  })

  it('no-ops on items with unique IDs', () => {
    const items = [makeItem('a'), makeItem('b'), makeItem('c')]
    const result = applyResourceSnapshot(initialResourceState, 'briefing', 'sub-1', items)
    expect(result.resources['briefing']).toHaveLength(3)
  })

  it('uses final duplicate read state', () => {
    const result = applyResourceSnapshot(initialResourceState, 'briefing', 'sub-1', [
      makeItem('a', 'stale-read', true),
      makeItem('a', 'final-unread', false),
    ])
    expect(result.resources.briefing).toEqual([makeItem('a', 'final-unread', false)])
    expect(result.readResourceIds.has('a')).toBe(false)
  })

  it('keeps read state separate when kinds share an ID', () => {
    const state = applyResourceDelta(initialResourceState, 'briefing', {
      op: 'mark_read', item: { ...makeItem('shared'), producer: 'alpha' },
    })
    const result = applyResourceSnapshot(state, 'alert', 'sub-1', [
      { ...makeItem('shared'), kind: 'alert', producer: 'beta', read: false },
    ])

    expect(result.readResourceIds.has(resourceIdentity({ id: 'shared', producer: 'alpha', kind: 'briefing' }))).toBe(true)
    expect(result.readResourceIds.has(resourceIdentity({ id: 'shared', producer: 'beta', kind: 'alert' }))).toBe(false)
  })

  it('migrates a legacy raw-ID read key to every producer sharing that ID', () => {
    const result = applyResourceSnapshot(
      { ...initialResourceState, readResourceIds: new Set(['same']) },
      'briefing',
      'sub-1',
      [
        { ...makeItem('same'), producer: 'alpha' },
        { ...makeItem('same'), producer: 'beta' },
      ],
    )
    expect(result.readResourceIds).toEqual(new Set(['8:briefing:5:alpha:same', '8:briefing:4:beta:same']))
  })

  it('deduplicates during partial-snapshot merge', () => {
    const existing = stateWithItems('briefing', [
      makeItem('a', 'disk-a'),
      makeItem('b', 'disk-b'),
      makeItem('c', 'disk-c'),
    ])
    // Partial snapshot (fewer items than existing) with a dup in the union
    const incoming = [makeItem('a', 'fresh-a')]
    const result = applyResourceSnapshot(existing, 'briefing', 'sub-1', incoming)
    const briefings = result.resources['briefing']
    const aItems = briefings.filter((i) => i.id === 'a')
    expect(aItems).toHaveLength(1)
    expect(aItems[0].content).toBe('fresh-a')
  })
})

describe('applyResourceSnapshot — producer identity', () => {
  it('keeps same-ID items from different producers', () => {
    const result = applyResourceSnapshot(initialResourceState, 'briefing', 'sub-1', [
      { ...makeItem('shared', 'from-a'), producer: 'extension-a' },
      { ...makeItem('shared', 'from-b'), producer: 'extension-b' },
    ])
    expect(result.resources.briefing).toHaveLength(2)
    expect(result.resources.briefing.map((item) => item.content)).toEqual(['from-a', 'from-b'])
  })

  it('updates only the matching producer identity', () => {
    const state = stateWithItems('briefing', [
      { ...makeItem('shared', 'from-a'), producer: 'extension-a' },
      { ...makeItem('shared', 'from-b'), producer: 'extension-b' },
    ])
    const result = applyResourceDelta(state, 'briefing', {
      op: 'update',
      item: { ...makeItem('shared', 'updated-a'), producer: 'extension-a' },
    })
    expect(result.resources.briefing.map((item) => item.content)).toEqual(['updated-a', 'from-b'])
  })
})


describe('applyResourceDelta create — upsert semantics', () => {
  it('appends when no item with the same ID exists', () => {
    const state = stateWithItems('briefing', [makeItem('a')])
    const delta: ResourceDelta = { op: 'create', item: makeItem('b', 'new') }
    const result = applyResourceDelta(state, 'briefing', delta)
    expect(result.resources['briefing']).toHaveLength(2)
    expect(result.resources['briefing'][1].id).toBe('b')
  })

  it('upserts in place when item with the same ID already exists', () => {
    const state = stateWithItems('briefing', [makeItem('a'), makeItem('b', 'old-b')])
    const delta: ResourceDelta = { op: 'create', item: makeItem('b', 'new-b') }
    const result = applyResourceDelta(state, 'briefing', delta)
    expect(result.resources['briefing']).toHaveLength(2)
    const bItem = result.resources['briefing'].find((i) => i.id === 'b')
    expect(bItem?.content).toBe('new-b')
  })

  it('upsert preserves position of existing item', () => {
    const state = stateWithItems('briefing', [
      makeItem('a'),
      makeItem('b', 'old'),
      makeItem('c'),
    ])
    const delta: ResourceDelta = { op: 'create', item: makeItem('b', 'updated') }
    const result = applyResourceDelta(state, 'briefing', delta)
    const ids = result.resources['briefing'].map((i) => i.id)
    expect(ids).toEqual(['a', 'b', 'c'])
  })
})

describe('applyResourceDelta — existing ops unchanged', () => {
  it('update replaces matching item', () => {
    const state = stateWithItems('briefing', [makeItem('a', 'old')])
    const delta: ResourceDelta = { op: 'update', item: makeItem('a', 'new') }
    const result = applyResourceDelta(state, 'briefing', delta)
    expect(result.resources['briefing'][0].content).toBe('new')
  })

  it('delete removes matching item', () => {
    const state = stateWithItems('briefing', [makeItem('a'), makeItem('b')])
    const delta: ResourceDelta = { op: 'delete', item: makeItem('a') }
    const result = applyResourceDelta(state, 'briefing', delta)
    expect(result.resources['briefing']).toHaveLength(1)
    expect(result.resources['briefing'][0].id).toBe('b')
  })

  it('mark_read sets read state', () => {
    const state = stateWithItems('briefing', [makeItem('a')])
    const delta: ResourceDelta = { op: 'mark_read', item: makeItem('a') }
    const result = applyResourceDelta(state, 'briefing', delta)
    expect(result.readResourceIds.has('a')).toBe(true)
    expect(result.resources['briefing'][0].read).toBe(true)
  })
})
