/**
 * Tests for `applyHarnessSystemPromptAddenda` — the helper that injects
 * harness-owned system-prompt addenda at the converging dispatch point
 * of the prompt pipeline. The addenda themselves are an ordered list; the
 * cases below assert the joined block, per-addendum idempotency, and the
 * ordering, so adding a fourth addendum fails here until it is declared.
 *
 * What this file covers
 * ─────────────────────
 *   1. Extension-hosted path (`engineBridge.sendPrompt`):
 *      - undefined input → guidance alone is sent
 *      - non-empty input ("voice mode") → `"voice mode\n\n<guidance>"` sent
 *      - already-tailed input → idempotent, no double-append
 *   2. CLI desktop path (`sessionPlane.submitPrompt`):
 *      - guidance is appended to `runOptions.appendSystemPrompt`
 *
 * The slash-expansion path (which sets `runOptions.appendSystemPrompt`
 * from a `.md` template's `systemPrompt` field, then dispatches through
 * `submitAsPrompt`) is exercised in `prompt-pipeline.test.ts` so the
 * existing slash-expansion test pins the "expansion + guidance" join.
 *
 * Why this is a sibling file rather than appended to
 * `prompt-pipeline.test.ts`
 * ─────────────────────────────────────────────────
 * The parent file was at 561 lines before this work; the four addenda
 * cases would push it over the 600-line TypeScript cap. Split into a
 * sibling following the precedent set by `prompt-pipeline-plan-mode`,
 * `prompt-pipeline-convergence`, and `prompt-pipeline-clear-wipe`.
 *
 * Mock pattern
 * ────────────
 * Replicated from `prompt-pipeline.test.ts` (vi.hoisted + vi.mock on
 * `../state` and friends). Each sibling test file owns its own mock
 * state because `vi.mock` is module-scoped — sharing mocks across
 * files would require a setupFiles wiring that no other sibling does.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ───────────────────────────────────────────────────────────────────────────
// Mocks — same vi.hoisted pattern as prompt-pipeline.test.ts.
// ───────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const bridgeListeners = new Map<string, Array<(_key: string, _event: any) => void>>()
  const sendCommandMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const sendPromptMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.({ ok: true }) ?? function () { return Promise.resolve({ ok: true }) }
  const submitPromptMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(undefined) ?? function () { return Promise.resolve() }
  const setPermissionModeMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const remoteSendMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const executeJsMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(null) ?? function () { return Promise.resolve(null) }
  const broadcastMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const clearConversationFileMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(undefined) ?? function () { return Promise.resolve() }
  const getTabStatusMock = (globalThis as any).vi?.fn?.()?.mockReturnValue?.({ conversationId: null }) ?? function () { return { conversationId: null } }
  const benchClientWorkspaceContextMock = (globalThis as any).vi?.fn?.()?.mockReturnValue?.(null) ?? function () { return null }
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
    benchClientWorkspaceContextMock,
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
mocks.getTabStatusMock = vi.fn().mockReturnValue({ conversationId: null })
mocks.benchClientWorkspaceContextMock = vi.fn().mockReturnValue(null)

vi.mock('../state', () => {
  const mockEngineBridge = {
    sendCommand: (...args: any[]) => mocks.sendCommandMock(...args),
    sendPrompt: (...args: any[]) => mocks.sendPromptMock(...args),
    clearConversationFile: (...args: any[]) => mocks.clearConversationFileMock(...args),
    on: (name: string, fn: (_key: string, _event: any) => void) => {
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

vi.mock('../integration/bench-prompt-context', () => ({
  benchClientWorkspaceContext: (...args: any[]) => mocks.benchClientWorkspaceContextMock(...args),
  benchPromptContext: () => '',
  BENCH_CONTEXT_MARKER: '<!-- bench-context -->',
}))

import { processIncomingPrompt } from '../prompt-pipeline'
import { _resetAwaitersForTests } from '../command-await'
import { TURN_GROUPING_GUIDANCE } from '../turn-grouping-guidance'
import { ASK_USER_QUESTIONS_GUIDANCE } from '../questions/questions-tool-decl'
import { TOOL_BATCHING_GUIDANCE } from '../tool-batching-guidance'

// The full ordered addendum block the pipeline appends (see
// SYSTEM_PROMPT_ADDENDA in prompt-pipeline.ts).
const ALL_ADDENDA = [
  TURN_GROUPING_GUIDANCE,
  ASK_USER_QUESTIONS_GUIDANCE,
  TOOL_BATCHING_GUIDANCE,
].join('\n\n')

beforeEach(() => {
  mocks.sendCommandMock.mockReset()
  mocks.sendPromptMock.mockReset().mockResolvedValue({ ok: true })
  mocks.submitPromptMock.mockReset().mockResolvedValue(undefined)
  mocks.setPermissionModeMock.mockReset()
  mocks.remoteSendMock.mockReset()
  mocks.executeJsMock.mockReset().mockResolvedValue(null)
  mocks.broadcastMock.mockReset()
  mocks.clearConversationFileMock.mockReset().mockResolvedValue(undefined)
  mocks.getTabStatusMock.mockReset().mockReturnValue({ conversationId: null })
  mocks.benchClientWorkspaceContextMock.mockReset().mockReturnValue(null)
  mocks.bridgeListeners.clear()
  _resetAwaitersForTests()
})

describe('processIncomingPrompt — harness system-prompt addenda (turn-grouping guidance)', () => {
  it('appends the guidance to the RunOptions when no upstream addendum exists', async () => {
    // Desktop-source extension-hosted tab, non-slash text, no incoming appendSystemPrompt.
    // The unified submitPrompt RunOptions should carry the guidance alone.
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-addenda-1',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'inst-x',
      runOptions: { prompt: 'hello', projectPath: '/tmp', extensions: ['ext-a'] },
    })
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    const opts = mocks.submitPromptMock.mock.calls[0][2]
    expect(opts.appendSystemPrompt).toBe(ALL_ADDENDA)
  })

  it('appends the guidance after an existing upstream addendum with a \\n\\n separator', async () => {
    // Desktop-source extension-hosted tab with a voice-mode-style upstream addendum on
    // RunOptions. The pipeline preserves the upstream text and appends the
    // guidance after a blank-line separator.
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-addenda-2',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'inst-x',
      runOptions: { prompt: 'hello', projectPath: '/tmp', extensions: ['ext-a'], appendSystemPrompt: 'voice mode' },
    })
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    const opts = mocks.submitPromptMock.mock.calls[0][2]
    expect(opts.appendSystemPrompt).toBe(`voice mode\n\n${ALL_ADDENDA}`)
  })

  it('is idempotent — does not double-append when re-invoked on already-guidance-tailed input', async () => {
    // The iOS-engine path bounces through the renderer once. Without the
    // per-addendum includes() guard, every block would appear twice. This
    // simulates the second invocation directly (guidance already present on
    // RunOptions) and asserts no duplication.
    const alreadyTailed = `voice mode\n\n${ALL_ADDENDA}`
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-addenda-3',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'inst-x',
      runOptions: { prompt: 'hello', projectPath: '/tmp', extensions: ['ext-a'], appendSystemPrompt: alreadyTailed },
    })
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    const sentAppendSystemPrompt = mocks.submitPromptMock.mock.calls[0][2].appendSystemPrompt
    expect(sentAppendSystemPrompt).toBe(alreadyTailed)
    // Belt-and-suspenders: count occurrences of the guidance text in
    // the final string. Must be exactly one.
    const turnOccurrences = sentAppendSystemPrompt.split(TURN_GROUPING_GUIDANCE).length - 1
    expect(turnOccurrences).toBe(1)
    const questionsOccurrences = sentAppendSystemPrompt.split(ASK_USER_QUESTIONS_GUIDANCE).length - 1
    expect(questionsOccurrences).toBe(1)
    const batchingOccurrences = sentAppendSystemPrompt.split(TOOL_BATCHING_GUIDANCE).length - 1
    expect(batchingOccurrences).toBe(1)
  })

  it('per-addendum idempotency: a partially-tailed input gains only the missing addendum', async () => {
    // The old single .endsWith() guard could not protect anything but the
    // LAST block; this pins the ordered-list refactor: input already carrying
    // the turn-grouping guidance gains only the blocks it is missing, in
    // declaration order.
    const partiallyTailed = `voice mode\n\n${TURN_GROUPING_GUIDANCE}`
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-addenda-partial',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'inst-x',
      runOptions: { prompt: 'hello', projectPath: '/tmp', extensions: ['ext-a'], appendSystemPrompt: partiallyTailed },
    })
    const sent = mocks.submitPromptMock.mock.calls[0][2].appendSystemPrompt
    expect(sent).toBe(`${partiallyTailed}\n\n${ASK_USER_QUESTIONS_GUIDANCE}\n\n${TOOL_BATCHING_GUIDANCE}`)
  })

  it('sends the tool-batching guidance, telling the model to group independent calls', async () => {
    // The behaviour this addendum exists to correct: a model with no
    // instruction on the subject emits one tool call per assistant message,
    // which on an editing task costs one full-context round trip per edit.
    // Assert the block is actually dispatched and carries both of its
    // directives -- batch independent calls, and edit whole regions.
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-addenda-batching',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'inst-x',
      runOptions: { prompt: 'hello', projectPath: '/tmp', extensions: ['ext-a'] },
    })
    const sent = mocks.submitPromptMock.mock.calls[0][2].appendSystemPrompt
    expect(sent).toContain(TOOL_BATCHING_GUIDANCE)
    expect(TOOL_BATCHING_GUIDANCE).toContain('Independent tool calls belong in one message')
    expect(TOOL_BATCHING_GUIDANCE).toContain('Edit at the altitude of the change')
  })

  it('keeps the tool-batching guidance byte-identical across calls so it stays cacheable', async () => {
    // The addendum sits in the prompt-cache prefix only while it is
    // byte-identical every turn. A templated or per-turn-varying block would
    // move it outside the prefix and bill it on every call.
    const send = async (reqId: string): Promise<string> => {
      mocks.submitPromptMock.mockClear()
      await processIncomingPrompt({
        tabId: 'tab-1',
        text: 'hello',
        reqId,
        source: 'desktop',
        hasExtensions: true,
        instanceId: 'inst-x',
        runOptions: { prompt: 'hello', projectPath: '/tmp', extensions: ['ext-a'] },
      })
      return mocks.submitPromptMock.mock.calls[0][2].appendSystemPrompt
    }
    expect(await send('req-cache-1')).toBe(await send('req-cache-2'))
  })

  it('appends the guidance to runOptions.appendSystemPrompt for desktop CLI prompts', async () => {
    // CLI desktop path: the pipeline reads runOptions and forwards
    // them to sessionPlane.submitPrompt. The addenda must land on
    // runOptions.appendSystemPrompt, not p.appendSystemPrompt, so the
    // CLI dispatch sees it.
    const opts: any = { prompt: 'hello', projectPath: '/proj', source: 'desktop' }
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-addenda-4',
      source: 'desktop',
      hasExtensions: false,
      runOptions: opts,
    })
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    expect(opts.appendSystemPrompt).toBe(ALL_ADDENDA)
  })
})

describe('processIncomingPrompt — clientWorkspaceContext injection', () => {
  const BENCH_CTX = {
    kind: 'bench',
    cwd: '/ion/integration/ion-josh',
    bench: { path: '/ion/integration/ion-josh', branch: 'josh', members: [] },
    text: '<!-- bench-context -->',
  }

  it('sets clientWorkspaceContext on RunOptions when benchClientWorkspaceContext returns non-null', async () => {
    mocks.benchClientWorkspaceContextMock.mockReturnValue(BENCH_CTX)
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-wsc-1',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'inst-x',
      projectPath: '/ion/integration/ion-josh',
      runOptions: { prompt: 'hello', projectPath: '/ion/integration/ion-josh', extensions: ['ext-a'] },
    })
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    const opts = mocks.submitPromptMock.mock.calls[0][2]
    expect(opts.clientWorkspaceContext).toEqual(BENCH_CTX)
    expect(mocks.benchClientWorkspaceContextMock).toHaveBeenCalledWith('/ion/integration/ion-josh')
  })

  it('does not overwrite a preexisting clientWorkspaceContext on RunOptions', async () => {
    const preexisting = { kind: 'custom', cwd: '/custom', text: 'pre' }
    mocks.benchClientWorkspaceContextMock.mockReturnValue(BENCH_CTX)
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-wsc-2',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'inst-x',
      projectPath: '/ion/integration/ion-josh',
      runOptions: {
        prompt: 'hello', projectPath: '/ion/integration/ion-josh',
        extensions: ['ext-a'], clientWorkspaceContext: preexisting as any,
      },
    })
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    const opts = mocks.submitPromptMock.mock.calls[0][2]
    expect(opts.clientWorkspaceContext).toEqual(preexisting)
    expect(mocks.benchClientWorkspaceContextMock).not.toHaveBeenCalled()
  })

  it('omits clientWorkspaceContext for non-bench directories', async () => {
    mocks.benchClientWorkspaceContextMock.mockReturnValue(null)
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-wsc-3',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'inst-x',
      projectPath: '/plain/project',
      runOptions: { prompt: 'hello', projectPath: '/plain/project', extensions: ['ext-a'] },
    })
    expect(mocks.submitPromptMock).toHaveBeenCalledTimes(1)
    const opts = mocks.submitPromptMock.mock.calls[0][2]
    expect(opts.clientWorkspaceContext).toBeUndefined()
  })

  it('is idempotent on remote bounce — context set once, not duplicated', async () => {
    mocks.benchClientWorkspaceContextMock.mockReturnValue(BENCH_CTX)
    // First pass: desktop source sets the context.
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-wsc-4a',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'inst-x',
      projectPath: '/ion/integration/ion-josh',
      runOptions: { prompt: 'hello', projectPath: '/ion/integration/ion-josh', extensions: ['ext-a'] },
    })
    const firstOpts = mocks.submitPromptMock.mock.calls[0][2]
    expect(firstOpts.clientWorkspaceContext).toEqual(BENCH_CTX)
    // The guard is: if clientWorkspaceContext is already set, do not call
    // benchClientWorkspaceContext again. Simulate the second pass by passing
    // RunOptions that already carry the context (as the bounce would).
    mocks.submitPromptMock.mockReset().mockResolvedValue(undefined)
    mocks.benchClientWorkspaceContextMock.mockReset().mockReturnValue(BENCH_CTX)
    await processIncomingPrompt({
      tabId: 'tab-1',
      text: 'hello',
      reqId: 'req-wsc-4b',
      source: 'desktop',
      hasExtensions: true,
      instanceId: 'inst-x',
      projectPath: '/ion/integration/ion-josh',
      runOptions: {
        prompt: 'hello', projectPath: '/ion/integration/ion-josh',
        extensions: ['ext-a'], clientWorkspaceContext: BENCH_CTX as any,
      },
    })
    expect(mocks.benchClientWorkspaceContextMock).not.toHaveBeenCalled()
    const secondOpts = mocks.submitPromptMock.mock.calls[0][2]
    expect(secondOpts.clientWorkspaceContext).toEqual(BENCH_CTX)
  })
})
