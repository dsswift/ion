/**
 * EngineControlPlane.shutdown — Quit Desktop must not stop engine sessions.
 *
 * The engine is a launchd daemon, not a desktop subprocess: its sessions
 * outlive the window, and session ownership is released with a grace window
 * (`reapGraceWindow`, engine/internal/server/session_ownership.go) so that a
 * desktop restart reattaches to work still in flight. The quit dialog promises
 * exactly that — "Quit Desktop closes the window but keeps engine sessions
 * running".
 *
 * It did not. `shutdown()` took no argument and stopped every tracked session
 * unconditionally, so a Quit Desktop wrote one `stop_session` per open
 * conversation and killed the in-flight work the grace window exists to
 * protect. The first test below fails against that code: `stopSession` was
 * called once per tab where it must be called zero times.
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
  disconnect: vi.fn().mockResolvedValue(undefined),
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

describe('EngineControlPlane.shutdown', () => {
  let cp: EngineControlPlane
  let tabs: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    uuidCounter = 0
    cp = new EngineControlPlane(new EngineBridge())
    tabs = [cp.createTab(), cp.createTab(), cp.createTab()]
  })

  // THE regression test. Quit Desktop.
  it('stops no session when stopSessions is false', () => {
    cp.shutdown({ stopSessions: false })
    expect(mockBridge.stopSession).not.toHaveBeenCalled()
  })

  it('still drops the socket when stopSessions is false', () => {
    // Closing the window must release the desktop's half of the relationship —
    // leaving sessions running is not the same as leaving the socket open.
    cp.shutdown({ stopSessions: false })
    expect(mockBridge.disconnect).toHaveBeenCalledOnce()
  })

  // Quit All: the operator asked for the engine to go away, so stopping each
  // session while the socket is still live is the correct teardown.
  it('stops every tracked session when stopSessions is true', () => {
    cp.shutdown({ stopSessions: true })
    expect(mockBridge.stopSession).toHaveBeenCalledTimes(tabs.length)
    for (const tabId of tabs) {
      expect(mockBridge.stopSession).toHaveBeenCalledWith(tabId)
    }
    expect(mockBridge.disconnect).toHaveBeenCalledOnce()
  })

  it('releases a drain when an attaching session reaches idle', async () => {
    // Regression: the renderer received idle while the control plane remained
    // starting, so installer SIGUSR1 waited until manual quit. The canonical
    // status transition must release the same latch without stopping sessions.
    const tabId = tabs[0]
    ;(cp.getTabStatus(tabId)!).status = 'starting'
    const pending = cp.drain()

    ;(cp as any)._setStatus(tabId, 'idle')

    expect(cp.getTabStatus(tabId)?.status).toBe('idle')
    await expect(pending).resolves.toBeUndefined()
    expect(mockBridge.stopSession).not.toHaveBeenCalled()
  })

  it('releases a pending drain either way', async () => {
    // A quit while drain() is awaiting must not hang the quit.
    const pending = cp.drain(() => true)
    cp.shutdown({ stopSessions: false })
    await expect(pending).resolves.toBeUndefined()
  })
})
