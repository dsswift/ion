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
  const expandSlashMock = (globalThis as any).vi?.fn?.() ?? function () {}
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
    expandSlashMock,
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
mocks.expandSlashMock = vi.fn().mockResolvedValue({ expanded: false })
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

vi.mock('../cli-compat/slash-expand', () => ({
  expandSlashCommand: (...args: any[]) => mocks.expandSlashMock(...args),
}))

vi.mock('../settings-store', () => ({
  readSettings: () => ({ enableClaudeCompat: true }),
  SETTINGS_DEFAULTS: { enableClaudeCompat: true },
}))

vi.mock('../remote/attachment-encoder', () => ({
  encodeImageAttachments: (text: string, _atts: any[]) => ({ encoded: [], rewrittenText: text }),
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
  mocks.expandSlashMock.mockReset().mockResolvedValue({ expanded: false })
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
  it('desktop engine prompt forwards planFilePath to sendPrompt (9th arg)', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'implement the plan',
      reqId: 'req-pf-1',
      source: 'desktop',
      isEngineTab: true,
      instanceId: 'inst1',
      planFilePath: '/plans/test.md',
    })
    expect(mocks.sendPromptMock).toHaveBeenCalledTimes(1)
    // sendPrompt signature: (key, text, model, appendSys, images, implPhase, enterDesc, sparseReminder, planFilePath)
    const args = mocks.sendPromptMock.mock.calls[0]
    expect(args[0]).toBe('tab-1:inst1')         // key
    expect(args[8]).toBe('/plans/test.md')       // planFilePath (9th positional)
  })

  it('remote engine prompt broadcasts planFilePath in REMOTE_ENGINE_PROMPT data', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'implement the plan',
      reqId: 'req-pf-2',
      source: 'remote',
      isEngineTab: true,
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
  it('desktop engine prompt forwards implementationPhase to sendPrompt (6th arg)', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'do it',
      reqId: 'req-ip-1',
      source: 'desktop',
      isEngineTab: true,
      instanceId: 'inst1',
      implementationPhase: true,
    })
    expect(mocks.sendPromptMock).toHaveBeenCalledTimes(1)
    const args = mocks.sendPromptMock.mock.calls[0]
    expect(args[5]).toBe(true)   // implementationPhase (6th positional)
  })

  it('remote engine prompt broadcasts implementationPhase in REMOTE_ENGINE_PROMPT data', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'do it',
      reqId: 'req-ip-2',
      source: 'remote',
      isEngineTab: true,
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
      isEngineTab: false,
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
  it('desktop engine prompt passes ENTER_PLAN_MODE_DESCRIPTION and PLAN_MODE_SPARSE_REMINDER', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-pc-1',
      source: 'desktop',
      isEngineTab: true,
      instanceId: 'inst1',
    })
    expect(mocks.sendPromptMock).toHaveBeenCalledTimes(1)
    const args = mocks.sendPromptMock.mock.calls[0]
    // enterPlanModeDescription (7th arg) and planModeSparseReminder (8th arg)
    expect(args[6]).toBe(ENTER_PLAN_MODE_DESCRIPTION)
    expect(typeof args[6]).toBe('string')
    expect(args[6].length).toBeGreaterThan(0)
    expect(args[7]).toBe(PLAN_MODE_SPARSE_REMINDER)
    expect(typeof args[7]).toBe('string')
    expect(args[7].length).toBeGreaterThan(0)
  })
})
