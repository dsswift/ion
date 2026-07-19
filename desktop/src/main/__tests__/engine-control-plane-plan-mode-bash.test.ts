/**
 * EngineControlPlane plan-mode bash-allowlist projection tests.
 *
 * The plan-mode Bash allowlist is ENGINE POLICY: the engine resolves it
 * fresh from engine.json (limits.planModeAllowedBashCommands) at each prompt
 * dispatch. The desktop therefore does NOT push a session-scoped override on
 * plan-mode entry — doing so would clobber the operator's engine.json and
 * break the headless-consumer contract.
 *
 * These tests pin that contract: setPermissionMode always calls
 * sendSetPlanMode with `undefined` for the allowlist argument (the wire
 * field's "no change" value), in both plan and auto transitions, regardless
 * of any settings state. The published set_plan_mode.planModeAllowedBashCommands
 * wire field is kept for external consumers, but the reference desktop never
 * populates it.
 *
 * Revert proof: if setPermissionMode is ever changed back to read a
 * desktop-stored allowlist and push it, the fifth argument stops being
 * undefined and these assertions fail.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  log: vi.fn<(...args: any[]) => void>(),
}))

// Mock Electron's `app` and `safeStorage` before the import chain reaches
// settings-store → utils/secretStore (which imports from 'electron' at
// module-load). Same posture as the parent file.
vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

// vi.hoisted for the same reason as `mocks` above: state.ts constructs an
// EngineBridge at module load, so the engine-bridge mock factory runs during
// the hoisted import phase — a plain `const` here is still in its TDZ then.
const mockBridge = vi.hoisted(() => ({
  startSession: vi.fn().mockResolvedValue({ ok: true }),
  sendPrompt: vi.fn().mockResolvedValue({ ok: true }),
  sendAbort: vi.fn(),
  sendDialogResponse: vi.fn(),
  sendCommand: vi.fn(),
  sendPermissionResponse: vi.fn(),
  sendSetPlanMode: vi.fn(),
  updateSessionConversationId: vi.fn(),
  stopByPrefix: vi.fn(),
  stopSession: vi.fn(),
  stopAll: vi.fn(),
  on: vi.fn(),
  emit: vi.fn(),
  removeListener: vi.fn(),
  removeAllListeners: vi.fn(),
}))

vi.mock('../engine-bridge', () => {
  return {
    EngineBridge: function () {
      return mockBridge
    },
    IS_REMOTE: false,
    REMOTE_SOCKET: '',
  }
})

vi.mock('../engine-bridge-fs', () => ({
  engineIsRemote: vi.fn(() => false),
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: false, error: 'not used in tests' })),
  listEngineDirectory: vi.fn(() => Promise.resolve({ ok: false, error: 'not used in tests' })),
}))

vi.mock('../logger', () => ({
  log: mocks.log,
  trace: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

let uuidCounter = 0
vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto')
  return {
    ...actual,
    randomUUID: vi.fn(() => `tab-${String(++uuidCounter).padStart(3, '0')}`),
  }
})

import { EngineControlPlane } from '../engine-control-plane'
import { EngineBridge } from '../engine-bridge'

describe('EngineControlPlane — setPermissionMode never pushes a bash allowlist', () => {
  let cp: EngineControlPlane

  beforeEach(() => {
    vi.clearAllMocks()
    uuidCounter = 0
    mocks.log.mockReset()
    mockBridge.startSession.mockResolvedValue({ ok: true })
    cp = new EngineControlPlane(new (EngineBridge as any)())
  })

  it('plan transition sends undefined for the allowlist (engine resolves from engine.json)', () => {
    const tabId = cp.createTab()
    cp.setPermissionMode(tabId, 'plan', 'test-source')

    expect(mockBridge.sendSetPlanMode).toHaveBeenLastCalledWith(
      tabId,
      true,
      undefined,
      'test-source',
      undefined, // allowlist: never pushed by the desktop
      undefined,
    )
  })

  it('plan transition with a planFilePath still sends undefined for the allowlist', () => {
    const tabId = cp.createTab()
    cp.setPermissionMode(tabId, 'plan', 'test-source', '/tmp/plan.md')

    const call = mockBridge.sendSetPlanMode.mock.calls.at(-1)!
    expect(call[1]).toBe(true) // enabled
    expect(call[4]).toBeUndefined() // allowlist
    expect(call[5]).toBe('/tmp/plan.md') // planFilePath restored on 'plan'
  })

  it('auto transition sends undefined for the allowlist and no planFilePath', () => {
    const tabId = cp.createTab()
    cp.setPermissionMode(tabId, 'auto', 'test-source', '/tmp/plan.md')

    expect(mockBridge.sendSetPlanMode).toHaveBeenLastCalledWith(
      tabId,
      false,
      undefined,
      'test-source',
      undefined, // allowlist
      undefined, // planFilePath: only forwarded on 'plan'
    )
  })
})
