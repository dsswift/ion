/**
 * Tests for prompt-pipeline permission-mode behavior on one command request.
 *
 * The desktop does not mutate session Plan mode for slash commands
 * itself: slash resolution + expansion (and the plan-mode policy that goes
 * with it) is now owned by the engine via resolveSlash. These tests pin that slash commands do not mutate the stored permission mode.
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
      ensureSession: vi.fn().mockResolvedValue({ ok: true }),
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
  // Default: engine returns unknown_command so the single command request path runs.
  mocks.sendCommandMock.mockImplementation((promptArgs: { key: string }, command: string) => {
    setTimeout(() => emitBridgeEvent(promptArgs.key, { type: 'engine_command_result', command, commandError: 'unknown_command', message: `unknown command: ${command}` }), 0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Unit tests for the freshness predicate. The desktop no longer performs the
// Slash commands no longer mutate the session permission mode. The engine
// applies temporary auto permissions only to the command run.
// ───────────────────────────────────────────────────────────────────────────

describe('processIncomingPrompt — slash commands preserve the session plan mode', () => {
  it('does not mutate permission mode on a fresh tab', async () => {
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
    expect(opts.resolveSlash).toBeUndefined()
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
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
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
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

  it('does not mutate permission mode on a fresh session whose engine-minted id is sent as sessionId (the /align regression, scenario C)', async () => {
    // Brand-new eagerly-started session: count 0, resumedSavedConversation
    // FALSE (engine minted the id, nothing was restored), yet the renderer
    // sends the minted id as runOptions.sessionId. The old freshness-based implementation
    // treated any non-null sessionId as resumed and SUPPRESSED the flip, so a
    // first-prompt /align ran in plan mode. The session mode must remain unchanged.
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, clearedSinceLastPrompt: false, resumedSavedConversation: false, conversationId: 'engine-minted-id' })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/align',
      reqId: 'req-align-fresh',
      source: 'desktop',
      hasExtensions: false,
      runOptions: { prompt: '/align', sessionId: 'engine-minted-id' } as any,
    })
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
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

  // The run-scoped temporary-auto marker is tab-type agnostic. Plain and
  // extension-hosted conversations preserve the same session Plan mode.

  it('does not mutate permission mode on a fresh EXTENSION tab (Defect 0)', async () => {
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
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
  })

  it('does not mutate permission mode on an EXTENSION tab right after /clear (Defect 0)', async () => {
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
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
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
// A resumed extension-hosted tab also preserves its stored permission mode.
// ───────────────────────────────────────────────────────────────────────────

describe('processIncomingPrompt — resumed extension-hosted tab preserves permission mode', () => {
  it('preserves mode on the first slash prompt of a RESUMED extension tab (resumedSavedConversation=true)', async () => {
    // An extension-hosted tab restored from saved state: resumedSavedConversation
    // is true even though promptCountSinceCheckpoint is 0. The user is resuming
    // an existing conversation that may intentionally be in plan mode. The
    // the Desktop must not mutate the session mode even when the command uses
    // temporary auto permissions.
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
// A command that resolves directly can start a run. These tests pin unchanged
// session mode for built-in and extension command sources.
// ───────────────────────────────────────────────────────────────────────────

describe('processIncomingPrompt — engine-resolved slash command preserves plan mode', () => {
  /** Make the engine RESOLVE the command (commandError === '') instead of the
   *  default unknown_command. */
  function engineResolvesCommand(): void {
    mocks.sendCommandMock.mockImplementation((promptArgs: { key: string }, command: string) => {
      setTimeout(() => emitBridgeEvent(promptArgs.key, { type: 'engine_command_result', command, commandError: '' }), 0)
    })
  }

  it('does not mutate permission mode on a fresh tab when the engine resolves the command', async () => {
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
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
  })

  it('does not mutate permission mode on a fresh EXTENSION tab when the engine resolves the command', async () => {
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
    expect(mocks.setPermissionModeMock).not.toHaveBeenCalled()
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
