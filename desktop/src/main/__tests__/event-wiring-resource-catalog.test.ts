import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturedHandler, broadcast, applyFullItem, handleResourceItemEvent } = vi.hoisted(() => ({
  capturedHandler: { fn: null as null | ((key: string, event: Record<string, unknown>) => void) },
  broadcast: vi.fn(),
  applyFullItem: vi.fn(),
  handleResourceItemEvent: vi.fn(),
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))
vi.mock('../state', () => ({
  state: { remoteTransport: null, mainWindow: null },
  sessionPlane: { on: vi.fn() },
  engineBridge: {
    on: vi.fn((event: string, handler: (key: string, value: Record<string, unknown>) => void) => {
      if (event === 'event') capturedHandler.fn = handler
    }),
  },
  extensionCommandRegistry: new Map(),
  forwardedEnginePermissionDenials: new Set(),
  lastForwardedTabMeta: new Map(),
}))
vi.mock('../broadcast', () => ({ broadcast }))
vi.mock('../resource-catalog', () => ({ resourceCatalog: { clear: vi.fn(), applySnapshot: vi.fn(), applyDelta: vi.fn(), applyFullItem } }))
vi.mock('../event-wiring-resources', () => ({
  subscribeToResourceKinds: vi.fn(() => Promise.resolve()),
  subscribeToGlobalResourceKinds: vi.fn(() => Promise.resolve()),
  clearResourceSubscriptions: vi.fn(),
  markReadPersisted: vi.fn(),
  resubscribeSessionResourceKinds: vi.fn(() => Promise.resolve()),
  handleResourceItemEvent,
}))
vi.mock('../event-wiring-intercept', () => ({ handleInterceptEvent: vi.fn() }))
vi.mock('../event-wiring-text-delta-batcher', () => ({ accumulateTextDelta: vi.fn(), flushKeyDeltas: vi.fn(), dropKeyDeltas: vi.fn() }))
vi.mock('../event-wiring-provider-login', () => ({ handleProviderLoginEvent: vi.fn(), handleProvidersUpdatedEvent: vi.fn() }))
vi.mock('../studio-window-manager', () => ({ notifyStudioPermissionResolved: vi.fn() }))
vi.mock('../settings-store', () => ({ shouldStreamThinkingToRemote: vi.fn(() => false) }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() }))
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))

import { wireEngineBridgeEvents } from '../event-wiring'

describe('event-wiring resource catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler.fn = null
    wireEngineBridgeEvents()
  })

  it('updates the catalog before forwarding a full resource item', () => {
    const item = { id: 'briefing-1', kind: 'briefing', producer: 'producer-a', content: 'full body', createdAt: '' }
    const order: string[] = []
    applyFullItem.mockImplementation(() => order.push('catalog'))
    handleResourceItemEvent.mockImplementation(() => order.push('renderer'))

    capturedHandler.fn?.('tab-1', {
      type: 'engine_resource_item',
      resourceKind: 'briefing',
      resourceItem: item,
    })

    expect(applyFullItem).toHaveBeenCalledWith('briefing', item)
    expect(handleResourceItemEvent).toHaveBeenCalledWith('tab-1', 'briefing', item)
    expect(order).toEqual(['catalog', 'renderer'])
  })
})
