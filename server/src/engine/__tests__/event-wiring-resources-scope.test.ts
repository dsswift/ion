/**
 * A conversation's resource subscription must forward only that conversation's
 * items. Workspace items ride the workspace subscription (key ""), once for the
 * whole Environment. Forwarding them per conversation sent every client one
 * full copy of every briefing per open conversation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../state', () => ({ engineBridge: { request: vi.fn(), activeSessions: new Map() } }))
vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../resource-catalog', () => ({
  resourceCatalog: { applySnapshot: vi.fn(), applyDelta: vi.fn(), applyFullItem: vi.fn() },
}))
vi.mock('../chart-restore', () => ({ restoreConversationCharts: vi.fn() }))
vi.mock('../composer-actions-wiring', () => ({ composerActionsBoard: { applySnapshot: vi.fn(), applyDelta: vi.fn() } }))
vi.mock('../event-wiring-resource-state', () => ({
  isResourceRead: () => false,
  markReadPersisted: vi.fn(),
  isResourceDeleted: () => false,
  markDeletedPersisted: vi.fn(),
  filterDeletedResources: <T>(items: T[]) => items,
  projectPersistedResourceState: <T>(items: T[]) => items,
}))

import { handleResourceEngineEvent } from '../event-wiring-resources'

const briefing = { id: 'b1', kind: 'briefing', title: 'Workspace briefing', content: 'x'.repeat(1000) }
const report = { id: 'r1', kind: 'report', title: 'Owned report', conversationId: 'conv-1' }

describe('resource scope on a conversation subscription', () => {
  const forwarded = vi.fn()
  beforeEach(() => forwarded.mockReset())

  it('drops workspace items from a conversation snapshot and keeps its own', () => {
    handleResourceEngineEvent('tab-1', { type: 'engine_resource_snapshot', resourceKind: 'briefing', resourceSubId: 'sub-1', resourceItems: [briefing, report] }, forwarded)
    expect(forwarded).toHaveBeenCalledOnce()
    expect(forwarded.mock.calls[0][1].resourceItems).toEqual([report])
  })

  it('forwards workspace items on the workspace subscription', () => {
    handleResourceEngineEvent('', { type: 'engine_resource_snapshot', resourceKind: 'briefing', resourceSubId: 'sub-2', resourceItems: [briefing] }, forwarded)
    expect(forwarded.mock.calls[0][1].resourceItems).toEqual([briefing])
  })

  it('does not forward a workspace delta that arrived on a conversation subscription', () => {
    handleResourceEngineEvent('tab-1', { type: 'engine_resource_delta', resourceKind: 'briefing', resourceDelta: { op: 'create', item: briefing } }, forwarded)
    expect(forwarded).not.toHaveBeenCalled()
    handleResourceEngineEvent('', { type: 'engine_resource_delta', resourceKind: 'briefing', resourceDelta: { op: 'create', item: briefing } }, forwarded)
    expect(forwarded).toHaveBeenCalledOnce()
  })
})
