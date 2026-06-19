/**
 * Regression test for the IPC.PROMPT handler in `ipc/session.ts`.
 *
 * Bug: when iOS sends a non-slash CLI prompt, the main process broadcasts
 * REMOTE_USER_MESSAGE so the renderer can insert the optimistic bubble. The
 * renderer's submitRemotePrompt then calls window.ion.prompt with
 * `source: 'remote'` and a freshly minted requestId. Before this fix the
 * IPC.PROMPT handler forwarded `options.source` straight into the unified
 * pipeline, which made the pipeline re-broadcast REMOTE_USER_MESSAGE and
 * never call sessionPlane.submitPrompt — the tab sat in `connecting` until
 * the renderer watchdog reaped it 240s later.
 *
 * IPC.PROMPT is the sink for the remote→broadcast→renderer→IPC roundtrip,
 * so its `source` to the pipeline must always be 'desktop'. `options.source`
 * is preserved for the message_added echo-skip logic at the top of the
 * handler so iOS is not double-echoed.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler)
    },
    on: (channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler)
    },
  },
}))

const mocks = vi.hoisted(() => ({
  processIncomingPrompt: vi.fn(),
  remoteSend: vi.fn(),
  hasTab: vi.fn().mockReturnValue(true),
  ensureTab: vi.fn(),
}))

vi.mock('../state', () => ({
  state: {
    remoteTransport: { send: mocks.remoteSend },
    mainWindow: null,
  },
  sessionPlane: {
    hasTab: mocks.hasTab,
    ensureTab: mocks.ensureTab,
    initSession: vi.fn(),
    resetTabSession: vi.fn(),
    cancel: vi.fn(),
    cancelTab: vi.fn(),
    steerSession: vi.fn(),
    retry: vi.fn(),
    getHealth: vi.fn(),
    closeTab: vi.fn(),
  },
  engineBridge: { stopByPrefix: vi.fn() },
  activeAssistantMessages: { delete: vi.fn() },
  DEBUG_MODE: false,
}))

vi.mock('../terminal-manager-instance', () => ({
  terminalManager: { destroyByPrefix: vi.fn() },
}))

vi.mock('../remote/snapshot', () => ({
  getRemoteTabStates: vi.fn(),
}))

vi.mock('../settings-store', () => ({
  readSettings: () => ({ enableClaudeCompat: true }),
  SETTINGS_DEFAULTS: { enableClaudeCompat: true },
}))

vi.mock('../broadcast', () => ({
  broadcast: vi.fn(),
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
}))

vi.mock('../prompt-pipeline', () => ({
  processIncomingPrompt: (...args: any[]) => mocks.processIncomingPrompt(...args),
}))

import { registerSessionIpc } from '../ipc/session'

beforeEach(() => {
  handlers.clear()
  mocks.processIncomingPrompt.mockReset().mockResolvedValue(undefined)
  mocks.remoteSend.mockReset()
  mocks.hasTab.mockReset().mockReturnValue(true)
  mocks.ensureTab.mockReset()
  registerSessionIpc()
})

describe('IPC.PROMPT handler', () => {
  it('passes source=desktop to the pipeline even when options.source=remote (sink behaviour)', async () => {
    const handler = handlers.get('ion:prompt')
    expect(handler).toBeDefined()
    await handler!(null, {
      tabId: 'tab-1',
      requestId: 'req-1',
      options: { prompt: 'hello from ios', projectPath: '/proj', source: 'remote' },
    })
    expect(mocks.processIncomingPrompt).toHaveBeenCalledTimes(1)
    expect(mocks.processIncomingPrompt).toHaveBeenCalledWith(expect.objectContaining({
      tabId: 'tab-1',
      reqId: 'req-1',
      source: 'desktop',
      isEngineTab: false,
    }))
  })

  it('passes source=desktop when options.source is undefined (desktop-typed prompt)', async () => {
    const handler = handlers.get('ion:prompt')
    await handler!(null, {
      tabId: 'tab-2',
      requestId: 'req-2',
      options: { prompt: 'typed in desktop', projectPath: '/proj' },
    })
    expect(mocks.processIncomingPrompt).toHaveBeenCalledWith(expect.objectContaining({
      tabId: 'tab-2',
      source: 'desktop',
    }))
  })

  it('skips the message_added echo to iOS when options.source=remote', async () => {
    const handler = handlers.get('ion:prompt')
    await handler!(null, {
      tabId: 'tab-3',
      requestId: 'req-3',
      options: { prompt: 'from ios', source: 'remote' },
    })
    expect(mocks.remoteSend).not.toHaveBeenCalled()
  })

  it('echoes message_added to iOS when options.source is undefined (desktop-typed)', async () => {
    const handler = handlers.get('ion:prompt')
    await handler!(null, {
      tabId: 'tab-4',
      requestId: 'req-4',
      options: { prompt: 'typed in desktop' },
    })
    expect(mocks.remoteSend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'desktop_message_added',
      tabId: 'tab-4',
      message: expect.objectContaining({ id: 'req-4', role: 'user', content: 'typed in desktop' }),
    }))
  })
})
