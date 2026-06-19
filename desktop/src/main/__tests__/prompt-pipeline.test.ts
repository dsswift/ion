/**
 * Tests for the unified prompt pipeline (`desktop/src/main/prompt-pipeline.ts`).
 *
 * The pipeline owns the entire slash-command and bash-shortcut decision
 * tree. Both the desktop renderer (via IPC.PROMPT) and the iOS remote
 * handler (via tabs.ts:handlePrompt / engine.ts:handleEnginePrompt) call
 * `processIncomingPrompt` with raw text and let the pipeline decide.
 *
 * Coverage:
 *   - extension command success → done, no re-submit
 *   - unknown_command → re-submit raw invocation with resolveSlash=true
 *     (engine owns resolution + expansion; local .md expansion retired)
 *   - engine ALSO disclaims the resolveSlash send → system message
 *   - non-slash text → submitAsPrompt path (renderer or remote)
 *   - bash shortcut routes to REMOTE_BASH_COMMAND broadcast
 *   - source: 'remote' echoes a canonical message_added back
 *   - tab status is cleared after successful pure command (no run started)
 *
 * Strategy: mock engineBridge.sendCommand to fire engine_command_result
 * synchronously via the awaitCommandResult listener, mock state.remoteTransport
 * to capture echoes, mock broadcast to capture renderer broadcasts.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ───────────────────────────────────────────────────────────────────────────
// Mocks — must come BEFORE any import of the SUT or its transitive deps.
// vi.mock is hoisted to the top of the file by vitest, so anything its
// factories reference must be inside a vi.hoisted() block (which is also
// hoisted) or declared inline. We use vi.hoisted to share mock objects
// between the mock factories and the test bodies.
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
  // getTabStatusMock: returns a tab-like object. Default: fresh tab (no
  // conversationId, no prompts since checkpoint). Override in tests to
  // simulate a loaded-but-not-started conversation or a mid-checkpoint tab.
  const getTabStatusMock = (globalThis as any).vi?.fn?.()?.mockReturnValue?.({ conversationId: null, promptCountSinceCheckpoint: 0 }) ?? function () { return { conversationId: null, promptCountSinceCheckpoint: 0 } }
  const notifyConversationClearedMock = (globalThis as any).vi?.fn?.() ?? function () {}
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
    notifyConversationClearedMock,
  }
})

// The hoisted block above runs before vitest's globalThis.vi is initialised
// in some setups; rebuild as real vi.fn() values now that vi is in scope.
mocks.sendCommandMock = vi.fn()
mocks.sendPromptMock = vi.fn().mockResolvedValue({ ok: true })
mocks.submitPromptMock = vi.fn().mockResolvedValue(undefined)
mocks.setPermissionModeMock = vi.fn()
mocks.remoteSendMock = vi.fn()
mocks.executeJsMock = vi.fn().mockResolvedValue(null)
mocks.broadcastMock = vi.fn()
mocks.clearConversationFileMock = vi.fn().mockResolvedValue(undefined)
mocks.getTabStatusMock = vi.fn().mockReturnValue({ conversationId: null, promptCountSinceCheckpoint: 0 })
mocks.notifyConversationClearedMock = vi.fn()

function emitBridgeEvent(key: string, event: any): void {
  const arr = mocks.bridgeListeners.get('event') ?? []
  for (const fn of arr) fn(key, event)
}

vi.mock('../state', () => {
  // Inline engineBridge facade — vi.mock is hoisted, so we can't capture a
  // const declared at module scope. Closure over `mocks` (vi.hoisted) is fine.
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
      // getTabStatus delegates through getTabStatusMock so individual tests
      // can override the returned tab object (e.g. to set a conversationId).
      getTabStatus: (...args: any[]) => mocks.getTabStatusMock(...args),
      // notifyConversationCleared is invoked by the /clear short-circuit and
      // by event-wiring on engine-side /clear success. Most tests do not
      // assert on it, but it must exist on the mock so /clear-related tests
      // do not blow up on a missing function.
      notifyConversationCleared: (...args: any[]) => mocks.notifyConversationClearedMock(...args),
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

// Pull in the SUT AFTER mocks are set up.
import { processIncomingPrompt } from '../prompt-pipeline'
import { _resetAwaitersForTests } from '../command-await'

// ───────────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset all mock recordings but keep the implementations we installed at
  // module load. Re-setting the default sendCommand stub each beforeEach so
  // tests that mutate it don't leak into siblings.
  mocks.sendCommandMock.mockReset()
  mocks.sendPromptMock.mockReset().mockResolvedValue({ ok: true })
  mocks.submitPromptMock.mockReset().mockResolvedValue(undefined)
  mocks.setPermissionModeMock.mockReset()
  mocks.remoteSendMock.mockReset()
  mocks.executeJsMock.mockReset().mockResolvedValue(null)
  mocks.broadcastMock.mockReset()
  mocks.clearConversationFileMock.mockReset().mockResolvedValue(undefined)
  mocks.getTabStatusMock.mockReset().mockReturnValue({ conversationId: null, promptCountSinceCheckpoint: 0 })
  mocks.notifyConversationClearedMock.mockReset()
  mocks.bridgeListeners.clear()
  _resetAwaitersForTests()
  mocks.sendCommandMock.mockImplementation((key: string, command: string, _args: string) => {
    // Default success — emit engine_command_result with no error on the
    // next tick so awaitCommandResult resolves. Tests that want different
    // outcomes override this implementation before calling the pipeline.
    setTimeout(() => emitBridgeEvent(key, { type: 'engine_command_result', command, commandError: '', message: `command executed: ${command}` }), 0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('processIncomingPrompt — non-slash text', () => {
  it('desktop CLI submits through sessionPlane with the supplied RunOptions', async () => {
    const opts = { prompt: 'hello world', projectPath: '/proj' }
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello world',
      reqId: 'req-1',
      source: 'desktop',
      isEngineTab: false,
      projectPath: '/proj',
      runOptions: opts as any,
    })
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    expect(mocks.submitPromptMock).toHaveBeenCalledWith('tab-1', 'req-1', opts)
    expect(mocks.sendCommandMock).not.toHaveBeenCalled()
  })

  it('remote CLI broadcasts REMOTE_USER_MESSAGE instead of calling sessionPlane', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello from ios',
      reqId: 'req-2',
      source: 'remote',
      isEngineTab: false,
    })
    expect(mocks.submitPromptMock).not.toHaveBeenCalled()
    expect(mocks.broadcastMock).toHaveBeenCalledWith(expect.stringMatching(/remote-user-message/i), expect.objectContaining({
      tabId: 'tab-1',
      requestId: 'req-2',
      prompt: 'hello from ios',
    }))
  })
})

describe('processIncomingPrompt — slash, engine has command', () => {
  it('dispatches to engine and does NOT call submitPrompt', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/clear',
      reqId: 'req-3',
      source: 'desktop',
      isEngineTab: false,
      runOptions: { prompt: '/clear' } as any,
    })
    expect(mocks.sendCommandMock).toHaveBeenCalledTimes(1)
    expect(mocks.sendCommandMock).toHaveBeenCalledWith('tab-1', 'clear', '')
    expect(mocks.submitPromptMock).not.toHaveBeenCalled()
  })

  it('clears the connecting status after successful pure command', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/clear',
      reqId: 'req-4',
      source: 'desktop',
      isEngineTab: false,
      runOptions: { prompt: '/clear' } as any,
    })
    // executeJavaScript called at least once for clear-status mutation.
    expect(mocks.executeJsMock).toHaveBeenCalled()
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[0] as string)
    expect(calls.some((s: string) => s.includes("status: 'idle'"))).toBe(true)
  })

  it('forwards args verbatim to the engine', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/export markdown json',
      reqId: 'req-5',
      source: 'desktop',
      isEngineTab: false,
      runOptions: { prompt: '/export markdown json' } as any,
    })
    expect(mocks.sendCommandMock).toHaveBeenCalledWith('tab-1', 'export', 'markdown json')
  })
})

describe('processIncomingPrompt — slash, engine disclaims, re-submit with resolveSlash', () => {
  beforeEach(() => {
    // Engine reports unknown_command → re-submit raw invocation with
    // resolveSlash=true (engine owns resolution + expansion; no local .md).
    mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
      setTimeout(() => emitBridgeEvent(key, { type: 'engine_command_result', command, commandError: 'unknown_command', message: `unknown command: ${command}` }), 0)
    })
  })

  it('re-submits the RAW invocation via sessionPlane.submitPrompt with resolveSlash=true (CLI)', async () => {
    const opts: any = { prompt: '/ion--review 138', projectPath: '/proj' }
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review 138',
      reqId: 'req-6',
      source: 'desktop',
      isEngineTab: false,
      projectPath: '/proj',
      runOptions: opts,
    })
    expect(mocks.sendCommandMock).toHaveBeenCalledWith('tab-1', 'ion--review', '138')
    expect(opts.prompt).toBe('/ion--review 138') // raw invocation, not expanded
    expect(opts.resolveSlash).toBe(true)
    expect(mocks.submitPromptMock).toHaveBeenCalledWith('tab-1', 'req-6', opts)
  })

  // The plan→auto first-prompt flip (a desktop policy on the slash re-submit
  // path) is covered comprehensively in prompt-pipeline-plan-mode.test.ts —
  // fresh tab, post-/clear, and mid-conversation cases — alongside the
  // isFirstPromptForTab predicate tests it depends on.
})

describe('processIncomingPrompt — slash, engine ALSO disclaims the resolveSlash send', () => {
  beforeEach(() => {
    mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
      setTimeout(() => emitBridgeEvent(key, { type: 'engine_command_result', command, commandError: 'unknown_command', message: `unknown command: ${command}` }), 0)
    })
  })

  it('emits a system message and does NOT leave the slash silently dropped', async () => {
    const opts: any = { prompt: '/typo-no-such-command' }
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/typo-no-such-command',
      reqId: 'req-8',
      source: 'desktop',
      isEngineTab: false,
      runOptions: opts,
    })
    // Re-submitted with resolveSlash=true; now the engine disclaims the
    // resolveSlash send too (second unknown_command) and we surface it.
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    expect(opts.resolveSlash).toBe(true)
    emitBridgeEvent('tab-1', { type: 'engine_command_result', command: 'typo-no-such-command', commandError: 'unknown_command', message: 'unknown command' })
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.executeJsMock).toHaveBeenCalled()
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[0] as string)
    expect(calls.some((s: string) => s.includes('Unknown command: /typo-no-such-command'))).toBe(true)
  })

  it('echoes the unknown-command system message to iOS when source=remote', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/typo-no-such-command',
      reqId: 'req-9',
      source: 'remote',
      isEngineTab: false,
    })
    // Remote re-submit rides REMOTE_USER_MESSAGE (renderer bounce not
    // simulated here); the engine disclaims the resolveSlash send too, so
    // emit that second result for surfaceEngineUnknownCommand to act on.
    emitBridgeEvent('tab-1', { type: 'engine_command_result', command: 'typo-no-such-command', commandError: 'unknown_command', message: 'unknown command' })
    await new Promise((r) => setTimeout(r, 0))
    const systemMessages = mocks.remoteSendMock.mock.calls.map((c: any[]) => c[0])
      .filter((e: any) => e.type === 'desktop_message_added' && e.message.role === 'system')
    expect(systemMessages.length).toBeGreaterThan(0)
    expect(systemMessages[0].message.content).toContain('Unknown command: /typo-no-such-command')
  })

  it('uses a DISTINCT id for the system-message echo so iOS does not overwrite the user bubble', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/typo-no-such-command',
      reqId: 'user-msg-id-123',
      source: 'remote',
      isEngineTab: false,
    })
    emitBridgeEvent('tab-1', { type: 'engine_command_result', command: 'typo-no-such-command', commandError: 'unknown_command', message: 'unknown command' })
    await new Promise((r) => setTimeout(r, 0))
    const messages = mocks.remoteSendMock.mock.calls.map((c: any[]) => c[0])
      .filter((e: any) => e.type === 'desktop_message_added')
    const userEcho = messages.find((e: any) => e.message.role === 'user')
    const systemEcho = messages.find((e: any) => e.message.role === 'system')
    expect(userEcho?.message.id).toBe('user-msg-id-123')
    expect(systemEcho?.message.id).not.toBe('user-msg-id-123')
    expect(systemEcho?.message.id).toMatch(/^sys-user-msg-id-123-/)
  })
})

describe('processIncomingPrompt — bash shortcut', () => {
  it('routes "! cmd" to REMOTE_BASH_COMMAND broadcast (CLI remote only)', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '! ls -la',
      reqId: 'req-10',
      source: 'remote',
      isEngineTab: false,
    })
    expect(mocks.broadcastMock).toHaveBeenCalledWith(expect.stringMatching(/remote-bash-command/i), expect.objectContaining({
      tabId: 'tab-1',
      command: 'ls -la',
    }))
    expect(mocks.sendCommandMock).not.toHaveBeenCalled()
    expect(mocks.submitPromptMock).not.toHaveBeenCalled()
  })

  it('does NOT trigger bash shortcut for engine tabs', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '! ls',
      reqId: 'req-11',
      source: 'remote',
      isEngineTab: true,
      instanceId: 'inst-1',
    })
    // Engine tab — falls through to submitAsPrompt → broadcast REMOTE_ENGINE_PROMPT, NOT a bash command.
    const bashCalls = (mocks.broadcastMock as any).mock.calls.filter((c: any[]) => /remote-bash-command/i.test(c[0]))
    expect(bashCalls).toHaveLength(0)
  })
})

describe('processIncomingPrompt — engine disclaims, remote slash re-submit (iOS), project-scoped', () => {
  // iOS regression: a fresh CLI tab receives an iOS slash command. The engine
  // disclaims the extension dispatch; the desktop re-submits the RAW
  // invocation with resolveSlash=true. For a remote source the re-submit rides
  // the REMOTE_USER_MESSAGE broadcast (renderer's submitRemotePrompt forwards
  // resolveSlash onto RunOptions).
  beforeEach(() => {
    mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
      setTimeout(() => emitBridgeEvent(key, { type: 'engine_command_result', command, commandError: 'unknown_command', message: `unknown command: ${command}` }), 0)
    })
  })

  it('does NOT walk the filesystem (local .md expansion is retired)', async () => {
    await processIncomingPrompt({
      tabId: 'tab-fresh',
      text: '/ion--review-changes 138,139',
      reqId: 'req-fresh',
      source: 'remote',
      isEngineTab: false,
      projectPath: '/Users/me/proj',
    })
  })

  it('broadcasts the RAW invocation via REMOTE_USER_MESSAGE with resolveSlash=true', async () => {
    await processIncomingPrompt({
      tabId: 'tab-fresh',
      text: '/ion--review-changes 138,139',
      reqId: 'req-fresh-2',
      source: 'remote',
      isEngineTab: false,
      projectPath: '/Users/me/proj',
    })
    expect(mocks.broadcastMock).toHaveBeenCalledWith(expect.stringMatching(/remote-user-message/i), expect.objectContaining({
      tabId: 'tab-fresh',
      prompt: '/ion--review-changes 138,139',
      resolveSlash: true,
    }))
  })
})

describe('processIncomingPrompt — engine tab', () => {
  it('uses compound key `${tabId}:${instanceId}` for extension command dispatch', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/clear',
      reqId: 'req-12',
      source: 'remote',
      isEngineTab: true,
      instanceId: 'inst-x',
    })
    expect(mocks.sendCommandMock).toHaveBeenCalledWith('tab-1:inst-x', 'clear', '')
  })

  it('non-slash text broadcasts REMOTE_ENGINE_PROMPT for remote-source', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-13',
      source: 'remote',
      isEngineTab: true,
      instanceId: 'inst-x',
    })
    expect(mocks.broadcastMock).toHaveBeenCalledWith(expect.stringMatching(/remote-engine-prompt/i), expect.objectContaining({
      tabId: 'tab-1',
      text: 'hello',
    }))
  })

  it('re-submits an unknown desktop-source slash via sendPrompt with the RAW text and resolveSlash=true', async () => {
    // Engine-tab desktop path re-submits straight through engineBridge.sendPrompt
    // with the raw text + resolveSlash=true (NOT an expanded body).
    mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
      setTimeout(() => emitBridgeEvent(key, { type: 'engine_command_result', command, commandError: 'unknown_command', message: `unknown command: ${command}` }), 0)
    })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/diagram the auth flow',
      reqId: 'req-14',
      source: 'desktop',
      isEngineTab: true,
      instanceId: 'inst-x',
    })
    expect(mocks.sendPromptMock).toHaveBeenCalledTimes(1)
    const call = mocks.sendPromptMock.mock.calls[0]
    // sendPrompt signature: (key, text, ..., resolveSlash) — text is 2nd
    // positional (index 1), resolveSlash is the 12th (index 11).
    expect(call[0]).toBe('tab-1:inst-x')
    expect(call[1]).toBe('/diagram the auth flow')
    expect(call[11]).toBe(true)
  })
})

// Harness system-prompt addenda (turn-grouping guidance) tests live in
// `prompt-pipeline-addenda.test.ts` (file-size cap).

describe('processIncomingPrompt — /clear with no engine session (unknown_command short-circuit)', () => {
  // Regression guard: /clear on a fresh tab (no prior prompt → no engine
  // session) must render the clear divider locally rather than emitting
  // "Unknown command: /clear". The short-circuit in handleSlash intercepts
  // /clear + unknown_command before the resolveSlash re-submit path.
  beforeEach(() => {
    mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
      setTimeout(
        () => emitBridgeEvent(key, { type: 'engine_command_result', command, commandError: 'unknown_command', message: 'unknown command: clear' }),
        0,
      )
    })
  })

  it('inserts the clear divider into the renderer instead of "Unknown command" message', async () => {
    await processIncomingPrompt({
      tabId: 'tab-fresh',
      text: '/clear',
      reqId: 'req-clear-1',
      source: 'desktop',
      isEngineTab: false,
      runOptions: { prompt: '/clear' } as any,
    })
    expect(mocks.submitPromptMock).not.toHaveBeenCalled()
    // The divider uses the "── Cleared" sentinel (from formatClearDivider).
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[0] as string)
    expect(calls.some((s: string) => s.includes('── Cleared'))).toBe(true)
    // The "Unknown command" string must NOT appear anywhere.
    expect(calls.every((s: string) => !s.includes('Unknown command'))).toBe(true)
  })

  it('echoes the divider to iOS via remoteTransport when source=remote', async () => {
    await processIncomingPrompt({
      tabId: 'tab-fresh',
      text: '/clear',
      reqId: 'req-clear-2',
      source: 'remote',
      isEngineTab: false,
    })
    // remoteTransport.send must have been called with a message_added or
    // engine_harness_message carrying the divider content.
    const dividerSends = mocks.remoteSendMock.mock.calls
      .map((c: any[]) => c[0])
      .filter((e: any) => {
        if (e.type === 'desktop_message_added' && e.message?.content?.includes('── Cleared')) return true
        if (e.type === 'desktop_harness_message' && e.message?.includes('── Cleared')) return true
        return false
      })
    expect(dividerSends.length).toBeGreaterThan(0)
    // "Unknown command" must not appear in any remote send.
    const badSends = mocks.remoteSendMock.mock.calls
      .map((c: any[]) => c[0])
      .filter((e: any) => JSON.stringify(e).includes('Unknown command'))
    expect(badSends).toHaveLength(0)
  })

  it('does NOT short-circuit for other unknown slash commands (regression guard)', async () => {
    const opts: any = { prompt: '/no-such-command' }
    await processIncomingPrompt({
      tabId: 'tab-fresh',
      text: '/no-such-command',
      reqId: 'req-clear-3',
      source: 'desktop',
      isEngineTab: false,
      runOptions: opts,
    })
    // The /clear short-circuit does NOT fire for non-clear commands — they
    // re-submit with resolveSlash=true instead. No clear divider appears.
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    expect(opts.resolveSlash).toBe(true)
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[0] as string)
    expect(calls.every((s: string) => !s.includes('── Cleared'))).toBe(true)
  })

  it('does NOT short-circuit when /clear succeeds normally (engine has a session)', async () => {
    // Override: engine reports success for /clear (session exists).
    mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
      setTimeout(
        () => emitBridgeEvent(key, { type: 'engine_command_result', command, commandError: '', message: 'command executed: clear' }),
        0,
      )
    })
    await processIncomingPrompt({
      tabId: 'tab-live',
      text: '/clear',
      reqId: 'req-clear-4',
      source: 'desktop',
      isEngineTab: false,
      runOptions: { prompt: '/clear' } as any,
    })
    // The engine handled it; neither the divider NOR .md expansion NOR
    // "Unknown command" should appear. clearConnectingStatus runs but
    // insertRendererSystemMessage for a divider must NOT.
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[0] as string)
    expect(calls.every((s: string) => !s.includes('── Cleared'))).toBe(true)
    expect(calls.every((s: string) => !s.includes('Unknown command'))).toBe(true)
  })
})

// /clear file-wipe tests (loaded-but-not-started tab) live in the companion
// file prompt-pipeline-clear-wipe.test.ts to keep both files under 600 lines.
