/**
 * Convergence tests for the prompt pipeline.
 *
 * Verifies that all four prompt paths (Desktop CLI, iOS CLI, Desktop Engine,
 * iOS Engine) produce equivalent behavior for plan-mode-sensitive operations:
 *   - planFilePath is forwarded to the engine bridge / broadcast
 *   - implementationPhase is forwarded to the engine bridge / broadcast
 *   - prose constants (ENTER_PLAN_MODE_DESCRIPTION, PLAN_MODE_SPARSE_REMINDER)
 *     are forwarded to the engine bridge on desktop engine prompts
 *
 * Uses the same vi.hoisted() + vi.mock('../state') pattern as
 * prompt-pipeline.test.ts. Split into a companion file to keep both
 * under the 600-line cap.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ───────────────────────────────────────────────────────────────────────────
// Mocks — same pattern as prompt-pipeline.test.ts.
// ───────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const bridgeListeners = new Map<string, Array<(key: string, event: any) => void>>()
  const sendCommandMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const sendPromptMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.({ ok: true }) ?? function () { return Promise.resolve({ ok: true }) }
  const submitPromptMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(undefined) ?? function () { return Promise.resolve() }
  const setPermissionModeMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const remoteSendMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const executeJsMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(null) ?? function () { return Promise.resolve(null) }
  const broadcastMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const clearConversationFileMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(undefined) ?? function () { return Promise.resolve() }
  const getTabStatusMock = (globalThis as any).vi?.fn?.()?.mockReturnValue?.({ conversationId: null }) ?? function () { return { conversationId: null } }
  return {
    bridgeListeners,
    sendCommandMock,
    sendPromptMock,
    submitPromptMock,
    setPermissionModeMock,
    remoteSendMock,
    executeJsMock,
    broadcastMock,
    clearConversationFileMock,
    getTabStatusMock,
  }
})

// Rebuild as real vi.fn() values now that vi is in scope.
mocks.sendCommandMock = vi.fn()
mocks.sendPromptMock = vi.fn().mockResolvedValue({ ok: true })
mocks.submitPromptMock = vi.fn().mockResolvedValue(undefined)
mocks.setPermissionModeMock = vi.fn()
mocks.remoteSendMock = vi.fn()
mocks.executeJsMock = vi.fn().mockResolvedValue(null)
mocks.broadcastMock = vi.fn()
mocks.clearConversationFileMock = vi.fn().mockResolvedValue(undefined)
mocks.getTabStatusMock = vi.fn().mockReturnValue({ conversationId: null })

function emitBridgeEvent(key: string, event: any): void {
  const arr = mocks.bridgeListeners.get('event') ?? []
  for (const fn of arr) fn(key, event)
}

vi.mock('../state', () => {
  const mockEngineBridge = {
    sendCommand: (...args: any[]) => mocks.sendCommandMock(...args),
    sendPrompt: (...args: any[]) => mocks.sendPromptMock(...args),
    clearConversationFile: (...args: any[]) => mocks.clearConversationFileMock(...args),
    on: (name: string, fn: (key: string, event: any) => void) => {
      const arr = mocks.bridgeListeners.get(name) ?? []
      arr.push(fn)
      mocks.bridgeListeners.set(name, arr)
    },
  }
  return {
    state: {
      mainWindow: { webContents: { executeJavaScript: (...args: any[]) => mocks.executeJsMock(...args) } },
      remoteTransport: { send: (...args: any[]) => mocks.remoteSendMock(...args) },
    },
    sessionPlane: {
      submitPrompt: (...args: any[]) => mocks.submitPromptMock(...args),
      setPermissionMode: (...args: any[]) => mocks.setPermissionModeMock(...args),
      getTabStatus: (...args: any[]) => mocks.getTabStatusMock(...args),
      notifyConversationCleared: vi.fn(),
    },
    engineBridge: mockEngineBridge,
    extensionCommandRegistry: new Map(),
  }
})

vi.mock('../broadcast', () => ({
  broadcast: (...args: any[]) => mocks.broadcastMock(...args),
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../settings-store', () => ({
  readSettings: () => ({ enableClaudeCompat: true }),
  SETTINGS_DEFAULTS: { enableClaudeCompat: true },
}))

vi.mock('../remote/attachment-encoder', () => ({
  encodeAttachments: (text: string, _atts: any[]) => ({ encoded: [], rewrittenText: text }),
}))

// Pull in the SUT AFTER mocks are set up.
import { processIncomingPrompt, ENTER_PLAN_MODE_DESCRIPTION, PLAN_MODE_SPARSE_REMINDER } from '../prompt-pipeline'
import { _resetAwaitersForTests } from '../command-await'

// ───────────────────────────────────────────────────────────────────────────
// beforeEach
// ───────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mocks.sendCommandMock.mockReset()
  mocks.sendPromptMock.mockReset().mockResolvedValue({ ok: true })
  mocks.submitPromptMock.mockReset().mockResolvedValue(undefined)
  mocks.setPermissionModeMock.mockReset()
  mocks.remoteSendMock.mockReset()
  mocks.executeJsMock.mockReset().mockResolvedValue(null)
  mocks.broadcastMock.mockReset()
  mocks.clearConversationFileMock.mockReset().mockResolvedValue(undefined)
  mocks.getTabStatusMock.mockReset().mockReturnValue({ conversationId: null })
  mocks.bridgeListeners.clear()
  _resetAwaitersForTests()
  mocks.sendCommandMock.mockImplementation((key: string, command: string, _args: string) => {
    setTimeout(() => emitBridgeEvent(key, { type: 'engine_command_result', command, commandError: '', message: `command executed: ${command}` }), 0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('planFilePath convergence', () => {
  it('desktop engine prompt forwards planFilePath through submitPrompt RunOptions', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'implement the plan',
      reqId: 'req-pf-1',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'inst1',
      planFilePath: '/plans/test.md',
      runOptions: { prompt: 'implement the plan', projectPath: '/tmp', extensions: ['ext-a'], planFilePath: '/plans/test.md' },
    })
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    const callArgs = mocks.submitPromptMock.mock.calls[0]
    expect(callArgs[0]).toBe('tab-1')                  // tabId
    expect(callArgs[2].planFilePath).toBe('/plans/test.md')  // RunOptions.planFilePath
  })

  it('remote engine prompt broadcasts planFilePath in REMOTE_ENGINE_PROMPT data', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'implement the plan',
      reqId: 'req-pf-2',
      source: 'remote',
      hasExtensions: true,
      instanceId: 'inst1',
      planFilePath: '/plans/test.md',
    })
    expect(mocks.broadcastMock).toHaveBeenCalledWith(
      expect.stringMatching(/remote-engine-prompt/i),
      expect.objectContaining({
        tabId: 'tab-1',
        planFilePath: '/plans/test.md',
      }),
    )
  })
})

describe('implementationPhase convergence', () => {
  it('desktop engine prompt forwards implementationPhase through submitPrompt RunOptions', async () => {
    // Post-unification: every desktop-source prompt — engine or plain — routes
    // through sessionPlane.submitPrompt with RunOptions. An extension-backed tab
    // is identified by a non-empty extensions list (data), not a separate IPC.
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'do it',
      reqId: 'req-ip-1',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'inst1',
      implementationPhase: true,
      runOptions: { prompt: 'do it', projectPath: '/tmp', extensions: ['ext-a'], implementationPhase: true },
    })
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    const opts = mocks.submitPromptMock.mock.calls[0][2]
    expect(opts.implementationPhase).toBe(true)
  })

  it('remote engine prompt broadcasts implementationPhase in REMOTE_ENGINE_PROMPT data', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'do it',
      reqId: 'req-ip-2',
      source: 'remote',
      hasExtensions: true,
      instanceId: 'inst1',
      implementationPhase: true,
    })
    expect(mocks.broadcastMock).toHaveBeenCalledWith(
      expect.stringMatching(/remote-engine-prompt/i),
      expect.objectContaining({
        tabId: 'tab-1',
        implementationPhase: true,
      }),
    )
  })

  it('remote CLI prompt broadcasts implementationPhase in REMOTE_USER_MESSAGE data', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'do it',
      reqId: 'req-ip-3',
      source: 'remote',
      hasExtensions: false,
      implementationPhase: true,
    })
    expect(mocks.broadcastMock).toHaveBeenCalledWith(
      expect.stringMatching(/remote-user-message/i),
      expect.objectContaining({
        tabId: 'tab-1',
        implementationPhase: true,
      }),
    )
  })
})

describe('prose constants convergence', () => {
  it('desktop engine prompt sets ENTER_PLAN_MODE_DESCRIPTION + PLAN_MODE_SPARSE_REMINDER on RunOptions', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-pc-1',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'inst1',
      runOptions: { prompt: 'hello', projectPath: '/tmp', extensions: ['ext-a'] },
    })
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    const opts = mocks.submitPromptMock.mock.calls[0][2]
    // The pipeline injects the harness-owned prose onto RunOptions, which
    // submitPrompt forwards to the single send_prompt wire command.
    expect(opts.enterPlanModeDescription).toBe(ENTER_PLAN_MODE_DESCRIPTION)
    expect(typeof opts.enterPlanModeDescription).toBe('string')
    expect(opts.enterPlanModeDescription.length).toBeGreaterThan(0)
    expect(opts.planModeSparseReminder).toBe(PLAN_MODE_SPARSE_REMINDER)
    expect(typeof opts.planModeSparseReminder).toBe('string')
    expect(opts.planModeSparseReminder.length).toBeGreaterThan(0)
  })
})
