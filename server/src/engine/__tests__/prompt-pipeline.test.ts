/**
 * Tests for the unified prompt pipeline (`../prompt-pipeline.ts`).
 *
 * The pipeline owns the entire slash-command and bash-shortcut decision
 * tree. Both Studio clients (via host.shell.prompt) and the iOS remote
 * handler (via tabs.ts:handlePrompt / engine.ts:handleEnginePrompt) call
 * `processIncomingPrompt` with raw text and let the pipeline decide.
 *
 * Coverage:
 *   - extension command success → done, no re-submit
 *   - engine-owned command resolution uses one request across registered,
 *     built-in, markdown, and skill command sources
 *   - final unknown_command → system message with no retry
 *   - non-slash text → submitAsPrompt path (renderer or remote)
 *   - bash shortcut routes to REMOTE_BASH_COMMAND broadcast
 *   - source: 'remote' echoes a canonical message_added back
 *   - tab status is cleared after successful pure command (no run started)
 *
 * Strategy: mock engineBridge.sendCommand to fire engine_command_result
 * synchronously via the awaitCommandResult listener, mock sendRemoteEvent
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
  const submitPromptMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.({ ok: true }) ?? function () { return Promise.resolve({ ok: true }) }
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
mocks.submitPromptMock = vi.fn().mockResolvedValue({ ok: true })
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

vi.mock('../../thin-view/remote-out', () => ({
  remoteClientsPresent: () => true,
  sendRemoteEvent: (...args: any[]) => mocks.remoteSendMock(...args),
}))

vi.mock('../../state', async (importOriginal) => {
  const __actual = (await importOriginal()) as Record<string, unknown>;

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
  return { ...__actual, 
    state: {
      mainWindow: { webContents: { executeJavaScript: (...args: any[]) => mocks.executeJsMock(...args) } },
    },
    sessionPlane: {
      submitPrompt: (...args: any[]) => mocks.submitPromptMock(...args),
      ensureSession: vi.fn().mockResolvedValue({ ok: true }),
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

// insertRendererSystemMessage/clearConnectingStatus/insertRendererRemoteUserMessage
// (prompt-pipeline-store.ts) used to reach the renderer via
// state.mainWindow.webContents.executeJavaScript; the server owns the store
// directly now, so they call useSessionStore.getState()'s actions in-process.
// Forwarding into mocks.executeJsMock keeps the existing "was it called"
// assertions meaningful with a real, inspectable call signature.
// A remote-source prompt is handed to the store's own submit in-process
// (prompt-pipeline-store.ts). These record that hand-off.
const storeSubmit = vi.hoisted(() => ({ submit: vi.fn(), submitRemotePrompt: vi.fn(), submitRemoteBash: vi.fn() }))
const sessionStoreTabs = vi.hoisted(() => ({ tabs: [{ id: 'tab-1', status: 'connecting' }] as any[] }))
vi.mock('../../store/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: any) => unknown) => selector({ tabs: sessionStoreTabs.tabs }),
    {
      getState: () => ({
        tabs: sessionStoreTabs.tabs,
        addEngineSystemMessage: (...args: any[]) => mocks.executeJsMock(...args),
        insertRemoteUserMessage: (...args: any[]) => mocks.executeJsMock(...args),
        submit: storeSubmit.submit,
        submitRemotePrompt: storeSubmit.submitRemotePrompt,
        submitRemoteBash: storeSubmit.submitRemoteBash,
      }),
      setState: (patch: any) => {
        if (typeof patch === 'object' && patch && 'tabs' in patch) {
          sessionStoreTabs.tabs = patch.tabs
        }
      },
    },
  ),
}))

vi.mock('../../broadcast', () => ({
  broadcast: (...args: any[]) => mocks.broadcastMock(...args),
}))

vi.mock('../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../persistence/settings-store', async (importOriginal) => ({ ...(await importOriginal()), ...{
  readSettings: () => ({ enableClaudeCompat: true }),
  SETTINGS_DEFAULTS: { enableClaudeCompat: true },
} }))

// Attachment-encoding cases live in prompt-pipeline-attachments.test.ts; this
// file uses a passthrough stub so non-attachment tests are unaffected.
vi.mock('../../remote/attachment-encoder', async (importOriginal) => ({ ...(await importOriginal()), ...{
  encodeAttachments: (text: string, _atts: any[]) => ({ encoded: [], rewrittenText: text }),
} }))

// Pull in the SUT AFTER mocks are set up.
import { processIncomingPrompt } from '../prompt-pipeline'
import { _resetAwaitersForTests } from '../../command-await'

// ───────────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  storeSubmit.submit.mockReset()
  storeSubmit.submitRemotePrompt.mockReset()
  storeSubmit.submitRemoteBash.mockReset()
  // Reset all mock recordings but keep the implementations we installed at
  // module load. Re-setting the default sendCommand stub each beforeEach so
  // tests that mutate it don't leak into siblings.
  mocks.sendCommandMock.mockReset()
  mocks.sendPromptMock.mockReset().mockResolvedValue({ ok: true })
  mocks.submitPromptMock.mockReset().mockResolvedValue({ ok: true })
  mocks.setPermissionModeMock.mockReset()
  mocks.remoteSendMock.mockReset()
  mocks.executeJsMock.mockReset().mockResolvedValue(null)
  mocks.broadcastMock.mockReset()
  mocks.clearConversationFileMock.mockReset().mockResolvedValue(undefined)
  mocks.getTabStatusMock.mockReset().mockReturnValue({ conversationId: null, promptCountSinceCheckpoint: 0 })
  mocks.notifyConversationClearedMock.mockReset()
  mocks.bridgeListeners.clear()
  _resetAwaitersForTests()
  mocks.sendCommandMock.mockImplementation((promptArgs: { key: string }, command: string, _args: string) => {
    // Default success — emit engine_command_result with no error on the
    // next tick so awaitCommandResult resolves. Tests that want different
    // outcomes override this implementation before calling the pipeline.
    setTimeout(() => emitBridgeEvent(promptArgs.key, { type: 'engine_command_result', command, commandError: '', message: `command executed: ${command}` }), 0)
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
      hasExtensions: false,
      projectPath: '/proj',
      runOptions: opts as any,
    })
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    expect(mocks.submitPromptMock).toHaveBeenCalledWith('tab-1', 'req-1', opts)
    expect(mocks.sendCommandMock).not.toHaveBeenCalled()
  })

  it('remote plain prompt is handed to the store submitRemotePrompt, not sessionPlane', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello from ios',
      reqId: 'req-2',
      source: 'remote',
      hasExtensions: false,
    })
    expect(mocks.submitPromptMock).not.toHaveBeenCalled()
    expect(storeSubmit.submitRemotePrompt).toHaveBeenCalledTimes(1)
    const call = storeSubmit.submitRemotePrompt.mock.calls[0]
    expect(call[0]).toBe('tab-1')
    expect(call[1]).toBe('hello from ios')
    expect(call[5]).toBe('req-2')
    expect(storeSubmit.submit).not.toHaveBeenCalled()
    // Nothing on the Studio wire carries a remote prompt: a broadcast here
    // reaches no store and the prompt is lost.
    expect(mocks.broadcastMock).not.toHaveBeenCalled()
  })
})

describe('processIncomingPrompt — slash, engine has command', () => {
  it('dispatches to engine and does NOT call submitPrompt', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/clear',
      reqId: 'req-3',
      source: 'desktop',
      hasExtensions: false,
      runOptions: { prompt: '/clear' } as any,
    })
    expect(mocks.sendCommandMock).toHaveBeenCalledTimes(1)
    expect(mocks.getTabStatusMock).toHaveBeenCalledWith('tab-1')
    expect(mocks.sendCommandMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'tab-1' }), 'clear', '')
    expect(mocks.submitPromptMock).not.toHaveBeenCalled()
  })

  it('clears the connecting status after successful pure command', async () => {
    sessionStoreTabs.tabs = [{ id: 'tab-1', status: 'connecting' }]
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/clear',
      reqId: 'req-4',
      source: 'desktop',
      hasExtensions: false,
      runOptions: { prompt: '/clear' } as any,
    })
    expect(sessionStoreTabs.tabs.find((t) => t.id === 'tab-1')?.status).toBe('idle')
  })

  it('forwards args verbatim to the engine', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/export markdown json',
      reqId: 'req-5',
      source: 'desktop',
      hasExtensions: false,
      runOptions: { prompt: '/export markdown json' } as any,
    })
    expect(mocks.sendCommandMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'tab-1' }), 'export', 'markdown json')
  })
})

describe('processIncomingPrompt — engine owns final unknown-command resolution', () => {
  beforeEach(() => {
    mocks.sendCommandMock.mockImplementation((promptArgs: { key: string }, command: string) => {
      setTimeout(() => emitBridgeEvent(promptArgs.key, { type: 'engine_command_result', command, commandError: 'unknown_command', message: `unknown command: ${command}` }), 0)
    })
  })

  it('sends exactly one command request and never re-submits through send_prompt', async () => {
    const opts: any = { prompt: '/ion--review 138', projectPath: '/proj' }
    await processIncomingPrompt({ tabId: 'tab-1', text: '/ion--review 138', reqId: 'req-6', source: 'desktop', hasExtensions: false, projectPath: '/proj', runOptions: opts })
    expect(mocks.sendCommandMock).toHaveBeenCalledTimes(1)
    expect(mocks.sendCommandMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'tab-1', text: '/ion--review 138' }), 'ion--review', '138')
    expect(mocks.submitPromptMock).not.toHaveBeenCalled()
    expect(opts.resolveSlash).toBeUndefined()
  })

  it('surfaces the final unknown command without a second engine request', async () => {
    await processIncomingPrompt({ tabId: 'tab-1', text: '/typo-no-such-command', reqId: 'req-8', source: 'desktop', hasExtensions: false, runOptions: { prompt: '/typo-no-such-command' } as any })
    expect(mocks.sendCommandMock).toHaveBeenCalledTimes(1)
    expect(mocks.submitPromptMock).not.toHaveBeenCalled()
    // addEngineSystemMessage(tabId, content) forwards through executeJsMock.
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[1] as string)
    expect(calls.some((line: string) => line?.includes('Unknown command: /typo-no-such-command'))).toBe(true)
  })
})

describe('processIncomingPrompt — bash shortcut', () => {
  it('routes "! cmd" to the store submitRemoteBash (plain remote only)', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '! ls -la',
      reqId: 'req-10',
      source: 'remote',
      hasExtensions: false,
    })
    // reqId is the client's message id, stamped on the row.
    expect(storeSubmit.submitRemoteBash).toHaveBeenCalledWith('tab-1', 'ls -la', 'req-10')
    expect(mocks.broadcastMock).not.toHaveBeenCalled()
    expect(mocks.sendCommandMock).not.toHaveBeenCalled()
    expect(mocks.submitPromptMock).not.toHaveBeenCalled()
  })

  it('does NOT trigger bash shortcut for extension-hosted tabs', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '! ls',
      reqId: 'req-11',
      source: 'remote',
      hasExtensions: true,
      instanceId: 'inst-1',
    })
    // Extension-hosted tab — falls through to submitAsPrompt → the store's
    // unified submit, NOT a bash command.
    expect(storeSubmit.submitRemoteBash).not.toHaveBeenCalled()
    expect(storeSubmit.submit).toHaveBeenCalledWith('tab-1', '! ls', expect.objectContaining({ source: 'remote' }))
  })
})

describe('processIncomingPrompt — extension-hosted tab', () => {
  it('uses bare tabId for extension command dispatch (Phase 4b)', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/clear',
      reqId: 'req-12',
      source: 'remote',
      hasExtensions: true,
      instanceId: 'inst-x',
    })
    expect(mocks.sendCommandMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'tab-1' }), 'clear', '')
  })

  it('non-slash remote text is handed to the store unified submit', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-13',
      source: 'remote',
      hasExtensions: true,
      instanceId: 'inst-x',
    })
    expect(storeSubmit.submit).toHaveBeenCalledWith('tab-1', 'hello', expect.objectContaining({
      source: 'remote',
      requestId: 'req-13',
    }))
    expect(storeSubmit.submitRemotePrompt).not.toHaveBeenCalled()
    expect(mocks.broadcastMock).not.toHaveBeenCalled()
  })

})

// Harness system-prompt addenda (turn-grouping guidance) tests live in
// `prompt-pipeline-addenda.test.ts` (file-size cap).

describe('processIncomingPrompt — /clear with no engine session (unknown_command short-circuit)', () => {
  // Regression guard: /clear on a fresh tab (no prior prompt → no engine
  // session) must render the clear divider locally rather than emitting
  // "Unknown command: /clear". The short-circuit in handleSlash intercepts
  // /clear + unknown_command before the single command request path.
  beforeEach(() => {
    mocks.sendCommandMock.mockImplementation((promptArgs: { key: string }, command: string) => {
      setTimeout(
        () => emitBridgeEvent(promptArgs.key, { type: 'engine_command_result', command, commandError: 'unknown_command', message: 'unknown command: clear' }),
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
      hasExtensions: false,
      runOptions: { prompt: '/clear' } as any,
    })
    expect(mocks.submitPromptMock).not.toHaveBeenCalled()
    // The divider uses the "── Cleared" sentinel (from formatClearDivider).
    // addEngineSystemMessage(tabId, content) forwards through executeJsMock.
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[1] as string)
    expect(calls.some((s: string) => s?.includes('── Cleared'))).toBe(true)
    // The "Unknown command" string must NOT appear anywhere.
    expect(calls.every((s: string) => !s?.includes('Unknown command'))).toBe(true)
  })

  // A remote client receives the divider as a row on its transcript stream,
  // published from the store; nothing is sent to it on the side.
  it('puts a remote /clear divider in the store and sends a remote client nothing', async () => {
    await processIncomingPrompt({
      tabId: 'tab-fresh',
      text: '/clear',
      reqId: 'req-clear-2',
      source: 'remote',
      hasExtensions: false,
    })
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[1] as string)
    expect(calls.some((s: string) => s?.includes('── Cleared'))).toBe(true)
    const dividerSends = mocks.remoteSendMock.mock.calls
      .map((c: any[]) => JSON.stringify(c[0]))
      .filter((e: string) => e.includes('── Cleared') || e.includes('Unknown command'))
    expect(dividerSends).toHaveLength(0)
  })

  it('surfaces other unknown slash commands without a retry', async () => {
    await processIncomingPrompt({ tabId: 'tab-fresh', text: '/no-such-command', reqId: 'req-clear-3', source: 'desktop', hasExtensions: false, runOptions: { prompt: '/no-such-command' } as any })
    expect(mocks.sendCommandMock).toHaveBeenCalledTimes(1)
    expect(mocks.submitPromptMock).not.toHaveBeenCalled()
    // addEngineSystemMessage(tabId, content) forwards through executeJsMock.
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[1] as string)
    expect(calls.some((line: string) => line?.includes('Unknown command: /no-such-command'))).toBe(true)
    expect(calls.every((line: string) => !line?.includes('── Cleared'))).toBe(true)
  })

  it('does NOT short-circuit when /clear succeeds normally (engine has a session)', async () => {
    // Override: engine reports success for /clear (session exists).
    mocks.sendCommandMock.mockImplementation((promptArgs: { key: string }, command: string) => {
      setTimeout(
        () => emitBridgeEvent(promptArgs.key, { type: 'engine_command_result', command, commandError: '', message: 'command executed: clear' }),
        0,
      )
    })
    await processIncomingPrompt({
      tabId: 'tab-live',
      text: '/clear',
      reqId: 'req-clear-4',
      source: 'desktop',
      hasExtensions: false,
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
// /clear file-wipe tests live in prompt-pipeline-clear-wipe.test.ts (file-size cap).
