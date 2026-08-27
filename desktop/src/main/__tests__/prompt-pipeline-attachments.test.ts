/**
 * Tests for the attachment-encoding path in prompt-pipeline.ts.
 *
 * When a desktop-source prompt carries `attachments`, the pipeline calls
 * encodeAttachments and merges the result onto runOptions.imageAttachments
 * before forwarding to sessionPlane.submitPrompt. When no attachments are
 * present the runOptions object is left untouched.
 *
 * These cases are split from the main suite so neither file exceeds the
 * 600-line cap.
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
  const sendPromptMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.({ ok: true }) ?? function () { return Promise.resolve({ ok: true }) }
  const submitPromptMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(undefined) ?? function () { return Promise.resolve() }
  const setPermissionModeMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const remoteSendMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const executeJsMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(null) ?? function () { return Promise.resolve(null) }
  const broadcastMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const clearConversationFileMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(undefined) ?? function () { return Promise.resolve() }
  // getTabStatusMock: default fresh tab (no conversationId, no prompts since
  // checkpoint). Attachment tests exercise the non-slash desktop path so
  // freshness is not the focus, but the mock must exist so the
  // pipeline's freshness guard doesn't throw.
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

// Rebuild as real vi.fn() values now that vi is in scope.
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

// Full encoding mock (not a passthrough): the attachment tests need the
// encoder to produce real output so submitPrompt receives the encoded bytes.
vi.mock('../remote/attachment-encoder', () => ({
  encodeAttachments: (text: string, atts: any[]) => ({
    encoded: atts
      .filter((a: any) => a.path.endsWith('.pdf') || a.type === 'image')
      .map((a: any) => ({ mediaType: a.path.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg', data: 'QkFTRTY0', path: a.path })),
    rewrittenText: text.replace(/\[Attached (?:file|image): ([^\]]+)\]/g, '[Attachment: rewritten]'),
  }),
}))

// Pull in the SUT AFTER mocks are set up.
import { processIncomingPrompt } from '../prompt-pipeline'
import { _resetAwaitersForTests } from '../command-await'

// ───────────────────────────────────────────────────────────────────────────
// Fixtures
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
  mocks.getTabStatusMock.mockReset().mockReturnValue({ conversationId: null, promptCountSinceCheckpoint: 0 })
  mocks.notifyConversationClearedMock.mockReset()
  mocks.bridgeListeners.clear()
  _resetAwaitersForTests()
  mocks.sendCommandMock.mockImplementation((promptArgs: { key: string }, command: string, _args: string) => {
    setTimeout(() => emitBridgeEvent(promptArgs.key, { type: 'engine_command_result', command, commandError: '', message: `command executed: ${command}` }), 0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe('processIncomingPrompt — rawAttachments encoding', () => {
  it('desktop prompt with rawAttachments encodes them into runOptions before submit', async () => {
    const opts = {
      prompt: '[Attached file: /Users/someone/report.pdf]\n\nsummarize',
      projectPath: '/proj',
    } as any
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: opts.prompt,
      reqId: 'req-1',
      source: 'desktop',
      hasExtensions: true,
      projectPath: '/proj',
      runOptions: opts,
      attachments: [{ type: 'file', name: 'report.pdf', path: '/Users/someone/report.pdf' }],
    })
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    const submitted = mocks.submitPromptMock.mock.calls[0][2]
    // Marker rewritten so no downstream component reads a client-local path.
    expect(submitted.prompt).not.toContain('[Attached file:')
    // Bytes merged onto the wire field the bridge forwards to the engine.
    expect(submitted.imageAttachments).toHaveLength(1)
    expect(submitted.imageAttachments[0].mediaType).toBe('application/pdf')
  })

  it('slash command carries encoded attachments on its single command request', async () => {
    const opts = { prompt: '/review', projectPath: '/proj' } as any
    await processIncomingPrompt({
      tabId: 'tab-1', text: '/review', reqId: 'req-slash-att', source: 'desktop',
      hasExtensions: false, projectPath: '/proj', runOptions: opts,
      attachments: [{ type: 'file', name: 'report.pdf', path: '/Users/someone/report.pdf' }],
    })
    expect(mocks.sendCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'tab-1', imageAttachments: expect.any(Array) }),
      'review', '',
    )
    expect(mocks.submitPromptMock).not.toHaveBeenCalled()
  })

  it('desktop prompt without attachments leaves runOptions untouched', async () => {
    const opts = { prompt: 'plain', projectPath: '/proj' } as any
    await processIncomingPrompt({
      tabId: 'tab-1', text: 'plain', reqId: 'req-1', source: 'desktop',
      hasExtensions: false, projectPath: '/proj', runOptions: opts,
    })
    expect(mocks.submitPromptMock.mock.calls[0][2].imageAttachments).toBeUndefined()
  })
})
