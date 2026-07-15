/**
 * Tests for engine-tab rewind plumbing:
 *   1. handleEngineRewind (remote/handlers/history.ts) threads the command's
 *      userTurnIndex into the injected rewindEngineInstance() call, and passes
 *      `null` when it is absent (desktop-initiated rewinds pass only the id).
 *   2. broadcastEngineHistory (remote/handlers/engine-history.ts) sends an
 *      engine_conversation_history to ALL devices via remoteTransport.send.
 *
 * These pin the two halves of the iOS-rewind fix: the desktop must accept the
 * ordinal (Fix B) and must push the truncated history after restart (Fix A).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  executeJsMock: vi.fn().mockResolvedValue(null),
  sendMock: vi.fn(),
}))

vi.mock('../../../state', () => ({
  state: {
    mainWindow: { webContents: { executeJavaScript: (...a: any[]) => mocks.executeJsMock(...a) } },
    remoteTransport: { send: (...a: any[]) => mocks.sendMock(...a) },
  },
}))

vi.mock('../../../logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

// history.ts statically imports ../revoke, whose chain
// (revoke -> settings-store -> utils/secretStore) evaluates
// `import { app, safeStorage } from 'electron'` at module-eval time.
// Loading electron throws in CI ("Electron failed to install correctly")
// because the Electron binary is not downloaded for the unit-test job.
// Mock electron so the chain resolves without the real binary — the same
// pattern every other main-process suite that reaches electron uses.
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn() },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() },
}))

vi.mock('../revoke', () => ({ revokeDeviceLocally: vi.fn() }))

import { handleEngineRewind } from '../history'
import { broadcastEngineHistory } from '../engine-history'

beforeEach(() => {
  mocks.executeJsMock.mockReset().mockResolvedValue(null)
  mocks.sendMock.mockReset()
})

describe('handleEngineRewind — userTurnIndex pass-through', () => {
  it('threads a numeric userTurnIndex into the injected rewindEngineInstance call', async () => {
    await handleEngineRewind({
      type: 'desktop_engine_rewind',
      tabId: 'tab-abc',
      instanceId: 'inst-xyz',
      messageId: 'UUID-1',
      userTurnIndex: 2,
    })
    expect(mocks.executeJsMock).toHaveBeenCalledTimes(1)
    const jsBody = mocks.executeJsMock.mock.calls[0][0] as string
    expect(jsBody).toContain("rewindEngineInstance('tab-abc', 'inst-xyz', 'UUID-1', 2)")
  })

  it('passes null for userTurnIndex when the command omits it (desktop-initiated)', async () => {
    await handleEngineRewind({
      type: 'desktop_engine_rewind',
      tabId: 'tab-abc',
      instanceId: 'inst-xyz',
      messageId: 'real-id',
    })
    const jsBody = mocks.executeJsMock.mock.calls[0][0] as string
    expect(jsBody).toContain("rewindEngineInstance('tab-abc', 'inst-xyz', 'real-id', null)")
  })

  it('escapes single quotes and backslashes in ids', async () => {
    await handleEngineRewind({
      type: 'desktop_engine_rewind',
      tabId: "tab'x",
      instanceId: "inst\\y",
      messageId: "m'z",
      userTurnIndex: 0,
    })
    const jsBody = mocks.executeJsMock.mock.calls[0][0] as string
    expect(jsBody).toContain("rewindEngineInstance('tab\\'x', 'inst\\\\y', 'm\\'z', 0)")
  })
})

describe('broadcastEngineHistory', () => {
  it('broadcasts a unified desktop_conversation_history to all devices (WI-004)', async () => {
    // WI-004 / #259: broadcastEngineHistory now uses the unified
    // desktop_conversation_history response type — the same type
    // handleLoadConversation sends. instanceId is no longer included
    // (not part of the desktop_conversation_history shape).
    mocks.executeJsMock.mockResolvedValueOnce({
      resolvedId: 'main',
      messages: [{ id: 'u-0', role: 'user', content: 'hi', timestamp: 1 }],
    })
    await broadcastEngineHistory('tab-1', 'main')
    expect(mocks.sendMock).toHaveBeenCalledTimes(1)
    const event = mocks.sendMock.mock.calls[0][0]
    expect(event.type).toBe('desktop_conversation_history')
    expect(event.tabId).toBe('tab-1')
    expect(event.hasMore).toBe(false)
    expect(event.messages).toEqual([{ id: 'u-0', role: 'user', content: 'hi', timestamp: 1 }])
    // desktop_engine_conversation_history must not be sent (retired string).
    expect(event.type).not.toBe('desktop_engine_conversation_history')
  })
})

import { readEngineHistoryFromStore } from '../engine-history'

describe('readEngineHistoryFromStore — bare-key (post-#256)', () => {
  it('returns main instance messages for a bare tabId (no instanceId suffix)', async () => {
    // Simulate the renderer store: pane has activeInstanceId='main', one instance
    // with two messages.
    const fakeMessages = [
      { id: 'u-1', role: 'user', content: 'hello', timestamp: 100 },
      { id: 'a-1', role: 'assistant', content: 'world', timestamp: 101 },
    ]
    mocks.executeJsMock.mockResolvedValueOnce({
      resolvedId: 'main',
      messages: fakeMessages,
    })

    const result = await readEngineHistoryFromStore('tab-bare', null)

    expect(result.instanceId).toBe('main')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0].id).toBe('u-1')
    expect(result.messages[1].id).toBe('a-1')
  })

  it('returns empty messages and null instanceId when store has no pane', async () => {
    // Renderer returns null/undefined when store or pane is absent.
    mocks.executeJsMock.mockResolvedValueOnce(null)

    const result = await readEngineHistoryFromStore('tab-missing', null)

    expect(result.instanceId).toBeNull()
    expect(result.messages).toEqual([])
  })
})

describe('readEngineHistoryFromStore — attachment projection (#224)', () => {
  // The attachment carry-through lives inside the executeJavaScript body
  // string, which the mocked webContents never runs. Pin the real projection
  // by evaluating the generated body against a fake renderer store: an image
  // attachment on a message must survive to the wire, mapped to the
  // RemoteAttachment shape (id/type/name/path) iOS decodes.
  function runMapperBody(jsBody: string, store: unknown): { resolvedId: string | null; messages: any[] } {
    const g = globalThis as any
    const prevWindow = g.window
    g.window = { __Ion_SESSION_STORE__: store }
    try {
      // The body is a self-invoking IIFE that returns { resolvedId, messages }.
      // eslint-disable-next-line no-eval
      return eval(jsBody)
    } finally {
      g.window = prevWindow
    }
  }

  it('carries image attachments through to the wire in RemoteAttachment shape', async () => {
    // executeJavaScript is mocked; capture the body it was called with, then
    // run that exact body against a fake store so the real mapper executes.
    mocks.executeJsMock.mockResolvedValueOnce(null)
    await readEngineHistoryFromStore('tab-att', null)
    const jsBody = mocks.executeJsMock.mock.calls[0][0] as string

    const store = {
      getState: () => ({
        conversationPanes: new Map([
          ['tab-att', {
            activeInstanceId: 'main',
            instances: [{
              id: 'main',
              messages: [{
                id: 'a-1', role: 'assistant', content: 'see image', timestamp: 5,
                attachments: [
                  // Extra renderer-only fields (mimeType/dataUrl) must be
                  // dropped; only id/type/name/path reach the wire.
                  { id: 'img-1', type: 'image', name: 'shot.png', path: '/tmp/shot.png', mimeType: 'image/png', dataUrl: 'data:...' },
                ],
              }],
            }],
          }],
        ]),
      }),
    }

    const out = runMapperBody(jsBody, store)
    expect(out.resolvedId).toBe('main')
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0].attachments).toEqual([
      { id: 'img-1', type: 'image', name: 'shot.png', path: '/tmp/shot.png' },
    ])
  })

  it('omits attachments when the message has none', async () => {
    mocks.executeJsMock.mockResolvedValueOnce(null)
    await readEngineHistoryFromStore('tab-noatt', null)
    const jsBody = mocks.executeJsMock.mock.calls[0][0] as string

    const store = {
      getState: () => ({
        conversationPanes: new Map([
          ['tab-noatt', {
            activeInstanceId: 'main',
            instances: [{
              id: 'main',
              messages: [{ id: 'u-1', role: 'user', content: 'hi', timestamp: 1 }],
            }],
          }],
        ]),
      }),
    }

    const out = runMapperBody(jsBody, store)
    expect(out.messages[0]).not.toHaveProperty('attachments')
  })
})
