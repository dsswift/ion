/**
 * handlePrompt — desktop_prompt_result delivery.
 *
 * Verifies that iOS receives a `desktop_prompt_result` event with the correct
 * clientMsgId, status, and tabId on early-rejection paths (no mainWindow,
 * failed engine instance creation). The accepted path is tested indirectly
 * through session.ts IPC, which resolves after processIncomingPrompt and
 * calls sendToDevice from there; early rejections are tested here because
 * they fire inside handlePrompt itself.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  nativeImage: { createFromPath: vi.fn(), createFromBuffer: vi.fn() },
}))

const sentToDevice: Array<{ deviceId: string; event: any }> = []
const sendToDeviceMock = vi.fn((deviceId: string, event: any) => {
  sentToDevice.push({ deviceId, event })
})

let mockMainWindow: any = null

vi.mock('../../../state', () => ({
  state: {
    get mainWindow() { return mockMainWindow },
    get remoteTransport() {
      return { send: vi.fn(), sendToDevice: sendToDeviceMock }
    },
  },
  sessionPlane: { cancelTab: vi.fn() },
  engineBridge: {},
}))
vi.mock('../../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() }))
vi.mock('../../../prompt-pipeline', () => ({ processIncomingPrompt: vi.fn(async () => {}) }))
vi.mock('../../attachment-encoder', () => ({
  encodeAttachments: vi.fn((text: string) => ({ encoded: [], rewrittenText: text })),
}))
vi.mock('../../../engine-bridge', () => ({ IS_REMOTE: false }))
vi.mock('./engine', () => ({ getVoiceSystemPrompt: vi.fn(() => undefined) }))
vi.mock('../../../engine-control-plane-interrupt', () => ({ performUnifiedInterrupt: vi.fn() }))
vi.mock('../../prompt-delivery', () => ({ registerRemotePromptDelivery: vi.fn() }))

import { handlePrompt } from '../tabs-prompt'

beforeEach(() => {
  sentToDevice.length = 0
  sendToDeviceMock.mockClear()
  mockMainWindow = null
})

describe('desktop_prompt_result delivery', () => {
  it('sends rejected result when mainWindow is absent (engine path)', async () => {
    mockMainWindow = null
    await handlePrompt({
      type: 'desktop_prompt',
      tabId: 'tab-1',
      text: 'hello',
      clientMsgId: 'msg-123',
      instanceId: 'inst-1',
    } as any, 'ios-device-1')

    expect(sentToDevice).toHaveLength(1)
    const { deviceId, event } = sentToDevice[0]
    expect(deviceId).toBe('ios-device-1')
    expect(event.type).toBe('desktop_prompt_result')
    expect(event.tabId).toBe('tab-1')
    expect(event.clientMsgId).toBe('msg-123')
    expect(event.status).toBe('rejected')
    expect(event.error).toBe('no main window')
  })

  it('does not send prompt result when clientMsgId is absent', async () => {
    mockMainWindow = null
    await handlePrompt({
      type: 'desktop_prompt',
      tabId: 'tab-1',
      text: 'hello',
      instanceId: 'inst-1',
    } as any, 'ios-device-1')

    expect(sentToDevice).toHaveLength(0)
  })

  it('sends rejected result when engine instance creation fails', async () => {
    const executeJsMock = vi.fn()
    executeJsMock.mockResolvedValueOnce(null) // activeInstanceId lookup
    executeJsMock.mockResolvedValueOnce(null) // addEngineInstance returns null
    mockMainWindow = { webContents: { executeJavaScript: executeJsMock } }

    await handlePrompt({
      type: 'desktop_prompt',
      tabId: 'tab-2',
      text: 'engine prompt',
      clientMsgId: 'msg-456',
      instanceId: '',
    } as any, 'ios-device-2')

    const result = sentToDevice.find(
      (s) => s.event.type === 'desktop_prompt_result',
    )
    expect(result).toBeDefined()
    expect(result!.deviceId).toBe('ios-device-2')
    expect(result!.event.clientMsgId).toBe('msg-456')
    expect(result!.event.status).toBe('rejected')
    expect(result!.event.error).toBe('failed to create engine instance')
  })

  it('preserves clientMsgId correlation between prompt and result', async () => {
    mockMainWindow = null
    const clientMsgId = 'correlation-test-uuid'
    await handlePrompt({
      type: 'desktop_prompt',
      tabId: 'tab-x',
      text: 'test',
      clientMsgId,
      instanceId: 'inst-1',
    } as any, 'device-abc')

    const result = sentToDevice[0]
    expect(result.event.clientMsgId).toBe(clientMsgId)
  })
})
