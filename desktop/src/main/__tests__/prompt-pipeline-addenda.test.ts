/**
 * Tests for `applyHarnessSystemPromptAddenda` — the helper that injects
 * harness-owned system-prompt addenda (currently just
 * `TURN_GROUPING_GUIDANCE`) at the converging dispatch point of the
 * prompt pipeline.
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
  const bridgeListeners = new Map<string, Array<(key: string, event: any) => void>>()
  const sendCommandMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const sendPromptMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.({ ok: true }) ?? function () { return Promise.resolve({ ok: true }) }
  const submitPromptMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(undefined) ?? function () { return Promise.resolve() }
  const setPermissionModeMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const remoteSendMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const executeJsMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(null) ?? function () { return Promise.resolve(null) }
  const broadcastMock = (globalThis as any).vi?.fn?.() ?? function () {}
  const clearConversationFileMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(undefined) ?? function () { return Promise.resolve() }
  const getTabStatusMock = (globalThis as any).vi?.fn?.()?.mockReturnValue?.({ conversationId: null }) ?? function () { return { conversationId: null } }
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
mocks.getTabStatusMock = vi.fn().mockReturnValue({ conversationId: null })

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
import { TURN_GROUPING_GUIDANCE } from '../turn-grouping-guidance'

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
    expect(opts.appendSystemPrompt).toBe(TURN_GROUPING_GUIDANCE)
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
    expect(opts.appendSystemPrompt).toBe(`voice mode\n\n${TURN_GROUPING_GUIDANCE}`)
  })

  it('is idempotent — does not double-append when re-invoked on already-guidance-tailed input', async () => {
    // The iOS-engine path bounces through the renderer once. Without the
    // endsWith() guard, the guidance would appear twice. This simulates the
    // second invocation directly (guidance already present on RunOptions) and
    // asserts no duplication.
    const alreadyTailed = `voice mode\n\n${TURN_GROUPING_GUIDANCE}`
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
    const occurrences = sentAppendSystemPrompt.split(TURN_GROUPING_GUIDANCE).length - 1
    expect(occurrences).toBe(1)
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
    expect(opts.appendSystemPrompt).toBe(TURN_GROUPING_GUIDANCE)
  })
})
