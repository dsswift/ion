/**
 * Tests for the slash-frontmatter → per-prompt bash-allowlist additions
 * wiring shipped by Fix 7 of the round-2 alignment plan.
 *
 * Contract pinned: when a slash command's YAML frontmatter declares an
 * `allowed_bash_commands` list, the prompt pipeline must attach those
 * commands to the resulting `IncomingPrompt` as
 * `bashAllowlistAdditionsForThisPrompt` and forward them through
 * `engineBridge.sendPrompt`. It must NOT call
 * `engineBridge.sendSetPlanMode` to mutate the session-scoped allowlist
 * — that was the previous (buggy) behavior, which leaked slash-command
 * additions into every subsequent prompt in the same session.
 *
 * Sibling to `prompt-pipeline.test.ts` for the same reason as
 * `prompt-pipeline-addenda.test.ts`: the parent file is at 584 lines and
 * any addition would push it over the 600-line TypeScript cap.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const bridgeListeners = new Map<string, Array<(key: string, event: any) => void>>()
  const sendCommandMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const sendPromptMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.({ ok: true }) ?? function () { return Promise.resolve({ ok: true }) }
  const sendSetPlanModeMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const submitPromptMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(undefined) ?? function () { return Promise.resolve() }
  const setPermissionModeMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const remoteSendMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const executeJsMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(null) ?? function () { return Promise.resolve(null) }
  const broadcastMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const expandSlashMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const clearConversationFileMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(undefined) ?? function () { return Promise.resolve() }
  const getTabStatusMock = (globalThis as any).vi?.fn?.()?.mockReturnValue?.({ conversationId: null }) ?? function () { return { conversationId: null } }
  return {
    bridgeListeners,
    sendCommandMock,
    sendPromptMock,
    sendSetPlanModeMock,
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
mocks.sendSetPlanModeMock = vi.fn()
mocks.submitPromptMock = vi.fn().mockResolvedValue(undefined)
mocks.setPermissionModeMock = vi.fn()
mocks.remoteSendMock = vi.fn()
mocks.executeJsMock = vi.fn().mockResolvedValue(null)
mocks.broadcastMock = vi.fn()
mocks.expandSlashMock = vi.fn().mockResolvedValue({ expanded: false })
mocks.clearConversationFileMock = vi.fn().mockResolvedValue(undefined)
mocks.getTabStatusMock = vi.fn().mockReturnValue({ conversationId: null })

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

vi.mock('../state', () => {
  const mockEngineBridge = {
    sendCommand: (...args: any[]) => mocks.sendCommandMock(...args),
    sendPrompt: (...args: any[]) => mocks.sendPromptMock(...args),
    sendSetPlanMode: (...args: any[]) => mocks.sendSetPlanModeMock(...args),
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

function emitBridgeEvent(key: string, event: any): void {
  const arr = mocks.bridgeListeners.get('event') ?? []
  for (const fn of arr) fn(key, event)
}

beforeEach(() => {
  mocks.sendCommandMock.mockReset()
  mocks.sendPromptMock.mockReset().mockResolvedValue({ ok: true })
  mocks.sendSetPlanModeMock.mockReset()
  mocks.submitPromptMock.mockReset().mockResolvedValue(undefined)
  mocks.setPermissionModeMock.mockReset()
  mocks.remoteSendMock.mockReset()
  mocks.executeJsMock.mockReset().mockResolvedValue(null)
  mocks.broadcastMock.mockReset()
  mocks.expandSlashMock.mockReset().mockResolvedValue({ expanded: false })
  mocks.clearConversationFileMock.mockReset().mockResolvedValue(undefined)
  mocks.getTabStatusMock.mockReset().mockReturnValue({ conversationId: null })
  mocks.bridgeListeners.clear()
  _resetAwaitersForTests()

  // The slash-classify fallback path waits for the engine to report
  // `engine_command_result` for the dispatched command, then falls
  // through to .md expansion on commandError='unknown_command'. We
  // fire the event asynchronously from the sendCommand mock so the
  // awaiter in command-await unblocks and the pipeline reaches the
  // tryExpandMarkdownSlash branch.
  mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
    setTimeout(() => emitBridgeEvent(key, {
      type: 'engine_command_result',
      command,
      commandError: 'unknown_command',
      message: `unknown command: ${command}`,
    }), 0)
  })
})

describe('processIncomingPrompt — slash-frontmatter bash-allowlist additions', () => {
  it('attaches frontmatter allowed_bash_commands to the per-prompt sendPrompt call', async () => {
    // The engine's dispatchExtensionCommand returns unknown_command, so the
    // pipeline falls back to the .md template path. The mocked
    // expandSlashCommand returns a frontmatter list of two bash command
    // prefixes — the pipeline must attach them to sendPrompt as the new
    // bashAllowlistAdditionsForThisPrompt argument (10th positional).
    mocks.expandSlashMock.mockResolvedValue({
      expanded: true,
      systemPrompt: 'review-system',
      userPrompt: 'review-body',
      frontmatter: {
        description: 'Review the changes',
        allowedBashCommands: ['gh', 'git log'],
      },
    })

    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/ion--review',
      reqId: 'req-1',
      source: 'desktop',
      isEngineTab: true,
      instanceId: 'inst-A',
      projectPath: '/proj',
    } as any)

    expect(mocks.sendPromptMock).toHaveBeenCalledTimes(1)
    const call = mocks.sendPromptMock.mock.calls[0]
    // sendPrompt signature:
    //   (key, text, model, appendSystemPrompt, imageAttachments,
    //    implementationPhase, enterPlanModeDescription,
    //    planModeSparseReminder, planFilePath, bashAllowlistAdditionsForThisPrompt)
    // The 10th positional argument (index 9) carries the per-prompt
    // additions verbatim from the frontmatter.
    expect(call[9]).toEqual(['gh', 'git log'])
  })

  it('does NOT call engineBridge.sendSetPlanMode (no session-state mutation)', async () => {
    // Before Fix 7, the pipeline merged the frontmatter list with the
    // user's global allowlist and called sendSetPlanMode to install the
    // merged result on the engine session — which then leaked across
    // every subsequent prompt in the session. This test pins the
    // replacement contract: the slash-frontmatter path must not touch
    // session state at all.
    mocks.expandSlashMock.mockResolvedValue({
      expanded: true,
      systemPrompt: 'sys',
      userPrompt: 'body',
      frontmatter: {
        allowedBashCommands: ['gh pr diff'],
      },
    })

    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/slash',
      reqId: 'req-1',
      source: 'desktop',
      isEngineTab: true,
      instanceId: 'inst-A',
      projectPath: '/proj',
    } as any)

    expect(mocks.sendSetPlanModeMock).not.toHaveBeenCalled()
  })

  it('omits the per-prompt additions argument when frontmatter has no allowed_bash_commands', async () => {
    // No allowedBashCommands in the frontmatter → the pipeline must not
    // attach anything, leaving the engine's session-level allowlist as
    // the sole source of permitted commands for the run.
    mocks.expandSlashMock.mockResolvedValue({
      expanded: true,
      systemPrompt: 'sys',
      userPrompt: 'body',
      frontmatter: {
        description: 'No bash override',
      },
    })

    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/plain',
      reqId: 'req-1',
      source: 'desktop',
      isEngineTab: true,
      instanceId: 'inst-A',
      projectPath: '/proj',
    } as any)

    expect(mocks.sendPromptMock).toHaveBeenCalledTimes(1)
    const call = mocks.sendPromptMock.mock.calls[0]
    // No additions → 10th arg is undefined.
    expect(call[9]).toBeUndefined()
    expect(mocks.sendSetPlanModeMock).not.toHaveBeenCalled()
  })
})
