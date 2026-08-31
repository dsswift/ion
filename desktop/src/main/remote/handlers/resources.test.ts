import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResourceItem } from '../../../shared/types-engine'
import type { RemoteCommand } from '../../remote/protocol'

const { sendToDevice, mockState, markDeletedPersisted, markReadPersisted, publishResourceMarkRead, publishResourceDelete } = vi.hoisted(() => {
  const sendToDevice = vi.fn()
  return {
    sendToDevice,
    markDeletedPersisted: vi.fn(),
    markReadPersisted: vi.fn(),
    publishResourceMarkRead: vi.fn(),
    publishResourceDelete: vi.fn(),
    mockState: { remoteTransport: null as null | { sendToDevice: (deviceId: string, event: unknown) => void }, mainWindow: null },
  }
})

vi.mock('../../state', () => ({ state: mockState }))
vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../event-wiring-resources', () => ({
  markDeletedPersisted,
  markReadPersisted,
  publishResourceMarkRead,
  publishResourceDelete,
}))

import { resourceCatalog } from '../../resource-catalog'
import { handleDeleteResource, handleMarkResourceRead, handleRequestResourceContent } from '../handlers/resources'

function fullItem(): ResourceItem {
  return {
    id: 'briefing-1',
    kind: 'briefing',
    producer: 'producer-a',
    content: 'full body',
    createdAt: '2026-01-01T00:00:00Z',
  }
}

describe('resource mutations from iOS', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState.mainWindow = null
    publishResourceMarkRead.mockResolvedValue(undefined)
    publishResourceDelete.mockResolvedValue(undefined)
  })

  it('persists and publishes producer-qualified read state through the engine', async () => {
    const command = {
      type: 'desktop_mark_resource_read',
      kind: 'briefing',
      resourceId: 'briefing-1',
      producer: 'producer-a',
    } as Extract<RemoteCommand, { type: 'desktop_mark_resource_read' }>

    await handleMarkResourceRead(command)

    expect(markReadPersisted).toHaveBeenCalledWith('briefing-1', 'producer-a', 'briefing')
    expect(publishResourceMarkRead).toHaveBeenCalledWith('briefing', 'briefing-1', 'producer-a')
  })

  it('does not bypass the shared event stream with a renderer-only mutation', async () => {
    const executeJavaScript = vi.fn()
    mockState.mainWindow = { webContents: { executeJavaScript } } as never
    const command = {
      type: 'desktop_mark_resource_read',
      kind: 'briefing',
      resourceId: 'briefing-1',
      producer: 'producer-a',
    } as Extract<RemoteCommand, { type: 'desktop_mark_resource_read' }>

    await handleMarkResourceRead(command)

    expect(executeJavaScript).not.toHaveBeenCalled()
  })

  it('propagates engine publish failures instead of reporting false synchronization', async () => {
    publishResourceMarkRead.mockRejectedValueOnce(new Error('invalid command'))
    const command = {
      type: 'desktop_mark_resource_read',
      kind: 'briefing',
      resourceId: 'briefing-1',
      producer: 'producer-a',
    } as Extract<RemoteCommand, { type: 'desktop_mark_resource_read' }>

    await expect(handleMarkResourceRead(command)).rejects.toThrow('invalid command')
  })

  it('publishes producer-qualified deletes through the engine', async () => {
    const command = {
      type: 'desktop_delete_resource',
      kind: 'briefing',
      resourceId: 'briefing-1',
      producer: 'producer-a',
    } as Extract<RemoteCommand, { type: 'desktop_delete_resource' }>

    await handleDeleteResource(command)

    expect(markDeletedPersisted).toHaveBeenCalledWith('briefing-1', 'producer-a', 'briefing')
    expect(publishResourceDelete).toHaveBeenCalledWith('briefing', 'briefing-1', 'producer-a')
  })
})

describe('handleRequestResourceContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resourceCatalog.clear()
    mockState.remoteTransport = { sendToDevice }
    mockState.mainWindow = null
    publishResourceMarkRead.mockResolvedValue(undefined)
    publishResourceDelete.mockResolvedValue(undefined)
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
