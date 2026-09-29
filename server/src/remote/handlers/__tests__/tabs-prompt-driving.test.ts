/**
 * FR-02 presence: `submitClientPrompt` marks the tab as driven by whichever
 * principal the submitting caller is attributed to. Without this, a
 * remotely-originated prompt never sets `driving` and the "someone else is
 * running a turn" indicators never fire for a remote client.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  nativeImage: { createFromPath: vi.fn(), createFromBuffer: vi.fn() },
}))

const testMocks = vi.hoisted(() => ({
  processIncomingPrompt: vi.fn(async () => {}),
  setDriving: vi.fn(),
}))

const sendMock = vi.fn()
const executeJsMock = vi.fn(async () => null)

vi.mock('../../../state', () => ({
  state: {
    get mainWindow() { return { webContents: { executeJavaScript: executeJsMock } } },
    get remoteTransport() { return { send: sendMock, sendToDevice: vi.fn() } },
  },
  sessionPlane: { cancelTab: vi.fn() },
  engineBridge: {},
}))
vi.mock('../../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() }))
vi.mock('../../../engine/prompt-pipeline', () => ({ processIncomingPrompt: testMocks.processIncomingPrompt }))
vi.mock('../../../engine-bridge', () => ({ IS_REMOTE: false }))
vi.mock('./engine', () => ({ getVoiceSystemPrompt: vi.fn(() => undefined) }))
vi.mock('../../../engine-control-plane-interrupt', () => ({ performUnifiedInterrupt: vi.fn() }))
vi.mock('../../../protocol/presence', () => ({ setDriving: testMocks.setDriving }))

import { submitClientPrompt } from '../tabs-prompt'

beforeEach(() => {
  sendMock.mockClear()
  testMocks.processIncomingPrompt.mockClear()
  testMocks.setDriving.mockClear()
  executeJsMock.mockReset()
  executeJsMock.mockResolvedValue(null)
})

describe('submitClientPrompt marks driving from the submitting caller', () => {
  it('CLI branch: marks driving using the caller\'s attributed principal', async () => {
    await submitClientPrompt({ tabId: 'tab-1', text: 'hello', clientMsgId: 'm1' } as any, { kind: 'caller', clientId: 'c1', principalSubject: 'oidc:alice' })

    expect(testMocks.setDriving).toHaveBeenCalledWith('tab-1', 'oidc:alice')
  })

  it('engine branch: marks driving using the caller\'s attributed principal', async () => {
    await submitClientPrompt({ tabId: 'tab-2', text: 'hi', clientMsgId: 'm2', instanceId: 'main' } as any, { kind: 'caller', clientId: 'c1', principalSubject: 'oidc:bob' })

    expect(testMocks.setDriving).toHaveBeenCalledWith('tab-2', 'oidc:bob')
  })

  it('never marks driving for a caller with no attributed principal (no partitioning configured)', async () => {
    await submitClientPrompt({ tabId: 'tab-3', text: 'hello', clientMsgId: 'm3' } as any, { kind: 'caller', clientId: 'c1' })

    expect(testMocks.setDriving).not.toHaveBeenCalled()
  })
})
