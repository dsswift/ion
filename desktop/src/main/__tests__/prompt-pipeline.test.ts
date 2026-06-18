/**
 * Tests for the unified prompt pipeline (`desktop/src/main/prompt-pipeline.ts`).
 *
 * The pipeline owns the entire slash-command and bash-shortcut decision
 * tree. Both the desktop renderer (via IPC.PROMPT) and the iOS remote
 * handler (via tabs.ts:handlePrompt / engine.ts:handleEnginePrompt) call
 * `processIncomingPrompt` with raw text and let the pipeline decide.
 *
 * Coverage:
 *   - extension command takes precedence over .md template
 *   - .md template falls back when engine reports unknown_command
 *   - unknown_command + no .md → system message, no LLM call
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
  const expandSlashMock = (globalThis as any).vi?.fn?.() ?? function () {}
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
    expandSlashMock,
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
mocks.expandSlashMock = vi.fn().mockResolvedValue({ expanded: false })
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
import { processIncomingPrompt } from '../prompt-pipeline'
import { _resetAwaitersForTests } from '../command-await'
import { TURN_GROUPING_GUIDANCE } from '../turn-grouping-guidance'

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
  mocks.expandSlashMock.mockReset().mockResolvedValue({ expanded: false })
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
    expect(mocks.expandSlashMock).not.toHaveBeenCalled() // success → no .md fallback
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

describe('processIncomingPrompt — slash, engine reports unknown, .md falls back', () => {
  beforeEach(() => {
    mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
      // Engine reports unknown_command — pipeline should fall through to .md.
      setTimeout(() => emitBridgeEvent(key, { type: 'engine_command_result', command, commandError: 'unknown_command', message: `unknown command: ${command}` }), 0)
    })
  })

  it('expands via .md and submits the expansion as a normal prompt', async () => {
    mocks.expandSlashMock.mockResolvedValue({ expanded: true, systemPrompt: 'sys', userPrompt: 'expanded body', frontmatter: {} })
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
    expect(mocks.expandSlashMock).toHaveBeenCalledWith('/ion--review 138', '/proj', 'ion')
    // Pipeline should mutate runOptions and then submit it.
    expect(opts.prompt).toBe('expanded body')
    // The CLI dispatch path runs applyHarnessSystemPromptAddenda, which
    // appends the turn-grouping guidance to runOptions.appendSystemPrompt.
    // The expansion-supplied "sys" remains as the prefix.
    expect(opts.appendSystemPrompt).toMatch(/^sys\n\nTool calls are not rendered inline/)
    expect(opts.appendSystemPrompt).toBe(`sys\n\n${TURN_GROUPING_GUIDANCE}`)
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    expect(mocks.submitPromptMock).toHaveBeenCalledWith('tab-1', 'req-6', opts)
  })

  it('auto-switches permission mode to auto on .md expansion', async () => {
    // Explicitly set first-prompt state so the guard allows the switch.
    mocks.getTabStatusMock.mockReturnValue({ promptCount: 0, promptCountSinceCheckpoint: 0, conversationId: null })
    mocks.expandSlashMock.mockResolvedValue({ expanded: true, systemPrompt: 'sys', userPrompt: 'expanded', frontmatter: {} })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review 138',
      reqId: 'req-7',
      source: 'desktop',
      isEngineTab: false,
      runOptions: { prompt: '/ion--review 138' } as any,
    })
    expect(mocks.setPermissionModeMock).toHaveBeenCalledWith('tab-1', 'auto', 'slash_command')
  })
  // Additional plan→auto guard tests (active conversation, resumed session)
  // live in prompt-pipeline-plan-mode.test.ts to keep this file under the
  // 600-line cap.
})

describe('processIncomingPrompt — slash, engine reports unknown, no .md', () => {
  beforeEach(() => {
    mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
      setTimeout(() => emitBridgeEvent(key, { type: 'engine_command_result', command, commandError: 'unknown_command', message: `unknown command: ${command}` }), 0)
    })
    mocks.expandSlashMock.mockResolvedValue({ expanded: false })
  })

  it('emits a system message and does NOT submit to the LLM', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/typo-no-such-command',
      reqId: 'req-8',
      source: 'desktop',
      isEngineTab: false,
      runOptions: { prompt: '/typo-no-such-command' } as any,
    })
    expect(mocks.submitPromptMock).not.toHaveBeenCalled()
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
    const systemMessages = mocks.remoteSendMock.mock.calls.map((c: any[]) => c[0])
      .filter((e: any) => e.type === 'desktop_message_added' && e.message.role === 'system')
    expect(systemMessages.length).toBeGreaterThan(0)
    expect(systemMessages[0].message.content).toContain('Unknown command: /typo-no-such-command')
  })

  it('uses a DISTINCT id for the system-message echo so iOS does not overwrite the user bubble', async () => {
    // Regression guard for the bug where a slash failure visibly deleted
    // the user's message: emitRemoteMessageAdded used p.reqId verbatim
    // for both the user echo and the system echo, so iOS's id-keyed
    // message_added replacement overwrote the user turn with the error
    // string. Confirm here that the system echo carries a sys-prefixed
    // id distinct from reqId.
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/typo-no-such-command',
      reqId: 'user-msg-id-123',
      source: 'remote',
      isEngineTab: false,
    })
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

describe('processIncomingPrompt — engine reports unknown_command, .md template found, project-scoped', () => {
  // Specifically guards the regression we hit on iOS: a fresh CLI tab whose
  // engine session hasn't started yet receives an iOS-originated slash
  // command (e.g. `/ion--review-changes 138,139`). The engine SendCommand
  // path used to silently drop the dispatch, leaving the desktop awaiter
  // to time out. The engine now emits unknown_command for missing-session
  // dispatches, the pipeline falls back to .md expansion using the tab's
  // working directory, and the expanded prompt submits normally.
  beforeEach(() => {
    mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
      setTimeout(() => emitBridgeEvent(key, { type: 'engine_command_result', command, commandError: 'unknown_command', message: `unknown command: ${command}` }), 0)
    })
    mocks.expandSlashMock.mockResolvedValue({ expanded: true, systemPrompt: 'Review changes', userPrompt: 'Please review PRs 138, 139', frontmatter: {} })
  })

  it('passes projectPath through to expandSlashCommand', async () => {
    await processIncomingPrompt({
      tabId: 'tab-fresh',
      text: '/ion--review-changes 138,139',
      reqId: 'req-fresh',
      source: 'remote',
      isEngineTab: false,
      projectPath: '/Users/me/proj',
    })
    expect(mocks.expandSlashMock).toHaveBeenCalledWith('/ion--review-changes 138,139', '/Users/me/proj', 'ion')
  })

  it('submits the expansion via REMOTE_USER_MESSAGE for remote-source CLI tabs', async () => {
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
      prompt: 'Please review PRs 138, 139',
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
})

// Harness system-prompt addenda (turn-grouping guidance) tests live in
// `prompt-pipeline-addenda.test.ts` to keep this file under the 600-line
// TypeScript cap. See CLAUDE.md → "When a file exceeds the cap".

describe('processIncomingPrompt — /clear with no engine session (unknown_command short-circuit)', () => {
  // Regression guard: /clear on a fresh tab (no prior prompt → no engine session)
  // previously fell through the unknown_command branch, skipped .md expansion,
  // and emitted "Unknown command: /clear". The short-circuit added in
  // handleSlash must intercept /clear+unknown_command before that path.
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
    expect(mocks.expandSlashMock).not.toHaveBeenCalled()
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
    mocks.expandSlashMock.mockResolvedValue({ expanded: false })
    await processIncomingPrompt({
      tabId: 'tab-fresh',
      text: '/no-such-command',
      reqId: 'req-clear-3',
      source: 'desktop',
      isEngineTab: false,
      runOptions: { prompt: '/no-such-command' } as any,
    })
    // .md expansion was attempted (then failed), so the unknown-command
    // system message was emitted — NOT the divider. Two calls: ion scope
    // first (always), then claude scope (gated, but enableClaudeCompat
    // defaults to true in the mock settings).
    expect(mocks.expandSlashMock).toHaveBeenCalledTimes(2)
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[0] as string)
    expect(calls.some((s: string) => s.includes('Unknown command: /no-such-command'))).toBe(true)
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
    expect(mocks.expandSlashMock).not.toHaveBeenCalled()
  })
})

// /clear file-wipe tests (loaded-but-not-started tab) live in the companion
// file prompt-pipeline-clear-wipe.test.ts to keep both files under 600 lines.
