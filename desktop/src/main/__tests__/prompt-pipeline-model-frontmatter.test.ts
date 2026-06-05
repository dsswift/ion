/**
 * Tests for the slash-frontmatter → `RunOptions.Model` (and engine-tab
 * `p.model`) wiring shipped by the `model:` frontmatter feature.
 *
 * Contract pinned: when a slash command's YAML frontmatter declares a
 * `model:` key, the prompt pipeline must forward the value verbatim
 * onto the per-prompt `model` field — onto `p.runOptions.model` for
 * the CLI path and onto `p.model` for the engine-tab path — UNLESS
 * the caller has already supplied an explicit per-prompt override,
 * in which case the explicit value is preserved (no-stomp policy).
 *
 * The desktop deliberately does NOT resolve the value: the engine
 * walks tier → literal → `defaultModel` via
 * `modelconfig.ResolveTierChain` (`engine/internal/session/prompt_options.go`)
 * and `runloop.go`'s unknown-model fallback. The tests below pin only
 * the desktop's plumbing contribution.
 *
 * Sibling to `prompt-pipeline-bash-additions.test.ts`. The mock
 * posture is intentionally identical so the two files can be diffed
 * side-by-side and only the frontmatter-key / expected-call-arg
 * fields differ.
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

  // The pipeline dispatches the slash to the engine first; the engine
  // replies unknown_command, and the pipeline then falls through to
  // the .md template path. We emit the result asynchronously from
  // sendCommand so the await in command-await unblocks and the
  // expansion branch runs.
  mocks.sendCommandMock.mockImplementation((key: string, command: string) => {
    setTimeout(() => emitBridgeEvent(key, {
      type: 'engine_command_result',
      command,
      commandError: 'unknown_command',
      message: `unknown command: ${command}`,
    }), 0)
  })
})

describe('processIncomingPrompt — slash-frontmatter model hint (engine-tab path)', () => {
  it('applies frontmatter model onto p.model when no explicit override is supplied', async () => {
    // Frontmatter `model: smart` reaches the engine as RunOptions.Model
    // (3rd positional arg to sendPrompt, index 2). The engine then walks
    // tier → literal → defaultModel; the desktop's job ends at "forward
    // the value verbatim". The pipeline must NOT pre-resolve the tier
    // alias — that's deliberately left to the engine so a single
    // ~/.ion/models.json change applies uniformly to every consumer.
    mocks.expandSlashMock.mockResolvedValue({
      expanded: true,
      systemPrompt: 'sys',
      userPrompt: 'body',
      frontmatter: {
        description: 'Open an issue',
        model: 'smart',
      },
    })

    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/create-issue feature foo',
      reqId: 'req-1',
      source: 'desktop',
      isEngineTab: true,
      instanceId: 'inst-A',
      projectPath: '/proj',
    } as any)

    expect(mocks.sendPromptMock).toHaveBeenCalledTimes(1)
    const call = mocks.sendPromptMock.mock.calls[0]
    // sendPrompt(key, text, model, ...) — index 2 carries RunOptions.Model.
    expect(call[2]).toBe('smart')
  })

  it('preserves an explicit p.model override (no-stomp policy)', async () => {
    // The renderer or harness can set an explicit model for one prompt
    // (e.g. a "use opus for this specific request" affordance). That
    // value must win over the slash-command's frontmatter hint — the
    // hint is a default, not a directive.
    mocks.expandSlashMock.mockResolvedValue({
      expanded: true,
      systemPrompt: 'sys',
      userPrompt: 'body',
      frontmatter: {
        model: 'smart', // frontmatter says smart
      },
    })

    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/create-issue',
      reqId: 'req-1',
      source: 'desktop',
      isEngineTab: true,
      instanceId: 'inst-A',
      projectPath: '/proj',
      model: 'claude-opus-4-7', // explicit override wins
    } as any)

    expect(mocks.sendPromptMock).toHaveBeenCalledTimes(1)
    const call = mocks.sendPromptMock.mock.calls[0]
    expect(call[2]).toBe('claude-opus-4-7')
  })

  it('leaves model undefined when frontmatter has no model key', async () => {
    // Most commands won't declare a model hint. The pipeline must
    // pass through whatever the caller supplied (undefined here) so
    // the engine resolves via the session default. This pins the
    // "absence is meaningful" semantic — we never inject a default
    // value on the desktop side.
    mocks.expandSlashMock.mockResolvedValue({
      expanded: true,
      systemPrompt: 'sys',
      userPrompt: 'body',
      frontmatter: {
        description: 'No model hint',
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
    expect(call[2]).toBeUndefined()
  })
})

describe('processIncomingPrompt — slash-frontmatter model hint (CLI path)', () => {
  // The CLI path goes through sessionPlane.submitPrompt rather than
  // engineBridge.sendPrompt. The slash-expansion mutates
  // p.runOptions.prompt in place, and the model hint must land on
  // p.runOptions.model so EngineControlPlane.submitPrompt picks it up.

  function makeRunOptions(overrides: Record<string, unknown> = {}): any {
    return {
      prompt: '',
      projectPath: '/proj',
      // realistic placeholders for the fields the pipeline doesn't read
      maxTokens: 0,
      ...overrides,
    }
  }

  it('applies frontmatter model onto p.runOptions.model when no explicit override is supplied', async () => {
    mocks.expandSlashMock.mockResolvedValue({
      expanded: true,
      systemPrompt: 'sys',
      userPrompt: 'body',
      frontmatter: {
        model: 'smart',
      },
    })

    const runOptions = makeRunOptions()
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/create-issue',
      reqId: 'req-1',
      source: 'desktop',
      isEngineTab: false, // CLI path
      projectPath: '/proj',
      runOptions,
    } as any)

    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    // sessionPlane.submitPrompt(tabId, requestId, runOptions); index 2
    // is the RunOptions object. We assert against that object directly
    // because the pipeline mutates it in place during expansion.
    const submitCall = mocks.submitPromptMock.mock.calls[0]
    expect(submitCall[2]).toBe(runOptions)
    expect(runOptions.model).toBe('smart')
  })

  it('preserves an explicit runOptions.model override (no-stomp policy)', async () => {
    mocks.expandSlashMock.mockResolvedValue({
      expanded: true,
      systemPrompt: 'sys',
      userPrompt: 'body',
      frontmatter: {
        model: 'smart',
      },
    })

    const runOptions = makeRunOptions({ model: 'claude-opus-4-7' })
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/create-issue',
      reqId: 'req-1',
      source: 'desktop',
      isEngineTab: false,
      projectPath: '/proj',
      runOptions,
    } as any)

    expect(runOptions.model).toBe('claude-opus-4-7')
  })

  it('leaves runOptions.model untouched when frontmatter has no model key', async () => {
    mocks.expandSlashMock.mockResolvedValue({
      expanded: true,
      systemPrompt: 'sys',
      userPrompt: 'body',
      frontmatter: {
        description: 'No model hint',
      },
    })

    const runOptions = makeRunOptions()
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: '/plain',
      reqId: 'req-1',
      source: 'desktop',
      isEngineTab: false,
      projectPath: '/proj',
      runOptions,
    } as any)

    expect(runOptions.model).toBeUndefined()
  })
})
