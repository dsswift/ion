/**
 * Regression tests for the /clear file-wipe path in prompt-pipeline.ts.
 *
 * Issue: /clear on a tab that was loaded from disk (tab.conversationId set)
 * but has never sent a prompt (no engine session exists) returned
 * unknown_command. The desktop rendered the clear divider visually but never
 * wiped the on-disk conversation file. On the next prompt the engine loaded
 * the full prior history and forwarded it to the LLM — the "/clear" was
 * visual-only.
 *
 * Fix: when unknown_command + /clear + tab.conversationId, call
 * engineBridge.clearConversationFile(conversationId) before rendering the
 * divider. This file tests that path independently from the main pipeline
 * suite so neither file exceeds the 600-line cap.
 *
 * Split from: prompt-pipeline.test.ts (file-size cohesion boundary)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ───────────────────────────────────────────────────────────────────────────
// Mocks — same pattern as prompt-pipeline.test.ts.
// ───────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const bridgeListeners = new Map<string, Array<(key: string, event: any) => void>>()
  const sendCommandMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const submitPromptMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.({ ok: true }) ?? function () { return Promise.resolve({ ok: true }) }
  const setPermissionModeMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const remoteSendMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const executeJsMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(null) ?? function () { return Promise.resolve(null) }
  const broadcastMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const clearConversationFileMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(undefined) ?? function () { return Promise.resolve() }
  // getTabStatusMock: returns tab-like object. Default: no conversationId.
  const getTabStatusMock = (globalThis as any).vi?.fn?.()?.mockReturnValue?.({ conversationId: null }) ?? function () { return { conversationId: null } }
  // notifyConversationClearedMock: called by the /clear local short-circuit
  // path so the desktop's freshness checkpoint advances even when the engine
  // returns unknown_command. Tests assert via the .mock.calls inspector.
  const notifyConversationClearedMock = (globalThis as any).vi?.fn?.() ?? function () {}
  return {
    bridgeListeners,
    sendCommandMock,
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

// Rebuild as real vi.fn() values now that vi is in scope.
mocks.sendCommandMock = vi.fn()
mocks.submitPromptMock = vi.fn().mockResolvedValue({ ok: true })
mocks.setPermissionModeMock = vi.fn()
mocks.remoteSendMock = vi.fn()
mocks.executeJsMock = vi.fn().mockResolvedValue(null)
mocks.broadcastMock = vi.fn()
mocks.clearConversationFileMock = vi.fn().mockResolvedValue(undefined)
mocks.getTabStatusMock = vi.fn().mockReturnValue({ conversationId: null })
mocks.notifyConversationClearedMock = vi.fn()

function emitBridgeEvent(key: string, event: any): void {
  const arr = mocks.bridgeListeners.get('event') ?? []
  for (const fn of arr) fn(key, event)
}

// insertRendererSystemMessage/clearConnectingStatus/insertRendererRemoteUserMessage
// (prompt-pipeline-store.ts) used to reach the renderer via
// state.mainWindow.webContents.executeJavaScript; the server owns the store
// directly now, so they call useSessionStore.getState()'s actions in-process.
// Forwarding into mocks.executeJsMock keeps the existing "was it called"
// assertions meaningful with a real, inspectable call signature.
const sessionStoreTabs = vi.hoisted(() => ({ tabs: [{ id: 'tab-1', status: 'connecting' }] as any[] }))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: any) => unknown) => selector({ tabs: sessionStoreTabs.tabs }),
    {
      getState: () => ({
        tabs: sessionStoreTabs.tabs,
        addEngineSystemMessage: (...args: any[]) => mocks.executeJsMock(...args),
        insertRemoteUserMessage: (...args: any[]) => mocks.executeJsMock(...args),
      }),
      setState: (patch: any) => {
        if (typeof patch === 'object' && patch && 'tabs' in patch) {
          sessionStoreTabs.tabs = patch.tabs
        }
      },
    },
  ),
}))

vi.mock('@ion/server/state', async (importOriginal) => {
  const __actual = (await importOriginal()) as Record<string, unknown>;

  const mockEngineBridge = {
    sendCommand: (...args: any[]) => mocks.sendCommandMock(...args),
    sendPrompt: vi.fn().mockResolvedValue({ ok: true }),
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
      remoteTransport: { send: (...args: any[]) => mocks.remoteSendMock(...args) },
    },
    sessionPlane: {
      submitPrompt: (...args: any[]) => mocks.submitPromptMock(...args),
      ensureSession: vi.fn().mockResolvedValue({ ok: true }),
      setPermissionMode: (...args: any[]) => mocks.setPermissionModeMock(...args),
      getTabStatus: (...args: any[]) => mocks.getTabStatusMock(...args),
      notifyConversationCleared: (...args: any[]) => mocks.notifyConversationClearedMock(...args),
    },
    engineBridge: mockEngineBridge,
    extensionCommandRegistry: new Map(),
  }
})

vi.mock('@ion/server/broadcast', () => ({
  broadcast: (...args: any[]) => mocks.broadcastMock(...args),
}))

vi.mock('@ion/server/logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@ion/server/persistence/settings-store', async (importOriginal) => ({ ...(await importOriginal()), ...{
  readSettings: () => ({ enableClaudeCompat: true }),
  SETTINGS_DEFAULTS: { enableClaudeCompat: true },
} }))

vi.mock('@ion/server/remote/attachment-encoder', async (importOriginal) => ({ ...(await importOriginal()), ...{
  encodeAttachments: (text: string, _atts: any[]) => ({ encoded: [], rewrittenText: text }),
} }))

import { processIncomingPrompt } from '@ion/server/engine/prompt-pipeline'
import { _resetAwaitersForTests } from '@ion/server/command-await'

// ───────────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mocks.sendCommandMock.mockReset()
  mocks.submitPromptMock.mockReset().mockResolvedValue({ ok: true })
  mocks.setPermissionModeMock.mockReset()
  mocks.remoteSendMock.mockReset()
  mocks.executeJsMock.mockReset().mockResolvedValue(null)
  mocks.broadcastMock.mockReset()
  mocks.clearConversationFileMock.mockReset().mockResolvedValue(undefined)
  mocks.getTabStatusMock.mockReset().mockReturnValue({ conversationId: null })
  mocks.notifyConversationClearedMock.mockReset()
  mocks.bridgeListeners.clear()
  _resetAwaitersForTests()
  // Default: engine returns unknown_command for /clear (no session exists).
  mocks.sendCommandMock.mockImplementation((promptArgs: { key: string }, command: string) => {
    setTimeout(
      () => emitBridgeEvent(promptArgs.key, { type: 'engine_command_result', command, commandError: 'unknown_command', message: 'unknown command: clear' }),
      0,
    )
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('processIncomingPrompt — /clear file wipe on loaded-but-not-started tab', () => {
  // Regression guard: /clear on a tab loaded from disk (tab.conversationId
  // set) but with no engine session returns unknown_command. Previously the
  // desktop rendered the divider but never wiped the on-disk file, so the
  // LLM still saw all prior history on the next prompt.
  //
  // Fix: resolveConversationId consults three sources in priority order.
  // This suite tests each priority path independently.

  // ── Priority 2: sessionPlane (engine-side mirror) ────────────────────────
  // Regression guard for the original fix. Kept so we detect any regression
  // on the sessionPlane path even as the higher-priority runOptions path
  // takes over for the desktop-source case.
  it('calls clearConversationFile when sessionPlane has conversationId (priority-2 path)', async () => {
    // Simulate a tab with engine session started — sessionPlane knows the id.
    // runOptions has no sessionId so priority-1 is bypassed.
    mocks.getTabStatusMock.mockReturnValue({ conversationId: 'loaded-conv-42' })

    await processIncomingPrompt({
      tabId: 'tab-loaded',
      text: '/clear',
      reqId: 'req-wipe-sp',
      source: 'desktop',
      hasExtensions: false,
      // No sessionId on runOptions — forces priority-2 path.
      runOptions: { prompt: '/clear' } as any,
    })

    // clearConversationFile must be called with the correct conversationId.
    expect(mocks.clearConversationFileMock).toHaveBeenCalledTimes(1)
    expect(mocks.clearConversationFileMock).toHaveBeenCalledWith('loaded-conv-42', false)

    // Divider must still appear.
    // addEngineSystemMessage(tabId, content) forwards through executeJsMock.
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[1] as string)
    expect(calls.some((s: string) => s?.includes('── Cleared'))).toBe(true)

    // No "Unknown command" error.
    expect(calls.every((s: string) => !s.includes('Unknown command'))).toBe(true)
  })

  // ── /clear --keep-plan on the no-session short-circuit ──────────────────
  // The flag rides the file-only clear so a never-prompted tab keeps its plan
  // too; the engine returns the retained slug and the divider names it.
  it('passes --keep-plan through and renders the kept-plan notice', async () => {
    mocks.getTabStatusMock.mockReturnValue({ conversationId: 'loaded-conv-42' })
    mocks.clearConversationFileMock.mockResolvedValue({ keptPlanSlug: 'happy-jumping-rabbit' })

    await processIncomingPrompt({
      tabId: 'tab-loaded',
      text: '/clear --keep-plan',
      reqId: 'req-wipe-keep',
      source: 'desktop',
      hasExtensions: false,
      runOptions: { prompt: '/clear --keep-plan' } as any,
    })

    expect(mocks.clearConversationFileMock).toHaveBeenCalledWith('loaded-conv-42', true)
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[1] as string)
    expect(calls.some((s: string) => s?.includes('plan kept: happy-jumping-rabbit'))).toBe(true)
  })

  // ── Priority 1: runOptions.sessionId ────────────────────────────────────
  // Desktop /clear always carries runOptions.sessionId. This path must wipe
  // using that id even when sessionPlane has nothing (the loaded-but-not-
  // started scenario that triggered the original bug report).
  it('calls clearConversationFile using runOptions.sessionId when sessionPlane is empty (priority-1 path)', async () => {
    // sessionPlane has no conversationId — tab was loaded but never prompted.
    mocks.getTabStatusMock.mockReturnValue({ conversationId: null })

    await processIncomingPrompt({
      tabId: 'tab-loaded-fresh',
      text: '/clear',
      reqId: 'req-wipe-ro',
      source: 'desktop',
      hasExtensions: false,
      // The renderer's send-slice populates sessionId from tab.conversationId.
      runOptions: { prompt: '/clear', sessionId: '1779509603510-e1dbeb9b1544' } as any,
    })

    // clearConversationFile must be called with the runOptions id.
    expect(mocks.clearConversationFileMock).toHaveBeenCalledTimes(1)
    expect(mocks.clearConversationFileMock).toHaveBeenCalledWith('1779509603510-e1dbeb9b1544', false)

    // Divider must still appear.
    // addEngineSystemMessage(tabId, content) forwards through executeJsMock.
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[1] as string)
    expect(calls.some((s: string) => s?.includes('── Cleared'))).toBe(true)

    // No "Unknown command" error.
    expect(calls.every((s: string) => !s.includes('Unknown command'))).toBe(true)
  })

  // ── Priority 3: renderer-store query ────────────────────────────────────
  // Remote-source /clear (iOS) never includes runOptions and never populates
  // the engine-side mirror until a session starts. The renderer store is the
  // safety net.
  it('calls clearConversationFile via renderer-store when runOptions and sessionPlane are both empty (priority-3 path)', async () => {
    // Neither priority-1 nor priority-2 has a conversationId.
    mocks.getTabStatusMock.mockReturnValue({ conversationId: null })
    // Priority 3 is now a plain in-process store read (useSessionStore
    // .getState().tabs.find(...).conversationId) -- no executeJavaScript hop.
    sessionStoreTabs.tabs = [{ id: 'tab-ios-loaded', conversationId: 'remote-conv-ios-99' }]

    await processIncomingPrompt({
      tabId: 'tab-ios-loaded',
      text: '/clear',
      reqId: 'req-wipe-rs',
      // Remote source: no runOptions, no sessionPlane entry.
      source: 'remote',
      hasExtensions: false,
    })

    // clearConversationFile must be called with the renderer-store id.
    expect(mocks.clearConversationFileMock).toHaveBeenCalledTimes(1)
    expect(mocks.clearConversationFileMock).toHaveBeenCalledWith('remote-conv-ios-99', false)

    // Divider must still appear. addEngineSystemMessage(tabId, content) forwards through executeJsMock.
    const allScripts = mocks.executeJsMock.mock.calls.map((c: any[]) => c[1] as string)
    expect(allScripts.some((s: string) => s?.includes('── Cleared'))).toBe(true)

    // No "Unknown command" error.
    expect(allScripts.every((s: string) => !s.includes('Unknown command'))).toBe(true)
  })

  // ── All sources null: truly fresh tab ───────────────────────────────────
  // When all three sources return null the tab has never had a conversation
  // file. No wipe should fire; the divider still appears.
  it('does NOT call clearConversationFile when all three sources return null (truly fresh tab)', async () => {
    // Priority 1: no runOptions.sessionId.
    // Priority 2: sessionPlane returns null.
    mocks.getTabStatusMock.mockReturnValue({ conversationId: null })
    // Priority 3: renderer store returns null.
    mocks.executeJsMock.mockResolvedValue(null)

    await processIncomingPrompt({
      tabId: 'tab-new',
      text: '/clear',
      reqId: 'req-wipe-fresh',
      source: 'desktop',
      hasExtensions: false,
      // runOptions has no sessionId.
      runOptions: { prompt: '/clear' } as any,
    })

    // No wipe needed — no conversation file exists.
    expect(mocks.clearConversationFileMock).not.toHaveBeenCalled()

    // Divider still appears. addEngineSystemMessage(tabId, content) forwards through executeJsMock.
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[1] as string)
    expect(calls.some((s: string) => s?.includes('── Cleared'))).toBe(true)
  })

  it('still inserts divider even when clearConversationFile throws (non-fatal error path)', async () => {
    mocks.getTabStatusMock.mockReturnValue({ conversationId: null })
    // Priority-1 path supplies the id; wipe then throws.
    mocks.clearConversationFileMock.mockRejectedValue(new Error('engine load failed'))

    await processIncomingPrompt({
      tabId: 'tab-err',
      text: '/clear',
      reqId: 'req-wipe-err',
      source: 'desktop',
      hasExtensions: false,
      runOptions: { prompt: '/clear', sessionId: 'loaded-conv-error' } as any,
    })

    // The divider must appear even when the wipe fails (non-fatal).
    // addEngineSystemMessage(tabId, content) forwards through executeJsMock.
    const calls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[1] as string)
    expect(calls.some((s: string) => s?.includes('── Cleared'))).toBe(true)
    // "Unknown command" must not appear.
    expect(calls.every((s: string) => !s?.includes('Unknown command'))).toBe(true)
  })
})
