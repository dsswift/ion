/**
 * EngineControlPlane — session thinking-config resolution.
 *
 * `EngineConfig.thinking` is the per-session default the desktop hands the
 * engine at start_session. It sits between the engine-wide `engine.json`
 * default and the per-prompt `thinkingEffort`:
 *
 *   engine.json ← EngineConfig.thinking ← send_prompt.thinkingEffort
 *
 * The parameter existed for a long time with NO supplier — every one of the
 * nine ensureSession call sites either omitted it or forwarded a `config
 * .thinking` that nothing ever populated, so the session layer was dead.
 *
 * The fix resolves the value inside ensureSession rather than threading it
 * from callers, because three start paths (relocate, cwd-reconcile, eager
 * restore) legitimately have no thinking opinion to pass. Resolving at the
 * single start site is what makes them all correct by construction; these
 * tests pin that property rather than just the happy path.
 *
 * Revert proof: dropping the `?? resolveSessionThinkingConfig()` in
 * ensureSession fails the relocate-parity case.
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
  getSessionConfig: vi.fn(() => undefined),
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

// Mocked so the suite never reads the operator's real ~/.ion/settings.json —
// a test whose result depends on the developer's own preferences is not a test.
const mockThinking = { value: undefined as unknown }
vi.mock('../settings-store', () => ({
  readSettings: () => ({}),
  SETTINGS_DEFAULTS: { enableClaudeCompat: false },
  resolveSessionThinkingConfig: () => mockThinking.value,
}))

let uuidCounter = 0
vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto')
  return { ...actual, randomUUID: vi.fn(() => `tab-${String(++uuidCounter).padStart(3, '0')}`) }
})

import { EngineControlPlane } from '../engine-control-plane'
import { EngineBridge } from '../engine-bridge'

function startedConfig() {
  return mockBridge.startSession.mock.calls[0][1] as any
}

describe('EngineControlPlane — session thinking config', () => {
  let cp: EngineControlPlane

  beforeEach(() => {
    vi.clearAllMocks()
    uuidCounter = 0
    mockThinking.value = undefined
    mockBridge.startSession.mockResolvedValue({ ok: true })
    mockBridge.sendPrompt.mockResolvedValue({ ok: true })
    cp = new EngineControlPlane(new (EngineBridge as any)())
  })

  it('carries the resolved session default onto start_session', async () => {
    mockThinking.value = { enabled: true, effort: 'medium' }
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'c1' })
    expect(startedConfig().thinking).toEqual({ enabled: true, effort: 'medium' })
  })

  it('omits thinking when the setting resolves to no default', async () => {
    mockThinking.value = undefined
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'c1' })
    expect(startedConfig().thinking).toBeUndefined()
  })

  it('lets an explicit caller-supplied config win over the setting', async () => {
    mockThinking.value = { enabled: true, effort: 'low' }
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, {
      workingDirectory: '/w',
      conversationId: 'c1',
      thinking: { enabled: true, effort: 'high' },
    })
    expect(startedConfig().thinking).toEqual({ enabled: true, effort: 'high' })
  })

  // The property that motivated resolving inside ensureSession: a start path
  // that passes no thinking opinion must produce the SAME config as one that
  // does. Before the fix, relocate/cwd/eager-restore silently omitted it.
  it('a caller that omits thinking still gets the default (relocate/cwd parity)', async () => {
    mockThinking.value = { enabled: true, effort: 'medium' }

    const sendPathTab = cp.createTab()
    await cp.ensureSession(sendPathTab, {
      workingDirectory: '/w',
      conversationId: 'c1',
      thinking: undefined,
      model: 'm',
      maxTokens: 100,
    })
    const sendPathThinking = startedConfig().thinking

    vi.clearAllMocks()
    mockBridge.startSession.mockResolvedValue({ ok: true })

    // The relocate/cwd shape: workingDirectory + conversationId + mode only.
    const relocateTab = cp.createTab()
    await cp.ensureSession(relocateTab, {
      workingDirectory: '/w2',
      conversationId: 'c2',
      permissionMode: 'auto',
    })
    const relocateThinking = startedConfig().thinking

    expect(relocateThinking).toEqual(sendPathThinking)
    expect(relocateThinking).toEqual({ enabled: true, effort: 'medium' })
  })

  it('the prompt path start also carries the default', async () => {
    mockThinking.value = { enabled: true, effort: 'high' }
    const tabId = cp.createTab()
    await cp.submitPrompt(tabId, 'req-1', {
      prompt: 'hello',
      projectPath: '/Users/test/project',
    } as any)
    expect(mockBridge.startSession).toHaveBeenCalledOnce()
    expect(startedConfig().thinking).toEqual({ enabled: true, effort: 'high' })
  })
})
