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
  encodeAttachments: (text: string, _atts: any[]) => ({ encoded: [], rewrittenText: text }),
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
  mocks.getTabStatusMock.mockReset().mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, resumedSavedConversation: false, conversationId: null })
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
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, resumedSavedConversation: false, conversationId: null })
    expect(isFirstPromptForTab('tab-1')).toBe(true)
  })

  it('is FRESH on a brand-new eagerly-started session whose engine-minted id the renderer now sends (scenario C)', () => {
    // The engine pre-minted a conversationId for this fresh session and the
    // renderer sends it as runOptions.sessionId — but resumedSavedConversation
    // is FALSE because nothing was restored. This is the /align-in-plan-mode
    // regression: a non-null sessionId must NOT mark a fresh mint as resumed.
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, resumedSavedConversation: false, conversationId: 'engine-minted-id' })
    expect(isFirstPromptForTab('tab-1')).toBe(true)
  })

  it('is NOT fresh when a prompt has been submitted since the last checkpoint', () => {
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 1, promptCountSinceCheckpoint: 1, clearedSinceLastPrompt: false, resumedSavedConversation: false, conversationId: 'conv-123' })
    expect(isFirstPromptForTab('tab-1')).toBe(false)
  })

  it('is NOT fresh when resuming a saved conversation (resumedSavedConversation flag set)', () => {
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, resumedSavedConversation: true, conversationId: 'restored-conv-id' })
    expect(isFirstPromptForTab('tab-1')).toBe(false)
  })

  it('is FRESH right after /clear even when conversationId is still set', () => {
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 5, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: true, resumedSavedConversation: false, conversationId: 'conv-after-clear' })
    expect(isFirstPromptForTab('tab-1')).toBe(true)
  })

  it('is FRESH right after /clear even on a tab that was a resumed conversation', () => {
    // clearedSinceLastPrompt takes precedence over resumedSavedConversation:
    // after /clear the conversation is semantically blank again.
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 5, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: true, resumedSavedConversation: true, conversationId: 'conv-after-clear' })
    expect(isFirstPromptForTab('tab-1')).toBe(true)
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
      hasExtensions: false,
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
      hasExtensions: false,
      runOptions: { prompt: '/ion--review 138', sessionId: 'conv-after-clear' } as any,
    })
    expect(mocks.setPermissionModeMock).toHaveBeenCalledWith('tab-1', 'auto', 'slash_command')
  })

  it('does NOT call setPermissionMode mid-conversation (not the first prompt)', async () => {
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 3, promptCountSinceCheckpoint: 3, clearedSinceLastPrompt: false, resumedSavedConversation: false, conversationId: 'conv-1' })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review 138',
      reqId: 'req-no-switch-mid',
      source: 'desktop',
      hasExtensions: false,
      runOptions: { prompt: '/ion--review 138' } as any,
    })
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
  })

  it('calls setPermissionMode(auto) on a fresh session whose engine-minted id is sent as sessionId (the /align regression, scenario C)', async () => {
    // Brand-new eagerly-started session: count 0, resumedSavedConversation
    // FALSE (engine minted the id, nothing was restored), yet the renderer
    // sends the minted id as runOptions.sessionId. Pre-fix, isFirstPromptForTab
    // treated any non-null sessionId as resumed and SUPPRESSED the flip, so a
    // first-prompt /align ran in plan mode. The flip must fire.
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, resumedSavedConversation: false, conversationId: 'engine-minted-id' })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/align',
      reqId: 'req-align-fresh',
      source: 'desktop',
      hasExtensions: false,
      runOptions: { prompt: '/align', sessionId: 'engine-minted-id' } as any,
    })
    expect(mocks.setPermissionModeMock).toHaveBeenCalledWith('tab-1', 'auto', 'slash_command')
  })

  it('does NOT flip on a genuinely resumed saved conversation (scenario B, resumedSavedConversation set)', async () => {
    // Restored saved conversation: count 0 but resumedSavedConversation TRUE.
    // The flip must NOT fire — the user is deliberately resuming an existing
    // (possibly plan-mode) conversation.
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, resumedSavedConversation: true, conversationId: 'restored-conv-id' })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/align',
      reqId: 'req-align-resumed',
      source: 'desktop',
      hasExtensions: false,
      runOptions: { prompt: '/align', sessionId: 'restored-conv-id' } as any,
    })
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
  })

  // ─── Tab-type parity (Defect 0): the flip is TAB-TYPE-AGNOSTIC ─────────────
  // The plan→auto flip is a desktop policy keyed on first-prompt freshness, not
  // on tab type. An extension/harness tab in plan mode must flip on a
  // first-prompt slash command exactly like a plain tab. Pre-fix a stale
  // `!p.hasExtensions` guard suppressed the flip for every extension tab.

  it('calls setPermissionMode(auto) on a fresh EXTENSION tab (Defect 0)', async () => {
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, conversationId: null })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review 138',
      reqId: 'req-ext-fresh',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'main',
      runOptions: { prompt: '/ion--review 138' } as any,
    })
    expect(mocks.setPermissionModeMock).toHaveBeenCalledWith('tab-1', 'auto', 'slash_command')
  })

  it('calls setPermissionMode(auto) on an EXTENSION tab right after /clear (Defect 0)', async () => {
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 5, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: true, conversationId: 'conv-after-clear' })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review 138',
      reqId: 'req-ext-clear',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'main',
      runOptions: { prompt: '/ion--review 138', sessionId: 'conv-after-clear' } as any,
    })
    expect(mocks.setPermissionModeMock).toHaveBeenCalledWith('tab-1', 'auto', 'slash_command')
  })

  it('does NOT call setPermissionMode mid-conversation on an EXTENSION tab (Defect 0 guard preserved)', async () => {
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 3, promptCountSinceCheckpoint: 3, clearedSinceLastPrompt: false, conversationId: 'conv-1' })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review 138',
      reqId: 'req-ext-mid',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'main',
      runOptions: { prompt: '/ion--review 138' } as any,
    })
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// B2 regression: first-prompt slash on a RESUMED extension-hosted tab
// (resumedSavedConversation=true) must NOT flip plan→auto.
//
// The logic at slash-classify.ts:90 (isFirstPromptForTab returns false when
// resumedSavedConversation) is the guard. This test pins it for the
// extension-hosted path so the combination can't regress silently.
// ───────────────────────────────────────────────────────────────────────────

describe('processIncomingPrompt — resumed extension-hosted tab preserves permission mode', () => {
  it('does NOT flip plan→auto on the first slash prompt of a RESUMED extension tab (resumedSavedConversation=true)', async () => {
    // An extension-hosted tab restored from saved state: resumedSavedConversation
    // is true even though promptCountSinceCheckpoint is 0. The user is resuming
    // an existing conversation that may intentionally be in plan mode. The
    // plan→auto flip must NOT fire. isFirstPromptForTab returns false at
    // slash-classify.ts:90 for this case — this test pins that the pipeline
    // respects that answer even when hasExtensions=true.
    mocks.getTabStatusMock.mockReturnValue({
      promptCount: 0,
      promptCountSinceCheckpoint: 0,
      clearedSinceLastPrompt: false,
      resumedSavedConversation: true,
      conversationId: 'restored-ext-conv',
    })
    await processIncomingPrompt({
      tabId: 'tab-resumed-ext',
      text: '/align',
      reqId: 'req-resumed-ext',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'main',
      runOptions: { prompt: '/align', sessionId: 'restored-ext-conv' } as any,
    })
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
  })
})
//
// A slash command that the engine's command registry resolves returns
// commandError === '' and can START A RUN (an extension command, a built-in).
// Before the fix the plan→auto flip lived only inside the unknown_command
// re-submit branch, so a first-prompt slash command the engine resolved
// directly executed under the still-active plan mode. These tests drive the
// resolved-command branch by emitting commandError: '' and assert the flip
// fires (and is correctly suppressed for /clear and mid-conversation).
//
// Each test would go RED if the flip were only on the unknown_command branch.
// ───────────────────────────────────────────────────────────────────────────

describe('processIncomingPrompt — engine-resolved slash command flips plan→auto (Defect 2)', () => {
  /** Make the engine RESOLVE the command (commandError === '') instead of the
   *  default unknown_command. */
  function engineResolvesCommand(): void {
    mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
      setTimeout(() => emitBridgeEvent(key, { type: 'engine_command_result', command, commandError: '' }), 0)
    })
  }

  it('flips plan→auto on a fresh tab when the engine resolves the command', async () => {
    engineResolvesCommand()
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, conversationId: null })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/compact',
      reqId: 'req-resolved-fresh',
      source: 'desktop',
      hasExtensions: false,
      runOptions: { prompt: '/compact' } as any,
    })
    expect(mocks.setPermissionModeMock).toHaveBeenCalledWith('tab-1', 'auto', 'slash_command')
  })

  it('flips plan→auto on a fresh EXTENSION tab when the engine resolves the command', async () => {
    engineResolvesCommand()
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, conversationId: null })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/standup',
      reqId: 'req-resolved-ext',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'main',
      runOptions: { prompt: '/standup' } as any,
    })
    expect(mocks.setPermissionModeMock).toHaveBeenCalledWith('tab-1', 'auto', 'slash_command')
  })

  it('does NOT flip for /clear even when the engine resolves it (checkpoint, not a task)', async () => {
    engineResolvesCommand()
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, conversationId: null })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/clear',
      reqId: 'req-resolved-clear',
      source: 'desktop',
      hasExtensions: false,
      runOptions: { prompt: '/clear' } as any,
    })
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
  })

  it('does NOT flip mid-conversation when the engine resolves the command', async () => {
    engineResolvesCommand()
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 3, promptCountSinceCheckpoint: 3, clearedSinceLastPrompt: false, conversationId: 'conv-1' })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/standup',
      reqId: 'req-resolved-mid',
      source: 'desktop',
      hasExtensions: false,
      runOptions: { prompt: '/standup' } as any,
    })
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
  })
})
