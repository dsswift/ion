import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, listeners, broadcastMock, logMock, stateMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  broadcastMock: vi.fn(),
  logMock: vi.fn(),
  stateMock: {
    mainWindow: { isDestroyed: () => false, webContents: { id: 7 } },
    studioWindow: null,
  },
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => listeners.set(channel, handler)),
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
  },
}))
vi.mock('../../broadcast', () => ({ broadcast: broadcastMock }))
vi.mock('../../logger', () => ({ log: logMock }))
vi.mock('../../state', () => ({ state: stateMock }))

import { IPC } from '../../../shared/types'
import { registerStudioConversationTerminalSyncIpc, resetStudioConversationTerminalSyncForTests } from '../studio-terminal-sync'

registerStudioConversationTerminalSyncIpc()

const valid = {
  panes: [{
    tabId: 'tab-a',
    instances: [{ id: 'service-1', label: 'API', kind: 'user', readOnly: false, cwd: '/repo/api' }],
    activeInstanceId: 'service-1',
  }],
  openTabIds: ['tab-a'],
}

describe('Studio Conversation Terminal Panel IPC sync', () => {
  beforeEach(() => {
    resetStudioConversationTerminalSyncForTests()
    broadcastMock.mockClear()
    logMock.mockClear()
  })

  it('accepts owner snapshots, assigns revisions, caches, and broadcasts them', () => {
    listeners.get(IPC.STUDIO_PUBLISH_CONVERSATION_TERMINALS)!({ sender: { id: 7 } }, valid)

    expect(broadcastMock).toHaveBeenCalledWith(
      IPC.STUDIO_CONVERSATION_TERMINALS,
      expect.objectContaining({ ...valid, revision: 1 }),
    )
    expect(handlers.get(IPC.STUDIO_GET_CONVERSATION_TERMINALS)!({})).toEqual({ ...valid, revision: 1 })
  })

  it('rejects non-owner and malformed snapshots without replacing valid cache', () => {
    const publish = listeners.get(IPC.STUDIO_PUBLISH_CONVERSATION_TERMINALS)!
    publish({ sender: { id: 7 } }, valid)
    publish({ sender: { id: 8 } }, { panes: [], openTabIds: [] })
    publish({ sender: { id: 7 } }, { panes: 'bad', openTabIds: [] })

    expect(broadcastMock).toHaveBeenCalledTimes(1)
    expect(handlers.get(IPC.STUDIO_GET_CONVERSATION_TERMINALS)!({})).toEqual({ ...valid, revision: 1 })
  })
})
