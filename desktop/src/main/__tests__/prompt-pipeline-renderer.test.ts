/**
 * Regression test: insertRendererRemoteUserMessage must echo the user turn
 * to the Studio mirror window via notifyStudioUserMessageEcho.
 *
 * Root cause (WI-004): when an iOS-originated slash command succeeds as an
 * extension command (commandError === ''), insertRendererRemoteUserMessage is
 * called to insert the user bubble into the owner renderer via executeJavaScript.
 * That path never called notifyStudioUserMessageEcho, so the Studio mirror showed
 * assistant text with no preceding user bubble.
 *
 * Fix: insertRendererRemoteUserMessage calls notifyStudioUserMessageEcho
 * unconditionally after the executeJavaScript insert. The call is outside the
 * try/catch so it fires even if executeJavaScript throws.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  executeJsMock: vi.fn().mockResolvedValue(null),
  notifyStudioMock: vi.fn(),
}))

vi.mock('../state', () => ({
  state: {
    mainWindow: { webContents: { executeJavaScript: (...args: any[]) => mocks.executeJsMock(...args) } },
    remoteTransport: null,
  },
  sessionPlane: {} as any,
  engineBridge: {} as any,
  extensionCommandRegistry: new Map(),
}))

vi.mock('../studio-window-manager', () => ({
  notifyStudioUserMessageEcho: (...args: any[]) => mocks.notifyStudioMock(...args),
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

import { insertRendererRemoteUserMessage } from '../prompt-pipeline-renderer'
import type { IncomingPrompt } from '../prompt-pipeline'

function makePrompt(tabId = 'tab-studio-1'): IncomingPrompt {
  return {
    tabId,
    text: '/mycommand args',
    reqId: 'req-1',
    source: 'remote',
    hasExtensions: false,
    attachments: [],
  }
}

beforeEach(() => {
  mocks.executeJsMock.mockReset().mockResolvedValue(null)
  mocks.notifyStudioMock.mockReset()
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('insertRendererRemoteUserMessage — Studio echo', () => {
  it('calls notifyStudioUserMessageEcho with typed payload after insert', async () => {
    const p = makePrompt()
    await insertRendererRemoteUserMessage(p, '/mycommand args')

    expect(mocks.notifyStudioMock).toHaveBeenCalledTimes(1)
    expect(mocks.notifyStudioMock).toHaveBeenCalledWith('tab-studio-1', {
      id: 'req-1',
      content: '/mycommand args',
      timestamp: 1_700_000_000_000,
    })
  })

  it('calls notifyStudioUserMessageEcho even when executeJavaScript throws', async () => {
    mocks.executeJsMock.mockRejectedValueOnce(new Error('renderer not ready'))

    const p = makePrompt('tab-studio-err')
    await insertRendererRemoteUserMessage(p, '/failcommand')

    // The echo must still fire — it is outside the try/catch.
    expect(mocks.notifyStudioMock).toHaveBeenCalledTimes(1)
    expect(mocks.notifyStudioMock).toHaveBeenCalledWith('tab-studio-err', {
      id: 'req-1',
      content: '/failcommand',
      timestamp: 1_700_000_000_000,
    })
  })

  it('passes the raw content string — not a slash-stripped or partially-escaped variant', async () => {
    const p = makePrompt()
    const content = "/complex args with 'quotes'"
    await insertRendererRemoteUserMessage(p, content)

    expect(mocks.notifyStudioMock).toHaveBeenCalledWith(p.tabId, {
      id: p.reqId,
      content,
      timestamp: 1_700_000_000_000,
    })
  })

  it('fires for both plain and extension-hosted tab sources', async () => {
    const plain = { ...makePrompt('plain-tab'), hasExtensions: false }
    const ext = { ...makePrompt('ext-tab'), hasExtensions: true, instanceId: 'inst-1' }

    await insertRendererRemoteUserMessage(plain, '/cmd1')
    await insertRendererRemoteUserMessage(ext, '/cmd2')

    expect(mocks.notifyStudioMock).toHaveBeenCalledTimes(2)
    expect(mocks.notifyStudioMock).toHaveBeenNthCalledWith(1, 'plain-tab', {
      id: plain.reqId,
      content: '/cmd1',
      timestamp: 1_700_000_000_000,
    })
    expect(mocks.notifyStudioMock).toHaveBeenNthCalledWith(2, 'ext-tab', {
      id: ext.reqId,
      content: '/cmd2',
      timestamp: 1_700_000_000_000,
    })
  })
})
