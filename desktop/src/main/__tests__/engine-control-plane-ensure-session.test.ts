/**
 * EngineControlPlane.ensureSession — eager durable session start
 *
 * Split out of engine-control-plane.test.ts to keep that file under the
 * 600-line cap. Covers the unified single-start-site behavior: ensureSession
 * starts a session injecting the conversationId, is idempotent, is the only
 * start site (a prompt after an eager start does not re-start), and surfaces
 * start failures as non-ok results.
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

const mockBridge = {
  startSession: vi.fn().mockResolvedValue({ ok: true }),
  // The real bridge retains the last EngineConfig per session key; submitPrompt's
  // cwd reconciler reads it to decide whether the prompt's directory diverges
  // from the started one. Undefined here means "no recorded config", which the
  // reconciler treats as a fail-open no-op — correct for these tests, which are
  // about ensureSession's own behaviour rather than relocation.
  getSessionConfig: vi.fn(() => undefined),
  sendPrompt: vi.fn().mockResolvedValue({ ok: true }),
  sendAbort: vi.fn(),
  sendDialogResponse: vi.fn(),
  sendCommand: vi.fn(),
  sendPermissionResponse: vi.fn(),
  sendSetPlanMode: vi.fn(),
  updateSessionConversationId: vi.fn(),
  stopByPrefix: vi.fn(),
  stopSession: vi.fn(),
  disconnect: vi.fn(),
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

let uuidCounter = 0
vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto')
  return { ...actual, randomUUID: vi.fn(() => `tab-${String(++uuidCounter).padStart(3, '0')}`) }
})

import { EngineControlPlane } from '../engine-control-plane'
import { EngineBridge } from '../engine-bridge'

vi.mock('../integration/bench-prompt-context', () => ({
  benchClientWorkspaceContext: vi.fn(() => null),
  benchPromptContext: vi.fn(() => ''),
  BENCH_CONTEXT_MARKER: '## Workspace: integration bench',
}))

import { benchClientWorkspaceContext } from '../integration/bench-prompt-context'
const mockBenchCtx = vi.mocked(benchClientWorkspaceContext)

function makeRunOptions(overrides: Record<string, any> = {}): any {
  return { prompt: 'hello', projectPath: '/Users/test/project', sessionId: undefined, model: undefined, ...overrides }
}

describe('EngineControlPlane.ensureSession', () => {
  let cp: EngineControlPlane

  beforeEach(() => {
    vi.clearAllMocks()
    uuidCounter = 0
    mockBridge.startSession.mockResolvedValue({ ok: true })
    mockBridge.sendPrompt.mockResolvedValue({ ok: true })
    cp = new EngineControlPlane(new (EngineBridge as any)())
  })

  it('starts the session injecting the conversationId as sessionId', async () => {
    const tabId = cp.createTab()
    const res = await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'conv-abc' })
    expect(res.ok).toBe(true)
    expect(mockBridge.startSession).toHaveBeenCalledOnce()
    expect(mockBridge.startSession).toHaveBeenCalledWith(
      tabId,
      expect.objectContaining({ sessionId: 'conv-abc', workingDirectory: '/w' }),
    )
  })

  it('sets the normal-session recovery override from desktop settings', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'conv-recovery' })

    expect(mockBridge.startSession).toHaveBeenCalledWith(
      tabId,
      expect.objectContaining({ runRecovery: { enabled: true } }),
    )
  })

  it('leaves harness recovery policy to the engine and extension', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, {
      workingDirectory: '/w', conversationId: 'conv-harness', extensions: ['/ext/harness'],
    })

    expect(mockBridge.startSession).toHaveBeenCalledWith(
      tabId,
      expect.not.objectContaining({ runRecovery: expect.anything() }),
    )
  })

  it('is idempotent — a second call does not start again', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'conv-abc' })
    await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'conv-abc' })
    expect(mockBridge.startSession).toHaveBeenCalledOnce()
  })

  it('is the single start site — a prompt after an eager start does NOT re-start', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'conv-xyz' })
    expect(mockBridge.startSession).toHaveBeenCalledOnce()
    await cp.submitPrompt(tabId, 'req-1', makeRunOptions({ prompt: 'hi' }))
    expect(mockBridge.startSession).toHaveBeenCalledOnce()
    expect(mockBridge.sendPrompt).toHaveBeenCalledOnce()
  })

  it('surfaces a start failure as a non-ok result without throwing', async () => {
    mockBridge.startSession.mockResolvedValue({ ok: false, error: 'boom' })
    const tabId = cp.createTab()
    const res = await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'c' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('boom')
  })

  it('passes clientWorkspaceContext to startSession when cwd is inside a bench', async () => {
    const benchCtx = {
      kind: 'bench',
      cwd: '/Users/test/.ion/integration/my-bench',
      bench: { benchPath: '/Users/test/.ion/integration/my-bench' } as Record<string, unknown>,
      text: '## Workspace: integration bench\n\nBench prose.',
    }
    mockBenchCtx.mockReturnValue(benchCtx)

    const tabId = cp.createTab()
    await cp.ensureSession(tabId, {
      workingDirectory: '/Users/test/.ion/integration/my-bench',
      conversationId: 'conv-bench',
    })

    expect(mockBenchCtx).toHaveBeenCalledWith('/Users/test/.ion/integration/my-bench')
    expect(mockBridge.startSession).toHaveBeenCalledWith(
      tabId,
      expect.objectContaining({ clientWorkspaceContext: benchCtx }),
    )
  })

  it('omits clientWorkspaceContext when cwd is not inside a bench', async () => {
    mockBenchCtx.mockReturnValue(null)

    const tabId = cp.createTab()
    await cp.ensureSession(tabId, {
      workingDirectory: '/Users/test/regular-project',
      conversationId: 'conv-regular',
    })

    expect(mockBenchCtx).toHaveBeenCalledWith('/Users/test/regular-project')
    const config = mockBridge.startSession.mock.calls[0][1]
    expect(config.clientWorkspaceContext).toBeUndefined()
  })

  // ── Status resync ─────────────────────────────────────────────────────────
  //
  // Every client of this plane writes an optimistic 'connecting' before asking
  // for a session, and clears it only on an inbound tab-status-change. A tab
  // whose entry has rested at 'idle' since createTab gets no transition when its
  // session comes online (_setStatus no-ops on an unchanged status), so without
  // an explicit resync the client's 'connecting' is never answered: an eager
  // restore or a fresh worktree conversation renders an indefinite connecting
  // spinner with a blocked composer while the plane believes the tab is idle.

  it('re-asserts the current status when the session comes online', async () => {
    const seen: Array<[string, string, string]> = []
    const tabId = cp.createTab()
    cp.on('tab-status-change', (id: string, next: string, prev: string) => { seen.push([id, next, prev]) })

    await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'conv-resync' })

    expect(seen).toEqual([[tabId, 'idle', 'idle']])
  })

  it('re-asserts the current status on the already-started no-op path', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'conv-resync-2' })

    const seen: Array<[string, string, string]> = []
    cp.on('tab-status-change', (id: string, next: string, prev: string) => { seen.push([id, next, prev]) })
    await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'conv-resync-2' })

    expect(mockBridge.startSession).toHaveBeenCalledOnce()
    expect(seen).toEqual([[tabId, 'idle', 'idle']])
  })

  it('does not emit a resync for a start failure — the status is not authoritative', async () => {
    mockBridge.startSession.mockResolvedValue({ ok: false, error: 'boom' })
    const seen: string[] = []
    const tabId = cp.createTab()
    cp.on('tab-status-change', (_id: string, next: string) => { seen.push(next) })

    const res = await cp.ensureSession(tabId, { workingDirectory: '/w', conversationId: 'conv-fail' })

    expect(res.ok).toBe(false)
    expect(seen).toEqual([])
  })
})
