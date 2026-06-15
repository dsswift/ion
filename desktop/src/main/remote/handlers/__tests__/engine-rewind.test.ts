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
      type: 'engine_rewind',
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
      type: 'engine_rewind',
      tabId: 'tab-abc',
      instanceId: 'inst-xyz',
      messageId: 'real-id',
    })
    const jsBody = mocks.executeJsMock.mock.calls[0][0] as string
    expect(jsBody).toContain("rewindEngineInstance('tab-abc', 'inst-xyz', 'real-id', null)")
  })

  it('escapes single quotes and backslashes in ids', async () => {
    await handleEngineRewind({
      type: 'engine_rewind',
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
  it('broadcasts an engine_conversation_history to all devices', async () => {
    // instanceId is supplied, so readEngineHistoryFromStore skips the
    // compound-key resolution and calls executeJavaScript once (for messages).
    mocks.executeJsMock.mockResolvedValueOnce([{ id: 'u-0', role: 'user', content: 'hi', timestamp: 1 }])
    await broadcastEngineHistory('tab-1', 'inst-1')
    expect(mocks.sendMock).toHaveBeenCalledTimes(1)
    const event = mocks.sendMock.mock.calls[0][0]
    expect(event.type).toBe('engine_conversation_history')
    expect(event.tabId).toBe('tab-1')
    expect(event.instanceId).toBe('inst-1')
    expect(event.messages).toEqual([{ id: 'u-0', role: 'user', content: 'hi', timestamp: 1 }])
  })
})
