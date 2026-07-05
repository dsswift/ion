/**
 * Regression test: iOS slash command handled by extension (commandError === '')
 * must insert the user turn into the desktop renderer store.
 *
 * Root cause: when an iOS slash command is handled directly by an extension
 * (the SUCCESS path in handleSlash), the extension's ctx.sendPrompt starts a
 * run, but the desktop pipeline's success path returned without creating a
 * user message in the renderer store. The renderer only had the assistant's
 * response (from text_chunk events), and iOS history reads (which pull from
 * the renderer store) also missed the user turn.
 *
 * Fix: insertRendererRemoteUserMessage is called in the extension-command-
 * success path for remote prompts, adding the user bubble via
 * executeJavaScript without triggering a new engine prompt.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const bridgeListeners = new Map<string, Array<(key: string, event: any) => void>>()
  return {
    bridgeListeners,
    sendCommandMock: null as any,
    sendPromptMock: null as any,
    submitPromptMock: null as any,
    setPermissionModeMock: null as any,
    remoteSendMock: null as any,
    executeJsMock: null as any,
    broadcastMock: null as any,
    clearConversationFileMock: null as any,
    getTabStatusMock: null as any,
    notifyConversationClearedMock: null as any,
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
mocks.getTabStatusMock = vi.fn().mockReturnValue({ conversationId: null, promptCountSinceCheckpoint: 0 })
mocks.notifyConversationClearedMock = vi.fn()

function emitBridgeEvent(key: string, event: any): void {
  const arr = mocks.bridgeListeners.get('event') ?? []
  for (const fn of arr) fn(key, event)
}

vi.mock('../state', () => ({
  state: {
    mainWindow: { webContents: { executeJavaScript: (...args: any[]) => mocks.executeJsMock(...args) } },
    remoteTransport: { send: (...args: any[]) => mocks.remoteSendMock(...args) },
  },
  sessionPlane: {
    submitPrompt: (...args: any[]) => mocks.submitPromptMock(...args),
    setPermissionMode: (...args: any[]) => mocks.setPermissionModeMock(...args),
    getTabStatus: (...args: any[]) => mocks.getTabStatusMock(...args),
    notifyConversationCleared: (...args: any[]) => mocks.notifyConversationClearedMock(...args),
  },
  engineBridge: {
    sendCommand: (...args: any[]) => mocks.sendCommandMock(...args),
    sendPrompt: (...args: any[]) => mocks.sendPromptMock(...args),
    clearConversationFile: (...args: any[]) => mocks.clearConversationFileMock(...args),
    on: (name: string, fn: (key: string, event: any) => void) => {
      const arr = mocks.bridgeListeners.get(name) ?? []
      arr.push(fn)
      mocks.bridgeListeners.set(name, arr)
    },
  },
  extensionCommandRegistry: new Map(),
}))

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

beforeEach(() => {
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
  // Default: extension command succeeds
  mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
    setTimeout(() => emitBridgeEvent(key, {
      type: 'engine_command_result', command, commandError: '',
      message: `command executed: ${command}`,
    }), 0)
  })
})

describe('iOS slash command: extension command success path', () => {
  it('inserts user message into renderer store for remote slash on extension tab', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/align',
      reqId: 'remote-align-1',
      source: 'remote',
      hasExtensions: true,
      instanceId: 'inst-1',
    })

    // The pipeline should have called executeJavaScript to insert the user
    // message via insertRemoteUserMessage.
    const jsCalls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[0] as string)
    const insertCall = jsCalls.find((s: string) => s.includes('insertRemoteUserMessage'))
    expect(insertCall).toBeDefined()
    expect(insertCall).toContain('/align')
  })

  it('does NOT insert renderer user message for desktop-source slash (no double insert)', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/align',
      reqId: 'req-desktop-1',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'inst-1',
      runOptions: { prompt: '/align' } as any,
    })

    // Desktop-source slash should NOT call insertRemoteUserMessage — the
    // renderer's submit() already created the optimistic user message.
    const jsCalls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[0] as string)
    const insertCall = jsCalls.find((s: string) => s.includes('insertRemoteUserMessage'))
    expect(insertCall).toBeUndefined()
  })

  it('does NOT insert renderer user message for /clear (clear is a checkpoint)', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/clear',
      reqId: 'remote-clear-1',
      source: 'remote',
      hasExtensions: true,
      instanceId: 'inst-1',
    })

    // /clear should not insert a user message (it is not a task)
    const jsCalls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[0] as string)
    const insertCall = jsCalls.find((s: string) => s.includes('insertRemoteUserMessage'))
    expect(insertCall).toBeUndefined()
  })

  it('carries slash metadata (slashCommand, slashArgs) in the insert', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/review changes 138 139',
      reqId: 'remote-review-1',
      source: 'remote',
      hasExtensions: true,
      instanceId: 'inst-1',
    })

    const jsCalls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[0] as string)
    const insertCall = jsCalls.find((s: string) => s.includes('insertRemoteUserMessage'))
    expect(insertCall).toBeDefined()
    expect(insertCall).toContain('/review')
    expect(insertCall).toContain('changes 138 139')
  })

  it('inserts user message for remote slash on NON-extension tab too', async () => {
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/align',
      reqId: 'remote-align-2',
      source: 'remote',
      hasExtensions: false,
    })

    const jsCalls = mocks.executeJsMock.mock.calls.map((c: any[]) => c[0] as string)
    const insertCall = jsCalls.find((s: string) => s.includes('insertRemoteUserMessage'))
    expect(insertCall).toBeDefined()
  })
})
