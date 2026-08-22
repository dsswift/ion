/**
 * EngineControlPlane — resolving a pending plan/question card.
 *
 * Two layers retain state about a pending AskUserQuestion / ExitPlanMode, and
 * releasing only one leaves the reported bug in place:
 *
 *   1. The ENGINE retains the denial and re-publishes it on every status
 *      snapshot, releasing it only on a new prompt or a /clear.
 *   2. This control plane latches `lastSurfacedProposalSig` so a heartbeat echo
 *      of an already-surfaced proposal does not resurrect a dismissed card.
 *
 * A dismissal is neither a prompt nor a /clear, so before this the engine kept
 * re-offering the card while the latch suppressed every re-delivery — making
 * the first surface the only one. Any later loss of the renderer's copy was
 * therefore unrecoverable, which is exactly how a live conversation ended up
 * showing a plan with no way to act on it.
 *
 * Revert contract: dropping either half of resolvePermissionDenials (the latch
 * clear or the engine notify) makes a test here go red.
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
  getSessionConfig: vi.fn(() => undefined),
  sendPrompt: vi.fn().mockResolvedValue({ ok: true }),
  sendAbort: vi.fn(),
  sendDialogResponse: vi.fn(),
  sendCommand: vi.fn(),
  sendPermissionResponse: vi.fn(),
  sendSetPlanMode: vi.fn(),
  sendResolvePermissionDenials: vi.fn(),
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
  IS_REMOTE: false,
  REMOTE_SOCKET: '',
}))

vi.mock('../engine-bridge-fs', () => ({
  engineIsRemote: vi.fn(() => false),
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: false, error: 'unused' })),
  listEngineDirectory: vi.fn(() => Promise.resolve({ ok: false, error: 'unused' })),
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  trace: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

let uuidCounter = 0
vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto')
  return { ...actual, randomUUID: vi.fn(() => `tab-${String(++uuidCounter).padStart(3, '0')}`) }
})

import { EngineControlPlane } from '../engine-control-plane'
import { EngineBridge } from '../engine-bridge'

describe('EngineControlPlane — resolvePermissionDenials', () => {
  let cp: EngineControlPlane

  beforeEach(() => {
    vi.clearAllMocks()
    uuidCounter = 0
    cp = new EngineControlPlane(new (EngineBridge as any)())
  })

  it('tells the engine to release its retention of the denial', () => {
    const tabId = cp.createTab()

    cp.resolvePermissionDenials(tabId)

    expect(mockBridge.sendResolvePermissionDenials).toHaveBeenCalledWith(tabId)
  })

  it('clears the surfaced-proposal latch so a re-offered proposal can surface again', () => {
    const tabId = cp.createTab()
    const tab = cp.getTabStatus(tabId)!
    // The control plane surfaced a proposal and latched its signature.
    tab.lastSurfacedProposalSig = 'ExitPlanMode:/plans/tidy-mixing-brook.md'

    cp.resolvePermissionDenials(tabId)

    expect(tab.lastSurfacedProposalSig).toBeNull()
  })

  it('is a no-op for an unknown tab and does not notify the engine', () => {
    cp.resolvePermissionDenials('no-such-tab')

    expect(mockBridge.sendResolvePermissionDenials).not.toHaveBeenCalled()
  })

  it('is safe to call when no card was ever surfaced', () => {
    // A second dismissal click, or two clients resolving the same card.
    const tabId = cp.createTab()
    expect(cp.getTabStatus(tabId)!.lastSurfacedProposalSig).toBeNull()

    cp.resolvePermissionDenials(tabId)
    cp.resolvePermissionDenials(tabId)

    expect(cp.getTabStatus(tabId)!.lastSurfacedProposalSig).toBeNull()
    expect(mockBridge.sendResolvePermissionDenials).toHaveBeenCalledTimes(2)
  })
})
