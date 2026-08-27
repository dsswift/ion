/**
 * Resource subsystem event routing — normalized path (WI-001)
 *
 * After WI-001, resource and notification events flow through the normalized
 * stream (ion:normalized-event → handleNormalizedEvent → handleCrossNormalizedEvent)
 * instead of the raw IPC.ENGINE_EVENT path. handleCrossEngineEvent is dead
 * code with no production caller and has been deleted (QA finding on WI-001).
 *
 * This test re-points the original coverage at handleCrossNormalizedEvent —
 * the live path — using NormalizedEvent shapes. The underlying store mutations
 * (applyResourceSnapshot, applyResourceDelta) are identical; only the wrapper
 * function and event-type discriminators change.
 *
 * Original contracts pinned:
 *   - resource_snapshot global (tabId="") and session (tabId="tab1") scope
 *   - resource_delta create/update/delete/mark_read for both scopes
 *   - notification handled and does not throw
 *   - mixed snapshot: global items survive the NotificationsPanel filter
 *   - empty snapshot does NOT wipe disk-seeded items
 *   - partial snapshot merges with existing items when incoming count is smaller
 *   - snapshot with read=true items merges into readResourceIds
 *
 * NOTE: handleCrossNormalizedEvent uses bare tabId (not compound key).
 * For session-scope resources the caller passes the bare tabId; for global
 * resources it passes '' (empty string), same convention as the old path.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

import { handleCrossNormalizedEvent } from '../slices/engine-event-slice-messages'
import type { ResourceItem } from '../../../shared/types-engine'
import type { NormalizedEvent } from '../../../shared/types-events'

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

describe('resource_snapshot', () => {
  it('populates the store when tabId is "" (global scope)', () => {
    const { state, set } = makeResourceState()
    const item = makeItem({ id: 'g-1', kind: 'briefing' })

    const handled = handleCrossNormalizedEvent(set, () => state, '', {
      type: 'resource_snapshot',
      resourceKind: 'briefing',
      resourceSubId: 'sub-global',
      resourceItems: [item],
    } as NormalizedEvent)

    expect(handled).toBe(true)
    expect(state.resources['briefing']).toHaveLength(1)
    expect(state.resources['briefing'][0].id).toBe('g-1')
    expect(state.resourceSubscriptions['briefing']).toBe('sub-global')
  })

  it('populates the store when tabId is "tab1" (session scope)', () => {
    const { state, set } = makeResourceState()
    const item = makeItem({ id: 's-1', kind: 'briefing', conversationId: 'conv-abc' })

    const handled = handleCrossNormalizedEvent(set, () => state, 'tab1', {
      type: 'resource_snapshot',
      resourceKind: 'briefing',
      resourceSubId: 'sub-session',
      resourceItems: [item],
    } as NormalizedEvent)

    expect(handled).toBe(true)
    expect(state.resources['briefing']).toHaveLength(1)
    expect(state.resources['briefing'][0].conversationId).toBe('conv-abc')
    expect(state.resourceSubscriptions['briefing']).toBe('sub-session')
  })

  it('replaces the entire collection when incoming count equals or exceeds existing', () => {
    const { state, set } = makeResourceState()
    state.resources['briefing'] = [makeItem({ id: 'old-1' }), makeItem({ id: 'old-2' })]

    handleCrossNormalizedEvent(set, () => state, '', {
      type: 'resource_snapshot',
      resourceKind: 'briefing',
      resourceSubId: 'sub-replace',
      resourceItems: [makeItem({ id: 'new-1' }), makeItem({ id: 'new-2' })],
    } as NormalizedEvent)

    expect(state.resources['briefing']).toHaveLength(2)
    expect(state.resources['briefing'].map((i: ResourceItem) => i.id)).toEqual(['new-1', 'new-2'])
  })

  it('replaces the covered producer while retaining other producers', () => {
    const { state, set } = makeResourceState()
    state.resources['briefing'] = [
      makeItem({ id: 'old-1', producer: 'one' }),
      makeItem({ id: 'old-2', producer: 'one' }),
      makeItem({ id: 'other', producer: 'two' }),
    ]

    handleCrossNormalizedEvent(set, () => state, '', {
      type: 'resource_snapshot',
      resourceKind: 'briefing',
      resourceSubId: 'sub-partial',
      resourceItems: [makeItem({ id: 'old-2', producer: 'one', content: 'updated content' })],
      resourceProducers: ['one'],
    } as NormalizedEvent)

    expect(state.resources['briefing'].map((i: ResourceItem) => `${i.producer}:${i.id}`).sort())
      .toEqual(['one:old-2', 'two:other'])
    const updated = state.resources['briefing'].find((i: ResourceItem) => i.id === 'old-2')
    expect(updated?.content).toBe('updated content')
  })

  it('merges read=true items from snapshot into readResourceIds', () => {
    const { state, set } = makeResourceState()
    const readItem = makeItem({ id: 'already-read', read: true })
    const unreadItem = makeItem({ id: 'unread' })

    handleCrossNormalizedEvent(set, () => state, '', {
      type: 'resource_snapshot',
      resourceKind: 'briefing',
      resourceSubId: 'sub-read-merge',
      resourceItems: [readItem, unreadItem],
    } as NormalizedEvent)

    expect(state.readResourceIds.has('already-read')).toBe(true)
    expect(state.readResourceIds.has('unread')).toBe(false)
  })

  it('handles empty resourceItems without throwing', () => {
    const { state, set } = makeResourceState()
    expect(() => {
      handleCrossNormalizedEvent(set, () => state, '', {
        type: 'resource_snapshot',
        resourceKind: 'briefing',
        resourceSubId: 'sub-empty',
        resourceItems: [],
      } as NormalizedEvent)
    }).not.toThrow()
    expect(state.resources['briefing']).toHaveLength(0)
  })
})

// ── Delta tests ────────────────────────────────────────────────────────────

describe('resource_delta', () => {
  it('create delta with tabId="" adds item to the store (global path)', () => {
    const { state, set } = makeResourceState()

    const handled = handleCrossNormalizedEvent(set, () => state, '', {
      type: 'resource_delta',
      resourceKind: 'briefing',
      resourceDelta: {
        op: 'create',
        item: makeItem({ id: 'created-global' }),
      },
    } as NormalizedEvent)

    expect(handled).toBe(true)
    expect(state.resources['briefing']).toHaveLength(1)
    expect(state.resources['briefing'][0].id).toBe('created-global')
  })

  it('create delta with tabId="tab1" adds item to the store (session path)', () => {
    const { state, set } = makeResourceState()

    const handled = handleCrossNormalizedEvent(set, () => state, 'tab1', {
      type: 'resource_delta',
      resourceKind: 'briefing',
      resourceDelta: {
        op: 'create',
        item: makeItem({ id: 'created-session', conversationId: 'conv-xyz' }),
      },
    } as NormalizedEvent)

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

    handleCrossNormalizedEvent(set, () => state, '', {
      type: 'resource_delta',
      resourceKind: 'briefing',
      resourceDelta: {
        op: 'update',
        item: makeItem({ id: 'item-to-update', title: 'New Title' }),
      },
    } as NormalizedEvent)

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

    handleCrossNormalizedEvent(set, () => state, '', {
      type: 'resource_delta',
      resourceKind: 'briefing',
      resourceDelta: {
        op: 'delete',
        item: makeItem({ id: 'to-delete' }),
      },
    } as NormalizedEvent)

    expect(state.resources['briefing']).toHaveLength(1)
    expect(state.resources['briefing'][0].id).toBe('to-keep')
  })

  it('mark_read delta sets read=true on the item and adds to readResourceIds', () => {
    const { state, set } = makeResourceState()
    state.resources['briefing'] = [makeItem({ id: 'mark-me' })]

    handleCrossNormalizedEvent(set, () => state, '', {
      type: 'resource_delta',
      resourceKind: 'briefing',
      resourceDelta: {
        op: 'mark_read',
        item: makeItem({ id: 'mark-me' }),
      },
    } as NormalizedEvent)

    const item = state.resources['briefing'][0]
    expect(item.read).toBe(true)
    expect(state.readResourceIds.has('mark-me')).toBe(true)
  })

  it('does nothing when resourceDelta is absent', () => {
    const { state, set } = makeResourceState()

    // resource_delta always has resourceDelta in the NormalizedEvent type,
    // but guard against a malformed event at runtime.
    const handled = handleCrossNormalizedEvent(set, () => state, '', {
      type: 'resource_delta',
      resourceKind: 'briefing',
      resourceDelta: undefined as any,
    } as NormalizedEvent)

    expect(handled).toBe(true)
    expect(state.resources['briefing']).toBeUndefined()
  })
})

// ── Notification panel filter regression ──────────────────────────────────
//
// Pins the contract broken in d306b769 (global notifications empty bug).
//
// NotificationsPanel renders items filtered by !item.conversationId.
// A per-session snapshot may contain both global items (no conversationId)
// and conversation-scoped items (with conversationId). After the snapshot,
// the panel must show at least the global items.

describe('notification panel visibility — global items survive mixed snapshot', () => {
  it('global items (no conversationId) pass the panel filter after a mixed snapshot', () => {
    const { state, set } = makeResourceState()

    const globalItem = makeItem({ id: 'global-1', kind: 'briefing' }) // no conversationId
    const convItem = makeItem({ id: 'conv-1', kind: 'briefing', conversationId: 'conv-abc' })

    handleCrossNormalizedEvent(set, () => state, 'tab1', {
      type: 'resource_snapshot',
      resourceKind: 'briefing',
      resourceSubId: 'sub-mixed',
      resourceItems: [globalItem, convItem],
    } as NormalizedEvent)

    expect(state.resources['briefing']).toHaveLength(2)

    const panelItems = (state.resources['briefing'] as ResourceItem[]).filter(
      (item) => !item.conversationId,
    )
    expect(panelItems).toHaveLength(1)
    expect(panelItems[0].id).toBe('global-1')
  })

  it('an ambiguous legacy empty snapshot does not wipe existing items', () => {
    const { state, set } = makeResourceState()

    state.resources['briefing'] = [
      makeItem({ id: 'real-1' }),
      makeItem({ id: 'real-2' }),
    ]

    handleCrossNormalizedEvent(set, () => state, '', {
      type: 'resource_snapshot',
      resourceKind: 'briefing',
      resourceSubId: 'sub-direct-empty',
      resourceItems: [],
    } as NormalizedEvent)

    expect(state.resources['briefing']).toHaveLength(2)
    expect(state.resources['briefing'][0].id).toBe('real-1')
  })
})

describe('engine_notification', () => {
  it('is handled and returns true (global)', () => {
    const { state, set } = makeResourceState()
    expect(() => {
      const handled = handleCrossNormalizedEvent(set, () => state, '', {
        type: 'engine_notification',
        notificationTitle: 'New briefing ready',
        notificationBody: 'Your daily summary is available.',
        notificationLevel: 'info',
      } as NormalizedEvent)
      expect(handled).toBe(true)
    }).not.toThrow()
  })

  it('is handled and returns true (session)', () => {
    const { state, set } = makeResourceState()
    expect(() => {
      const handled = handleCrossNormalizedEvent(set, () => state, 'tab1', {
        type: 'engine_notification',
        notificationTitle: 'Session alert',
        notificationBody: 'Something happened.',
        notificationLevel: 'warning',
      } as NormalizedEvent)
      expect(handled).toBe(true)
    }).not.toThrow()
  })
})
