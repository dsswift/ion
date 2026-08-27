import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResourceItem } from '../../../shared/types-engine'
import type { RemoteCommand } from '../../remote/protocol'

const { sendToDevice, mockState } = vi.hoisted(() => {
  const sendToDevice = vi.fn()
  return {
    sendToDevice,
    mockState: { remoteTransport: null as null | { sendToDevice: (deviceId: string, event: unknown) => void }, mainWindow: null },
  }
})

vi.mock('../../state', () => ({ state: mockState }))
vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../event-wiring-resources', () => ({
  markReadPersisted: vi.fn(),
  publishResourceMarkRead: vi.fn(),
  publishResourceDelete: vi.fn(),
}))

import { resourceCatalog } from '../../resource-catalog'
import { handleRequestResourceContent } from '../handlers/resources'

function fullItem(): ResourceItem {
  return {
    id: 'briefing-1',
    kind: 'briefing',
    producer: 'producer-a',
    content: 'full body',
    createdAt: '2026-01-01T00:00:00Z',
  }
}

describe('handleRequestResourceContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resourceCatalog.clear()
    mockState.remoteTransport = { sendToDevice }
  })

  it('returns full content from the main-process catalog', async () => {
    resourceCatalog.applyFullItem('briefing', fullItem())
    const command = {
      type: 'desktop_request_resource_content',
      kind: 'briefing',
      resourceId: 'briefing-1',
      producer: 'producer-a',
    } as Extract<RemoteCommand, { type: 'desktop_request_resource_content' }>

    await handleRequestResourceContent(command, 'device-1')

    expect(sendToDevice).toHaveBeenCalledWith('device-1', {
      type: 'desktop_resource_content',
      resourceId: 'briefing-1',
      kind: 'briefing',
      producer: 'producer-a',
      content: 'full body',
    })
  })
})
