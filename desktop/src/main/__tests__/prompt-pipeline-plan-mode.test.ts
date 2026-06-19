/**
 * Tests for the freshness predicate `isFirstPromptForTab` (slash-classify.ts)
 * and the prompt pipeline's permission-mode behaviour on a slash re-submit.
 *
 * The desktop NO LONGER performs the plan→auto auto-switch for slash commands
 * itself: slash resolution + expansion (and the plan-mode policy that goes
 * with it) is now owned by the engine via resolveSlash. `isFirstPromptForTab`
 * remains a pure predicate the engine-control-plane freshness model and other
 * call sites reason about, so these tests pin its contract directly, plus a
 * guard that the pipeline does not flip permission mode for slash commands.
 *
 * Freshness checkpoints (what resets promptCountSinceCheckpoint to 0):
 *   - tab creation / resetTabSession
 *   - successful /clear (notifyConversationCleared) — leaves conversationId
 *     set but clears the checkpoint counter and sets clearedSinceLastPrompt.
 *
 * Uses the same vi.hoisted() + vi.mock('../state') pattern as
 * prompt-pipeline.test.ts. Split into a companion file to keep both files
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
  const getTabStatusMock = (globalThis as any).vi?.fn?.()?.mockReturnValue?.({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, conversationId: null }) ?? function () { return { promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, conversationId: null } }
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

mocks.sendCommandMock = vi.fn()
mocks.sendPromptMock = vi.fn().mockResolvedValue({ ok: true })
mocks.submitPromptMock = vi.fn().mockResolvedValue(undefined)
mocks.setPermissionModeMock = vi.fn()
mocks.remoteSendMock = vi.fn()
mocks.executeJsMock = vi.fn().mockResolvedValue(null)
mocks.broadcastMock = vi.fn()
mocks.clearConversationFileMock = vi.fn().mockResolvedValue(undefined)
mocks.getTabStatusMock = vi.fn().mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, conversationId: null })

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
  encodeImageAttachments: (text: string, _atts: any[]) => ({ encoded: [], rewrittenText: text }),
}))

import { processIncomingPrompt } from '../prompt-pipeline'
import { isFirstPromptForTab } from '../slash-classify'
import { _resetAwaitersForTests } from '../command-await'

// ───────────────────────────────────────────────────────────────────────────
// Shared setup.
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
  mocks.getTabStatusMock.mockReset().mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, conversationId: null })
  mocks.bridgeListeners.clear()
  _resetAwaitersForTests()
  // Default: engine returns unknown_command so the slash re-submit path runs.
  mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
    setTimeout(() => emitBridgeEvent(key, { type: 'engine_command_result', command, commandError: 'unknown_command', message: `unknown command: ${command}` }), 0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Unit tests for the freshness predicate. The desktop no longer performs the
// plan→auto auto-switch for slash commands itself — slash resolution +
// expansion (and the plan-mode policy that goes with it) is now owned by the
// engine. `isFirstPromptForTab` remains a pure predicate that several call
// sites and the engine-control-plane freshness model reason about; these
// tests pin its contract directly.
// ───────────────────────────────────────────────────────────────────────────

describe('isFirstPromptForTab (freshness predicate)', () => {
  it('is FRESH when the tab is not yet registered', () => {
    mocks.getTabStatusMock.mockReturnValue(undefined)
    expect(isFirstPromptForTab('tab-1')).toBe(true)
  })

  it('is FRESH on a registered tab with no prompts since the last checkpoint', () => {
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, conversationId: null })
    expect(isFirstPromptForTab('tab-1')).toBe(true)
  })

  it('is NOT fresh when a prompt has been submitted since the last checkpoint', () => {
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 1, promptCountSinceCheckpoint: 1, clearedSinceLastPrompt: false, conversationId: 'conv-123' })
    expect(isFirstPromptForTab('tab-1')).toBe(false)
  })

  it('is NOT fresh when resuming a saved conversation (runOptionsSessionId set)', () => {
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, conversationId: null })
    expect(isFirstPromptForTab('tab-1', 'restored-conv-id')).toBe(false)
  })

  it('is FRESH right after /clear even when conversationId is still set', () => {
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 5, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: true, conversationId: 'conv-after-clear' })
    expect(isFirstPromptForTab('tab-1')).toBe(true)
  })

  it('is FRESH right after /clear even when the renderer sends a stale sessionId', () => {
    // After /clear the renderer still sends tab.conversationId as
    // runOptionsSessionId; clearedSinceLastPrompt overrides it.
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 5, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: true, conversationId: 'conv-after-clear' })
    expect(isFirstPromptForTab('tab-1', 'conv-after-clear')).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Pipeline behaviour: the desktop flips plan→auto for a slash command on the
// FIRST prompt of the checkpoint (fresh tab or freshly /clear'd), because a
// slash command means "run this task" and is incompatible with plan mode. This
// is a DESKTOP policy — the engine does not own it; the client that toggles
// plan mode on the session is responsible. The flip calls setPermissionMode
// (→ sendSetPlanMode(false)) before forwarding the resolveSlash re-submit.
// ───────────────────────────────────────────────────────────────────────────

describe('processIncomingPrompt — slash re-submit flips plan→auto on first prompt', () => {
  it('calls setPermissionMode(auto) on a fresh tab', async () => {
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, conversationId: null })
    const opts: any = { prompt: '/ion--review 138' }
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review 138',
      reqId: 'req-switch',
      source: 'desktop',
      isEngineTab: false,
      runOptions: opts,
    })
    expect(opts.resolveSlash).toBe(true)
    expect(mocks.setPermissionModeMock).toHaveBeenCalledWith('tab-1', 'auto', 'slash_command')
  })

  it('calls setPermissionMode(auto) right after /clear (freshly checkpointed)', async () => {
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 5, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: true, conversationId: 'conv-after-clear' })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review 138',
      reqId: 'req-switch-2',
      source: 'desktop',
      isEngineTab: false,
      runOptions: { prompt: '/ion--review 138', sessionId: 'conv-after-clear' } as any,
    })
    expect(mocks.setPermissionModeMock).toHaveBeenCalledWith('tab-1', 'auto', 'slash_command')
  })

  it('does NOT call setPermissionMode mid-conversation (not the first prompt)', async () => {
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 3, promptCountSinceCheckpoint: 3, clearedSinceLastPrompt: false, conversationId: 'conv-1' })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review 138',
      reqId: 'req-no-switch-mid',
      source: 'desktop',
      isEngineTab: false,
      runOptions: { prompt: '/ion--review 138' } as any,
    })
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
  })
})
