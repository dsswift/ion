/**
 * Tests for the plan→auto permission-mode guard in the prompt pipeline.
 *
 * Guards the behaviour of `isFirstPromptForTab` (slash-classify.ts): the
 * pipeline must auto-switch from plan→auto ONLY on the first prompt of the
 * current "freshness checkpoint", and must preserve plan mode in all other
 * scenarios:
 *
 *   - conversation already active (promptCountSinceCheckpoint > 0)
 *   - resumed session (runOptions.sessionId carries the prior conversationId)
 *
 * The resumed-session case is the most subtle: after an app restart the
 * engine-side TabEntry.conversationId is null (the engine hasn't started
 * yet), but the renderer sends runOptions.sessionId with the saved
 * conversationId. Without checking runOptions.sessionId the guard would
 * see promptCountSinceCheckpoint=0 and incorrectly allow the switch.
 *
 * The post-`/clear` case is the new freshness checkpoint behaviour: when the
 * engine `/clear` succeeds, `engine-control-plane.notifyConversationCleared`
 * resets `promptCountSinceCheckpoint` to 0 even though `conversationId`
 * remains set on the engine side. The guard must then allow plan→auto on
 * the next slash command.
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
  const expandSlashMock = (globalThis as any).vi?.fn?.() ?? function () {}
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
    expandSlashMock,
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
mocks.expandSlashMock = vi.fn().mockResolvedValue({ expanded: false })
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

import { processIncomingPrompt } from '../prompt-pipeline'
import { _resetAwaitersForTests } from '../command-await'

// ───────────────────────────────────────────────────────────────────────────
// Shared setup — engine reports unknown_command so the pipeline falls
// through to .md expansion on every test.
// ───────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mocks.sendCommandMock.mockReset()
  mocks.sendPromptMock.mockReset().mockResolvedValue({ ok: true })
  mocks.submitPromptMock.mockReset().mockResolvedValue(undefined)
  mocks.setPermissionModeMock.mockReset()
  mocks.remoteSendMock.mockReset()
  mocks.executeJsMock.mockReset().mockResolvedValue(null)
  mocks.broadcastMock.mockReset()
  mocks.expandSlashMock.mockReset().mockResolvedValue({ expanded: true, systemPrompt: 'sys', userPrompt: 'expanded', frontmatter: {} })
  mocks.clearConversationFileMock.mockReset().mockResolvedValue(undefined)
  mocks.getTabStatusMock.mockReset().mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, conversationId: null })
  mocks.bridgeListeners.clear()
  _resetAwaitersForTests()
  // Default: engine returns unknown_command so .md expansion is reached.
  mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
    setTimeout(() => emitBridgeEvent(key, { type: 'engine_command_result', command, commandError: 'unknown_command', message: `unknown command: ${command}` }), 0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('plan→auto guard: isFirstPromptForTab', () => {
  it('does NOT auto-switch when conversation is already active (promptCountSinceCheckpoint > 0)', async () => {
    // The engine-side TabEntry.promptCountSinceCheckpoint is > 0: at least
    // one prompt has been submitted since the last freshness checkpoint
    // (tab creation or /clear), so the conversation is live. The guard must
    // preserve plan mode regardless of the template expanding.
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 1, promptCountSinceCheckpoint: 1, clearedSinceLastPrompt: false, conversationId: 'conv-123' })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review 138',
      reqId: 'req-guard-a',
      source: 'desktop',
      isEngineTab: false,
      runOptions: { prompt: '/ion--review 138' } as any,
    })
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
  })

  it('does NOT auto-switch when prior prompts exist even if conversationId is set', async () => {
    // Same-boot mid-session: TabEntry.conversationId populated AND
    // promptCountSinceCheckpoint > 0. The guard must preserve plan mode.
    // (`conversationId` alone is no longer sufficient — the post-`/clear`
    // case explicitly leaves conversationId set while resetting the
    // checkpoint counter, so the guard relies on the counter.)
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 3, promptCountSinceCheckpoint: 3, clearedSinceLastPrompt: false, conversationId: 'live-conv' })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review 138',
      reqId: 'req-guard-b',
      source: 'desktop',
      isEngineTab: false,
      runOptions: { prompt: '/ion--review 138' } as any,
    })
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
  })

  it('does NOT auto-switch when tab is a resumed session (runOptions.sessionId set)', async () => {
    // Primary guard for the app-restart scenario: after a restart the
    // engine-side TabEntry is a fresh makeEmptyTab (conversationId=null,
    // promptCount=0, promptCountSinceCheckpoint=0), but the renderer sends
    // runOptions.sessionId with the prior conversation id so the engine can
    // resume from disk.
    //
    // Without checking runOptions.sessionId the guard would see
    // promptCountSinceCheckpoint=0 and incorrectly allow the switch,
    // silently pulling a plan-mode tab into auto mode before the first prompt.
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, conversationId: null })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review 138',
      reqId: 'req-guard-c',
      source: 'desktop',
      isEngineTab: false,
      runOptions: { prompt: '/ion--review 138', sessionId: 'restored-conv-id' } as any,
    })
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
  })

  it('DOES auto-switch after /clear even when conversationId is still set (no stale sessionId)', async () => {
    // Post-/clear without a stale runOptions.sessionId: the guard sees
    // promptCountSinceCheckpoint=0 and clearedSinceLastPrompt=true, and
    // correctly treats the tab as fresh.
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 5, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: true, conversationId: 'conv-after-clear' })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review 138',
      reqId: 'req-guard-d',
      source: 'desktop',
      isEngineTab: false,
      runOptions: { prompt: '/ion--review 138' } as any,
    })
    expect(mocks.setPermissionModeMock).toHaveBeenCalledWith('tab-1', 'auto', 'slash_command')
  })

  it('DOES auto-switch after /clear even when renderer sends stale sessionId', async () => {
    // Primary regression test for the /clear + stale-sessionId bug.
    //
    // After /clear the renderer still sends tab.conversationId as
    // runOptions.sessionId (it doesn't know about the clear-checkpoint).
    // Without clearedSinceLastPrompt the guard sees runOptionsSessionId
    // set and returns false (preserves plan mode) — the original bug.
    //
    // With the fix, clearedSinceLastPrompt=true overrides the stale
    // sessionId and the guard returns true (allows the switch).
    //
    // Repro: conversation 1780479876135-127911e4a57d — plan mode + /clear,
    // then a .md-expandable slash command was silently left in plan mode.
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 5, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: true, conversationId: 'conv-after-clear' })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review 138',
      reqId: 'req-guard-e',
      source: 'desktop',
      isEngineTab: false,
      // The renderer sends the stale conversationId as sessionId — this is
      // exactly what happens at runtime (send-slice.ts line 215).
      runOptions: { prompt: '/ion--review 138', sessionId: 'conv-after-clear' } as any,
    })
    expect(mocks.setPermissionModeMock).toHaveBeenCalledWith('tab-1', 'auto', 'slash_command')
  })
})
