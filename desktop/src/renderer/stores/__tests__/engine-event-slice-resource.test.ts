/**
 * engine-event-slice — resource subsystem event routing
 *
 * Pins the contract that engine_resource_snapshot and engine_resource_delta
 * are handled for BOTH global (key="") and session-scoped (key="tab:inst")
 * events. The earlier bug: both types were in handleMessageEvents, which is
 * only reached after the `if (!key.includes(':')) return` guard. Global
 * resources arrived with key="" and were silently dropped.
 *
 * Tests:
 *   - engine_resource_snapshot with key="" updates the store (global path)
 *   - engine_resource_snapshot with key="tab:inst" updates the store (session path)
 *   - engine_resource_delta create with key="" updates the store (global path)
 *   - engine_resource_delta create with key="tab:inst" updates the store (session path)
 *   - engine_resource_delta update mutates the correct item
 *   - engine_resource_delta delete removes the correct item
 *   - engine_resource_delta mark_read adds item id to readResourceIds
 *   - applyResourceSnapshot merges read=true items into readResourceIds
 *   - engine_notification with key="" is handled (does not throw, returns)
 *   - engine_notification with key="tab:inst" is handled (does not throw, returns)
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

import { handleCrossEngineEvent } from '../slices/engine-event-slice-messages'
import type { ResourceItem } from '../../../shared/types-engine'

// ── Minimal state shape required by the resource handlers ──────────────────

function makeResourceState() {
  const state: any = {
    resources: {} as Record<string, ResourceItem[]>,
    resourceSubscriptions: {} as Record<string, string>,
    readResourceIds: new Set<string>(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  return { state, set }
}

function makeItem(overrides: Partial<ResourceItem> = {}): ResourceItem {
  return {
    id: 'item-1',
    kind: 'briefing',
    content: 'Hello world',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

// ── Snapshot tests ─────────────────────────────────────────────────────────

describe('engine_resource_snapshot', () => {
  it('populates the store when key is "" (global scope)', () => {
    const { state, set } = makeResourceState()
    const item = makeItem({ id: 'g-1', kind: 'briefing' })

    const handled = handleCrossEngineEvent(set, () => state, '', {
      type: 'engine_resource_snapshot',
      resourceKind: 'briefing',
      resourceSubId: 'sub-global',
      resourceItems: [item],
    })

    expect(handled).toBe(true)
    expect(state.resources['briefing']).toHaveLength(1)
    expect(state.resources['briefing'][0].id).toBe('g-1')
    expect(state.resourceSubscriptions['briefing']).toBe('sub-global')
  })

  it('populates the store when key is "tab1:inst1" (session scope)', () => {
    const { state, set } = makeResourceState()
    const item = makeItem({ id: 's-1', kind: 'briefing', conversationId: 'conv-abc' })

    const handled = handleCrossEngineEvent(set, () => state, 'tab1:inst1', {
      type: 'engine_resource_snapshot',
      resourceKind: 'briefing',
      resourceSubId: 'sub-session',
      resourceItems: [item],
    })

    expect(handled).toBe(true)
    expect(state.resources['briefing']).toHaveLength(1)
    expect(state.resources['briefing'][0].conversationId).toBe('conv-abc')
    expect(state.resourceSubscriptions['briefing']).toBe('sub-session')
  })

  it('replaces the entire collection (snapshot semantics)', () => {
    const { state, set } = makeResourceState()
    // Prime with two items.
    state.resources['briefing'] = [makeItem({ id: 'old-1' }), makeItem({ id: 'old-2' })]

    handleCrossEngineEvent(set, () => state, '', {
      type: 'engine_resource_snapshot',
      resourceKind: 'briefing',
      resourceSubId: 'sub-replace',
      resourceItems: [makeItem({ id: 'new-1' })],
    })

    expect(state.resources['briefing']).toHaveLength(1)
    expect(state.resources['briefing'][0].id).toBe('new-1')
  })

  it('merges read=true items from snapshot into readResourceIds', () => {
    const { state, set } = makeResourceState()
    const readItem = makeItem({ id: 'already-read', read: true })
    const unreadItem = makeItem({ id: 'unread' })

    handleCrossEngineEvent(set, () => state, '', {
      type: 'engine_resource_snapshot',
      resourceKind: 'briefing',
      resourceSubId: 'sub-read-merge',
      resourceItems: [readItem, unreadItem],
    })

    expect(state.readResourceIds.has('already-read')).toBe(true)
    expect(state.readResourceIds.has('unread')).toBe(false)
  })

  it('handles empty resourceItems without throwing', () => {
    const { state, set } = makeResourceState()
    expect(() => {
      handleCrossEngineEvent(set, () => state, '', {
        type: 'engine_resource_snapshot',
        resourceKind: 'briefing',
        resourceSubId: 'sub-empty',
        resourceItems: [],
      })
    }).not.toThrow()
    expect(state.resources['briefing']).toHaveLength(0)
  })
})

// ── Delta tests ────────────────────────────────────────────────────────────

describe('engine_resource_delta', () => {
  it('create delta with key="" adds item to the store (global path)', () => {
    const { state, set } = makeResourceState()

    const handled = handleCrossEngineEvent(set, () => state, '', {
      type: 'engine_resource_delta',
      resourceKind: 'briefing',
      resourceSubId: 'sub-delta-global',
      resourceDelta: {
        op: 'create',
        item: makeItem({ id: 'created-global' }),
      },
    })

    expect(handled).toBe(true)
    expect(state.resources['briefing']).toHaveLength(1)
    expect(state.resources['briefing'][0].id).toBe('created-global')
  })

  it('create delta with key="tab1:inst1" adds item to the store (session path)', () => {
    const { state, set } = makeResourceState()

    const handled = handleCrossEngineEvent(set, () => state, 'tab1:inst1', {
      type: 'engine_resource_delta',
      resourceKind: 'briefing',
      resourceSubId: 'sub-delta-session',
      resourceDelta: {
        op: 'create',
        item: makeItem({ id: 'created-session', conversationId: 'conv-xyz' }),
      },
    })

    expect(handled).toBe(true)
    expect(state.resources['briefing']).toHaveLength(1)
    expect(state.resources['briefing'][0].conversationId).toBe('conv-xyz')
  })

  it('update delta mutates the matching item in-place', () => {
    const { state, set } = makeResourceState()
    state.resources['briefing'] = [
      makeItem({ id: 'item-to-update', title: 'Old Title' }),
      makeItem({ id: 'untouched' }),
    ]

    handleCrossEngineEvent(set, () => state, '', {
      type: 'engine_resource_delta',
      resourceKind: 'briefing',
      resourceSubId: 'sub-update',
      resourceDelta: {
        op: 'update',
        item: makeItem({ id: 'item-to-update', title: 'New Title' }),
      },
    })

    const updated = state.resources['briefing'].find((i: ResourceItem) => i.id === 'item-to-update')
    expect(updated?.title).toBe('New Title')
    const untouched = state.resources['briefing'].find((i: ResourceItem) => i.id === 'untouched')
    expect(untouched?.id).toBe('untouched')
  })

  it('delete delta removes the matching item', () => {
    const { state, set } = makeResourceState()
    state.resources['briefing'] = [
      makeItem({ id: 'to-delete' }),
      makeItem({ id: 'to-keep' }),
    ]

    handleCrossEngineEvent(set, () => state, '', {
      type: 'engine_resource_delta',
      resourceKind: 'briefing',
      resourceSubId: 'sub-delete',
      resourceDelta: {
        op: 'delete',
        item: makeItem({ id: 'to-delete' }),
      },
    })

    expect(state.resources['briefing']).toHaveLength(1)
    expect(state.resources['briefing'][0].id).toBe('to-keep')
  })

  it('mark_read delta sets read=true on the item and adds to readResourceIds', () => {
    const { state, set } = makeResourceState()
    state.resources['briefing'] = [makeItem({ id: 'mark-me' })]

    handleCrossEngineEvent(set, () => state, '', {
      type: 'engine_resource_delta',
      resourceKind: 'briefing',
      resourceSubId: 'sub-mark-read',
      resourceDelta: {
        op: 'mark_read',
        item: makeItem({ id: 'mark-me' }),
      },
    })

    const item = state.resources['briefing'][0]
    expect(item.read).toBe(true)
    expect(state.readResourceIds.has('mark-me')).toBe(true)
  })

  it('does nothing when resourceDelta is absent', () => {
    const { state, set } = makeResourceState()

    const handled = handleCrossEngineEvent(set, () => state, '', {
      type: 'engine_resource_delta',
      resourceKind: 'briefing',
      resourceSubId: 'sub-no-delta',
      // no resourceDelta field
    })

    // Still handled (returns true) but store is unchanged.
    expect(handled).toBe(true)
    expect(state.resources['briefing']).toBeUndefined()
  })
})

// ── Notification tests ─────────────────────────────────────────────────────

describe('engine_notification', () => {
  it('is handled and returns true when key is "" (global)', () => {
    const { state, set } = makeResourceState()
    expect(() => {
      const handled = handleCrossEngineEvent(set, () => state, '', {
        type: 'engine_notification',
        push: true,
        notifyKind: 'briefing',
        notifyTitle: 'New briefing ready',
        notifyBody: 'Your daily summary is available.',
      })
      expect(handled).toBe(true)
    }).not.toThrow()
  })

  it('is handled and returns true when key is "tab1:inst1" (session)', () => {
    const { state, set } = makeResourceState()
    expect(() => {
      const handled = handleCrossEngineEvent(set, () => state, 'tab1:inst1', {
        type: 'engine_notification',
        push: false,
        notifyKind: 'briefing',
        notifyTitle: 'Session alert',
        notifyBody: 'Something happened in this session.',
      })
      expect(handled).toBe(true)
    }).not.toThrow()
  })
})
