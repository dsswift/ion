/**
 * submitPrompt reconciles a diverged session working directory.
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 * Five worktree conversations ran in the shared base checkout because the
 * desktop pre-started each session in the repo (before the worktree existed),
 * then patched only renderer state when the worktree arrived. Every subsequent
 * prompt carried the correct worktree path into `config.workingDirectory` and
 * `submitPrompt` DISCARDED it, because its only start site is guarded by
 * `if (!tab.engineSessionStarted)` — already true for a live session.
 *
 * On the unfixed code the assertion below fails in the most direct way
 * possible: `startSession` is called exactly once, with the repo path, and the
 * prompt goes out against it. With the fix there is a second `startSession`
 * carrying the worktree, and it happens BEFORE the prompt is sent.
 *
 * This is the integration counterpart to engine-control-plane-cwd.test.ts,
 * which pins the reconciler's decision table in isolation. This file proves the
 * prompt path is actually wired to it.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

/**
 * The bridge stub tracks the config of each start so the test can assert which
 * directory a session was started with, and records call ordering across
 * startSession/sendPrompt so "relocated before sending" is provable rather
 * than inferred.
 */
const callOrder: string[] = []
const startedConfigs = new Map<string, { workingDirectory: string }>()

const mockBridge = {
  startSession: vi.fn(async (key: string, config: { workingDirectory: string }) => {
    callOrder.push(`startSession:${config.workingDirectory}`)
    startedConfigs.set(key, { ...config })
    return { ok: true }
  }),
  // The real bridge retains the last EngineConfig per key; the reconciler reads
  // it through getSessionConfig, so the stub must model that retention.
  getSessionConfig: vi.fn((key: string) => {
    const c = startedConfigs.get(key)
    return c ? { ...c } : undefined
  }),
  sendPrompt: vi.fn(async () => {
    callOrder.push('sendPrompt')
    return { ok: true }
  }),
  sendAbort: vi.fn(),
  sendDialogResponse: vi.fn(),
  sendCommand: vi.fn(),
  sendPermissionResponse: vi.fn(),
  sendSetPlanMode: vi.fn(),
  updateSessionConversationId: vi.fn(),
  stopByPrefix: vi.fn(),
  stopSession: vi.fn(async () => undefined),
  stopAll: vi.fn(),
  on: vi.fn(),
  emit: vi.fn(),
  removeListener: vi.fn(),
  removeAllListeners: vi.fn(),
}

vi.mock('../engine-bridge', () => ({
  EngineBridge: function () { return mockBridge },
}))

vi.mock('../engine-bridge-fs', () => ({
  engineIsRemote: vi.fn(() => false),
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: false, error: 'not used' })),
  listEngineDirectory: vi.fn(() => Promise.resolve({ ok: false, error: 'not used' })),
}))

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { EngineControlPlane } from '../engine-control-plane'
import { EngineBridge } from '../engine-bridge'
import type { RunOptions } from '../../shared/types'

const REPO = '/Users/test/project'
const WORKTREE = '/Users/test/.ion/worktrees/project-a3f1'

function runOptions(projectPath: string): RunOptions {
  return { prompt: 'do the thing', projectPath } as RunOptions
}

describe('submitPrompt working-directory reconciliation', () => {
  let cp: EngineControlPlane

  beforeEach(() => {
    vi.clearAllMocks()
    callOrder.length = 0
    startedConfigs.clear()
    cp = new EngineControlPlane(new (EngineBridge as any)())
  })

  it('relocates the session when the prompt targets a different directory', async () => {
    // Arrange: the exact production shape of the bug — a session eagerly
    // started in the REPO, as the pre-worktree create path did.
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: REPO, conversationId: 'conv-1' })
    expect(mockBridge.startSession).toHaveBeenCalledOnce()

    // Act: a prompt arrives carrying the WORKTREE, as send-slice computes it
    // from tab.workingDirectory after the worktree was attached.
    await cp.submitPrompt(tabId, 'req-1', runOptions(WORKTREE))

    // Assert: a second start carried the worktree …
    expect(mockBridge.startSession).toHaveBeenCalledTimes(2)
    expect(mockBridge.startSession.mock.calls[1][1].workingDirectory).toBe(WORKTREE)
    // … and it happened BEFORE the prompt went out, so the run executes in the
    // worktree rather than the directory the session was born in.
    expect(callOrder).toEqual([
      `startSession:${REPO}`,
      `startSession:${WORKTREE}`,
      'sendPrompt',
    ])
  })

  it('carries the same conversation across the relocation', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: REPO, conversationId: 'conv-keep-me' })

    await cp.submitPrompt(tabId, 'req-1', runOptions(WORKTREE))

    // The relocation must resume, not mint: the operator's history survives.
    expect(mockBridge.startSession.mock.calls[1][1].sessionId).toBe('conv-keep-me')
    expect(cp.getTabStatus(tabId)?.conversationId).toBe('conv-keep-me')
  })

  it('does not restart when the prompt directory already matches', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: WORKTREE, conversationId: 'conv-1' })

    await cp.submitPrompt(tabId, 'req-1', runOptions(WORKTREE))

    // One start only — the reconciler must not churn the session on every
    // prompt in the common case.
    expect(mockBridge.startSession).toHaveBeenCalledOnce()
    expect(callOrder).toEqual([`startSession:${WORKTREE}`, 'sendPrompt'])
  })

  it('still starts a never-started session exactly once', async () => {
    // The reconciler must stay out of the way of the normal first-prompt start
    // path: no double start, and the prompt's directory is what gets used.
    const tabId = cp.createTab()

    await cp.submitPrompt(tabId, 'req-1', runOptions(WORKTREE))

    expect(mockBridge.startSession).toHaveBeenCalledOnce()
    expect(mockBridge.startSession.mock.calls[0][1].workingDirectory).toBe(WORKTREE)
    expect(callOrder).toEqual([`startSession:${WORKTREE}`, 'sendPrompt'])
  })
})
