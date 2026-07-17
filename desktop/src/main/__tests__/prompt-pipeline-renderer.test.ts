/**
 * Regression test: insertRendererRemoteUserMessage must echo the user turn
 * to the ATV mirror window via notifyAtvUserMessageEcho.
 *
 * Root cause (WI-004): when an iOS-originated slash command succeeds as an
 * extension command (commandError === ''), insertRendererRemoteUserMessage is
 * called to insert the user bubble into the owner renderer via executeJavaScript.
 * That path never called notifyAtvUserMessageEcho, so the ATV mirror showed
 * assistant text with no preceding user bubble.
 *
 * Fix: insertRendererRemoteUserMessage calls notifyAtvUserMessageEcho
 * unconditionally after the executeJavaScript insert. The call is outside the
 * try/catch so it fires even if executeJavaScript throws.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  executeJsMock: vi.fn().mockResolvedValue(null),
  notifyAtvMock: vi.fn(),
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

vi.mock('../atv-window-manager', () => ({
  notifyAtvUserMessageEcho: (...args: any[]) => mocks.notifyAtvMock(...args),
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

import { insertRendererRemoteUserMessage } from '../prompt-pipeline-renderer'
import type { IncomingPrompt } from '../prompt-pipeline'

function makePrompt(tabId = 'tab-atv-1'): IncomingPrompt {
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
  mocks.notifyAtvMock.mockReset()
})

describe('insertRendererRemoteUserMessage — ATV echo', () => {
  it('calls notifyAtvUserMessageEcho with tabId and content after insert', async () => {
    const p = makePrompt()
    await insertRendererRemoteUserMessage(p, '/mycommand args')

    expect(mocks.notifyAtvMock).toHaveBeenCalledTimes(1)
    expect(mocks.notifyAtvMock).toHaveBeenCalledWith('tab-atv-1', '/mycommand args')
  })

  it('calls notifyAtvUserMessageEcho even when executeJavaScript throws', async () => {
    mocks.executeJsMock.mockRejectedValueOnce(new Error('renderer not ready'))

    const p = makePrompt('tab-atv-err')
    await insertRendererRemoteUserMessage(p, '/failcommand')

    // The echo must still fire — it is outside the try/catch.
    expect(mocks.notifyAtvMock).toHaveBeenCalledTimes(1)
    expect(mocks.notifyAtvMock).toHaveBeenCalledWith('tab-atv-err', '/failcommand')
  })

  it('passes the raw content string — not a slash-stripped or partially-escaped variant', async () => {
    const p = makePrompt()
    const content = "/complex args with 'quotes'"
    await insertRendererRemoteUserMessage(p, content)

    expect(mocks.notifyAtvMock).toHaveBeenCalledWith(p.tabId, content)
  })

  it('fires for both plain and extension-hosted tab sources', async () => {
    const plain = { ...makePrompt('plain-tab'), hasExtensions: false }
    const ext = { ...makePrompt('ext-tab'), hasExtensions: true, instanceId: 'inst-1' }

    await insertRendererRemoteUserMessage(plain, '/cmd1')
    await insertRendererRemoteUserMessage(ext, '/cmd2')

    expect(mocks.notifyAtvMock).toHaveBeenCalledTimes(2)
    expect(mocks.notifyAtvMock).toHaveBeenNthCalledWith(1, 'plain-tab', '/cmd1')
    expect(mocks.notifyAtvMock).toHaveBeenNthCalledWith(2, 'ext-tab', '/cmd2')
  })
})
