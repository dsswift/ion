/**
 * EngineControlPlane.ensureSession — eager durable session start
 *
 * Split out of engine-control-plane.test.ts to keep that file under the
 * 600-line cap. Covers the unified single-start-site behavior: ensureSession
 * starts a session injecting the conversationId, is idempotent, is the only
 * start site (a prompt after an eager start does not re-start), and surfaces
 * start failures as non-ok results.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

const mockBridge = {
  startSession: vi.fn().mockResolvedValue({ ok: true }),
  sendPrompt: vi.fn().mockResolvedValue({ ok: true }),
  sendAbort: vi.fn(),
  sendDialogResponse: vi.fn(),
  sendCommand: vi.fn(),
  sendPermissionResponse: vi.fn(),
  sendSetPlanMode: vi.fn(),
  updateSessionConversationId: vi.fn(),
  stopByPrefix: vi.fn(),
  stopSession: vi.fn(),
  stopAll: vi.fn(),
  on: vi.fn(),
  emit: vi.fn(),
  removeListener: vi.fn(),
  removeAllListeners: vi.fn(),
}

vi.mock('../engine-bridge', () => ({
  EngineBridge: function () { return mockBridge },
}))

vi.mock('../engine-bridge-fs', () => ({
  engineIsRemote: vi.fn(() => false),
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: false, error: 'not used' })),
  listEngineDirectory: vi.fn(() => Promise.resolve({ ok: false, error: 'not used' })),
}))

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

let uuidCounter = 0
vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto')
  return { ...actual, randomUUID: vi.fn(() => `tab-${String(++uuidCounter).padStart(3, '0')}`) }
})

import { EngineControlPlane } from '../engine-control-plane'
import { EngineBridge } from '../engine-bridge'

function makeRunOptions(overrides: Record<string, any> = {}): any {
  return { prompt: 'hello', projectPath: '/Users/test/project', sessionId: undefined, model: undefined, ...overrides }
}

describe('EngineControlPlane.ensureSession', () => {
  let cp: EngineControlPlane

  beforeEach(() => {
    vi.clearAllMocks()
    uuidCounter = 0
    mockBridge.startSession.mockResolvedValue({ ok: true })
    mockBridge.sendPrompt.mockResolvedValue({ ok: true })
    cp = new EngineControlPlane(new (EngineBridge as any)())
  })

  it('starts the session injecting the conversationId as sessionId', async () => {
    const tabId = cp.createTab()
    const res = await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'conv-abc' })
    expect(res.ok).toBe(true)
    expect(mockBridge.startSession).toHaveBeenCalledOnce()
    expect(mockBridge.startSession).toHaveBeenCalledWith(
      tabId,
      expect.objectContaining({ sessionId: 'conv-abc', workingDirectory: '/w' }),
    )
  })

  it('is idempotent — a second call does not start again', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'conv-abc' })
    await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'conv-abc' })
    expect(mockBridge.startSession).toHaveBeenCalledOnce()
  })

  it('is the single start site — a prompt after an eager start does NOT re-start', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'conv-xyz' })
    expect(mockBridge.startSession).toHaveBeenCalledOnce()
    await cp.submitPrompt(tabId, 'req-1', makeRunOptions({ prompt: 'hi' }))
    expect(mockBridge.startSession).toHaveBeenCalledOnce()
    expect(mockBridge.sendPrompt).toHaveBeenCalledOnce()
  })

  it('surfaces a start failure as a non-ok result without throwing', async () => {
    mockBridge.startSession.mockResolvedValue({ ok: false, error: 'boom' })
    const tabId = cp.createTab()
    const res = await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'c' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('boom')
  })
})
