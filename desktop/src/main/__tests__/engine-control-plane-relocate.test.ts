/**
 * EngineControlPlane.relocateSession — move a live conversation to a new
 * working directory without cutting a new conversation.
 *
 * The behavior under test is the one that lets a conversation outlive its
 * worktree: the conversationId and its history survive the move, and the
 * engine is re-started in the NEW directory. Before this existed, the only
 * way to change a tab's directory was resetTabSession (which nulls
 * conversationId by design), so the worktree "Finish work" flow had to close
 * the conversation.
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
  sendPrompt: vi.fn().mockResolvedValue({ ok: true }),
  sendAbort: vi.fn(),
  sendDialogResponse: vi.fn(),
  sendCommand: vi.fn(),
  sendPermissionResponse: vi.fn(),
  sendSetPlanMode: vi.fn(),
  updateSessionConversationId: vi.fn(),
  stopByPrefix: vi.fn(),
  stopSession: vi.fn().mockResolvedValue(undefined),
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

const WORKTREE = '/Users/test/.ion/worktrees/project-a3f1'
const REPO_ROOT = '/Users/test/project'

describe('EngineControlPlane.relocateSession', () => {
  let cp: EngineControlPlane

  beforeEach(() => {
    vi.clearAllMocks()
    uuidCounter = 0
    mockBridge.startSession.mockResolvedValue({ ok: true })
    mockBridge.stopSession.mockResolvedValue(undefined)
    cp = new EngineControlPlane(new (EngineBridge as any)())
  })

  // The core guarantee. On the old world (resetTabSession) the conversation id
  // would be null after the move and the engine would mint a fresh one.
  it('preserves conversationId and restarts in the new directory', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: WORKTREE, conversationId: 'conv-keep-me' })
    expect(mockBridge.startSession).toHaveBeenCalledOnce()

    const res = await cp.relocateSession(tabId, REPO_ROOT)

    expect(res.ok).toBe(true)
    expect(res.conversationId).toBe('conv-keep-me')
    // A second start happened (the transport was recycled) …
    expect(mockBridge.startSession).toHaveBeenCalledTimes(2)
    // … carrying the SAME conversation into the NEW directory.
    expect(mockBridge.startSession).toHaveBeenLastCalledWith(
      tabId,
      expect.objectContaining({ sessionId: 'conv-keep-me', workingDirectory: REPO_ROOT }),
    )
    // The tracked entry still owns the conversation.
    expect(cp.getTabStatus(tabId)?.conversationId).toBe('conv-keep-me')
  })

  it('stops the old session before restarting', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: WORKTREE, conversationId: 'conv-1' })

    await cp.relocateSession(tabId, REPO_ROOT)

    expect(mockBridge.stopSession).toHaveBeenCalledWith(tabId)
  })

  // Relocation must clear engineSessionStarted, otherwise ensureSession
  // no-ops and the tab keeps running in the old (possibly deleted) directory.
  it('actually re-starts rather than no-opping on the already-started flag', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: WORKTREE, conversationId: 'conv-1' })
    mockBridge.startSession.mockClear()

    await cp.relocateSession(tabId, REPO_ROOT)

    expect(mockBridge.startSession).toHaveBeenCalledOnce()
  })

  it('carries the permission mode across the move', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: WORKTREE, conversationId: 'conv-1', permissionMode: 'plan' })
    mockBridge.sendSetPlanMode.mockClear()

    await cp.relocateSession(tabId, REPO_ROOT)

    // ensureSession re-asserts plan mode on the restarted session.
    expect(mockBridge.sendSetPlanMode).toHaveBeenCalledWith(tabId, true, undefined, 'session_start')
  })

  it('relocates a tab that has no conversation yet', async () => {
    const tabId = cp.createTab()

    const res = await cp.relocateSession(tabId, REPO_ROOT)

    expect(res.ok).toBe(true)
    expect(mockBridge.startSession).toHaveBeenCalledWith(
      tabId,
      expect.objectContaining({ workingDirectory: REPO_ROOT }),
    )
  })

  it('returns a non-ok result for an unknown tab without throwing', async () => {
    const res = await cp.relocateSession('no-such-tab', REPO_ROOT)

    expect(res.ok).toBe(false)
    expect(res.error).toContain('no-such-tab')
    expect(mockBridge.startSession).not.toHaveBeenCalled()
  })

  it('refuses an empty target directory', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: WORKTREE, conversationId: 'conv-1' })
    mockBridge.startSession.mockClear()

    const res = await cp.relocateSession(tabId, '')

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/target working directory/i)
    expect(mockBridge.startSession).not.toHaveBeenCalled()
  })

  // A failed restart must surface, not silently leave the tab wedged: the
  // caller (retire flow) decides whether to remove the worktree based on this.
  it('surfaces a restart failure and reports the conversation it was carrying', async () => {
    const tabId = cp.createTab()
    await cp.ensureSession(tabId, { workingDirectory: WORKTREE, conversationId: 'conv-1' })
    mockBridge.startSession.mockResolvedValue({ ok: false, error: 'engine down' })

    const res = await cp.relocateSession(tabId, REPO_ROOT)

    expect(res.ok).toBe(false)
    expect(res.error).toBe('engine down')
    expect(res.conversationId).toBe('conv-1')
  })
})
