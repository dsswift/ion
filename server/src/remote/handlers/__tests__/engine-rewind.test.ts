/**
 * Tests for engine-tab rewind plumbing:
 *   1. rewindConversationInstance (remote/handlers/history.ts) threads its
 *      userTurnIndex into the store's rewindEngineInstance() action, awaits
 *      its transactional {ok,error?} result, and only sends the
 *      input-prefill wire message when the engine confirmed success.
 *   2. readEngineHistoryFromStore (remote/handlers/engine-history.ts) reads
 *      the truncated list the Studio mirror's history replace carries.
 *
 * These pin the rewind fix (the server must accept the ordinal) plus the
 * transactional-rewind fix (a rejected engine branch must never send a
 * prefill). A thin client receives the truncation as a transcript patch.
 *
 * Migration note: this handler used to reach the renderer via
 * `executeJavaScript` (a renderer round trip returning `{ ok, error?,
 * inputText }`, with ids interpolated — and therefore escaped — into a JS
 * string). The store now runs in-process with this handler, so
 * `rewindEngineInstance` is called directly as a function, `pendingInput`
 * for the prefill is read off `store.getState().tabs`, and there is no
 * string injection to escape. Similarly, `readEngineHistoryFromStore` no
 * longer builds an `executeJavaScript` body string to eval in the renderer —
 * it reads `conversationPanes` directly. See `remote/handlers/history.ts`
 * and `remote/handlers/engine-history.ts`.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  sendMock: vi.fn(),
  rewindEngineInstanceMock: vi.fn(),
  tabs: [] as Array<{ id: string; pendingInput?: string }>,
  conversationPanes: new Map<string, any>(),
}))

vi.mock('../../../state', () => ({
  state: {
  },
}))

vi.mock('../../../store/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      rewindEngineInstance: (...a: any[]) => mocks.rewindEngineInstanceMock(...a),
      tabs: mocks.tabs,
      conversationPanes: mocks.conversationPanes,
    }),
  },
}))

vi.mock('../../../thin-view/remote-out', () => ({ sendRemoteEvent: (...a: any[]) => mocks.sendMock(...a), remoteClientsPresent: () => true }))
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

import { rewindConversationInstance } from '../history'
import { readEngineHistoryFromStore } from '../engine-history'

beforeEach(() => {
  mocks.sendMock.mockReset()
  mocks.rewindEngineInstanceMock.mockReset()
  mocks.tabs = []
  mocks.conversationPanes = new Map()
})

describe('rewindConversationInstance — userTurnIndex pass-through and transactional gate', () => {
  it('threads a numeric userTurnIndex into the store rewindEngineInstance call', async () => {
    mocks.rewindEngineInstanceMock.mockResolvedValueOnce({ ok: true })
    await rewindConversationInstance('tab-abc', 'inst-xyz', 'UUID-1', 2)
    expect(mocks.rewindEngineInstanceMock).toHaveBeenCalledTimes(1)
    expect(mocks.rewindEngineInstanceMock).toHaveBeenCalledWith('tab-abc', 'inst-xyz', 'UUID-1', 2)
  })

  it('passes null for userTurnIndex when the command omits it (desktop-initiated)', async () => {
    mocks.rewindEngineInstanceMock.mockResolvedValueOnce({ ok: true })
    await rewindConversationInstance('tab-abc', 'inst-xyz', 'real-id', null)
    expect(mocks.rewindEngineInstanceMock).toHaveBeenCalledWith('tab-abc', 'inst-xyz', 'real-id', null)
  })

  it('passes ids through unmodified (in-process call, no string injection to escape)', async () => {
    mocks.rewindEngineInstanceMock.mockResolvedValueOnce({ ok: true })
    await rewindConversationInstance("tab'x", 'inst\\y', "m'z", 0)
    expect(mocks.rewindEngineInstanceMock).toHaveBeenCalledWith("tab'x", 'inst\\y', "m'z", 0)
  })

  it('answers the rewound turn as pendingInput when the engine rewind succeeds', async () => {
    mocks.rewindEngineInstanceMock.mockResolvedValueOnce({ ok: true })
    mocks.tabs = [{ id: 'tab-abc', pendingInput: 'previous prompt' }]
    const res = await rewindConversationInstance('tab-abc', 'inst-xyz', 'real-id', 1)
    expect(res).toEqual({ ok: true, pendingInput: 'previous prompt' })
  })

  it('answers the refusal with its reason and no draft — the transcript never advances on a refusal', async () => {
    mocks.rewindEngineInstanceMock.mockResolvedValueOnce({ ok: false, error: 'entry is not a user turn on the current path' })
    const res = await rewindConversationInstance('tab-abc', 'inst-xyz', 'real-id', 1)
    expect(res).toEqual({ ok: false, error: 'entry is not a user turn on the current path' })
    expect(res.pendingInput).toBeUndefined()
  })

  it('answers a generic error when the store resolves without an error message', async () => {
    mocks.rewindEngineInstanceMock.mockResolvedValueOnce({ ok: false })
    const res = await rewindConversationInstance('tab-abc', 'inst-xyz', 'real-id', 1)
    expect(res).toEqual({ ok: false, error: 'unknown' })
  })

  it('propagates a throw rather than reporting a rewind that never happened', async () => {
    mocks.rewindEngineInstanceMock.mockRejectedValueOnce(new Error('store crashed'))
    await expect(rewindConversationInstance('tab-abc', 'inst-xyz', 'real-id', 1)).rejects.toThrow('store crashed')
  })
})

describe('readEngineHistoryFromStore — bare-key (post-#256)', () => {
  it('returns main instance messages for a bare tabId (no instanceId suffix)', async () => {
    const fakeMessages = [
      { id: 'u-1', role: 'user', content: 'hello', timestamp: 100 },
      { id: 'a-1', role: 'assistant', content: 'world', timestamp: 101 },
    ]
    mocks.conversationPanes.set('tab-bare', {
      activeInstanceId: 'main',
      instances: [{ id: 'main', messages: fakeMessages }],
    })

    const result = await readEngineHistoryFromStore('tab-bare', null)

    expect(result.instanceId).toBe('main')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0].id).toBe('u-1')
    expect(result.messages[1].id).toBe('a-1')
  })

  it('returns empty messages and null instanceId when store has no pane', async () => {
    const result = await readEngineHistoryFromStore('tab-missing', null)

    expect(result.instanceId).toBeNull()
    expect(result.messages).toEqual([])
  })
})

describe('readEngineHistoryFromStore — attachment projection (#224)', () => {
  it('carries image attachments through to the wire in RemoteAttachment shape', async () => {
    mocks.conversationPanes.set('tab-att', {
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
    })

    const out = await readEngineHistoryFromStore('tab-att', null)
    expect(out.instanceId).toBe('main')
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0].attachments).toEqual([
      { id: 'img-1', type: 'image', name: 'shot.png', path: '/tmp/shot.png' },
    ])
  })

  it('omits attachments when the message has none', async () => {
    mocks.conversationPanes.set('tab-noatt', {
      activeInstanceId: 'main',
      instances: [{ id: 'main', messages: [{ id: 'u-1', role: 'user', content: 'hi', timestamp: 1 }] }],
    })

    const out = await readEngineHistoryFromStore('tab-noatt', null)
    expect(out.messages[0]).not.toHaveProperty('attachments')
  })
})
