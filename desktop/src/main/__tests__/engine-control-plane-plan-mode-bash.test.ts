/**
 * EngineControlPlane plan-mode bash-allowlist projection tests.
 *
 * Split out of `engine-control-plane.test.ts` to keep the parent file
 * under the 600-line TypeScript cap. These tests pin the desktop's
 * side of the tri-valued `set_plan_mode.planModeAllowedBashCommands`
 * contract documented in `docs/protocol/client-commands.md`:
 *
 *   - omitted (undefined) → engine treats as "no change"
 *   - []                  → engine treats as "clear"
 *   - ["gh", ...]         → engine treats as "replace"
 *
 * Before the Fix 1 BLOCKER fix, `setPermissionMode` collapsed `[]`
 * into `undefined` at the `if (cmds && cmds.length > 0)` guard,
 * silently demoting an explicit user clear to a no-op on the engine
 * side. The "ExplicitEmptyClears" test below catches that regression
 * — it asserts `mockBridge.sendSetPlanMode` is called with `[]` as
 * the fifth argument, which fails against the un-fixed guard with
 * "Expected [], got undefined".
 *
 * The fourth test pins the read-failure fallback: when `readSettings`
 * throws, the helper returns `undefined` and the bridge call sends
 * `undefined`, preserving the engine's prior allowlist (the
 * "no change" branch of the tri-valued contract).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// Vitest hoists `vi.mock` factories above all variable declarations, so
// any shared spy referenced from inside a factory must be declared via
// `vi.hoisted` (which is hoisted alongside the mocks themselves). The
// `mocks` namespace below owns the read-settings spy and the logger spy
// so the factories can route through them without "Cannot access X
// before initialization" errors.
const mocks = vi.hoisted(() => ({
  readSettings: vi.fn<() => Record<string, any>>(),
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
  stopSession: vi.fn(),
  stopAll: vi.fn(),
  on: vi.fn(),
  emit: vi.fn(),
  removeListener: vi.fn(),
  removeAllListeners: vi.fn(),
}

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
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

// Mock the disk-read at the settings-store boundary so each test can
// dictate exactly what `resolveBashAllowlistFromSettings` sees. Routing
// through the real settings-store + a mocked plan-mode-bash-allowlist
// would skip the helper's own behavior; routing through the real helper
// + a mocked settings-store exercises the helper end-to-end.
vi.mock('../settings-store', () => ({
  readSettings: () => mocks.readSettings(),
  SETTINGS_DEFAULTS: {},
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

describe('EngineControlPlane — setPermissionMode plan-mode bash allowlist projection', () => {
  let cp: EngineControlPlane

  beforeEach(() => {
    vi.clearAllMocks()
    uuidCounter = 0
    mocks.readSettings.mockReset()
    mocks.log.mockReset()
    mockBridge.startSession.mockResolvedValue({ ok: true })
    cp = new EngineControlPlane(new (EngineBridge as any)())
  })

  it('happy path: non-empty allowlist preference is projected verbatim to sendSetPlanMode', () => {
    // Pre-condition: user has saved ["gh"] in settings.json. The helper
    // returns ["gh"]. setPermissionMode forwards it untouched.
    mocks.readSettings.mockReturnValue({ planModeAllowedBashCommands: ['gh'] })

    const tabId = cp.createTab()
    cp.setPermissionMode(tabId, 'plan', 'test-source')

    expect(mockBridge.sendSetPlanMode).toHaveBeenLastCalledWith(
      tabId,
      true,
      undefined,
      'test-source',
      ['gh'],
    )
  })

  it('explicit-empty allowlist preference is projected as [] (the BLOCKER pin)', () => {
    // Pre-condition: user has explicitly cleared the allowlist (saved []
    // via the BashAllowlistEditor). The helper returns []. setPermissionMode
    // MUST forward the empty array — not collapse it to undefined — so the
    // engine receives the documented "clear" signal per the tri-valued
    // contract in docs/protocol/client-commands.md § set_plan_mode.
    //
    // Against the un-fixed `if (cmds && cmds.length > 0) bashCmds = cmds`
    // guard this assertion fails with "Expected [], got undefined" — that's
    // the regression this test pins.
    mocks.readSettings.mockReturnValue({ planModeAllowedBashCommands: [] })

    const tabId = cp.createTab()
    cp.setPermissionMode(tabId, 'plan', 'test-source')

    expect(mockBridge.sendSetPlanMode).toHaveBeenLastCalledWith(
      tabId,
      true,
      undefined,
      'test-source',
      [],
    )
  })

  it('missing allowlist field is projected as undefined (engine keeps prior allowlist)', () => {
    // Pre-condition: the preference key is absent from settings.json (older
    // desktop installs, fresh installs, or schema-drift cases). The helper
    // returns undefined. setPermissionMode forwards undefined so the engine
    // receives the documented "no change" signal — the engine retains
    // whatever allowlist was previously installed via engine.json defaults
    // or a prior set_plan_mode call.
    mocks.readSettings.mockReturnValue({})

    const tabId = cp.createTab()
    cp.setPermissionMode(tabId, 'plan', 'test-source')

    expect(mockBridge.sendSetPlanMode).toHaveBeenLastCalledWith(
      tabId,
      true,
      undefined,
      'test-source',
      undefined,
    )
  })

  it('readSettings throws → projected as undefined and the failure is logged', () => {
    // Pre-condition: settings.json is corrupted, locked, or otherwise
    // unreadable. The helper catches the throw, logs it via
    // `~/.ion/desktop.log`, and returns undefined. setPermissionMode
    // forwards undefined (engine keeps prior allowlist) — the safe
    // fallback per the tri-valued contract.
    //
    // The log line is asserted because the helper's docstring promises
    // a logged fallback per `desktop/AGENTS.md` "no silent catch", and
    // operators investigating "my allowlist isn't being honored" need
    // the log entry to distinguish a thrown read from a missing-key read.
    mocks.readSettings.mockImplementation(() => {
      throw new Error('settings.json corrupted (synthetic)')
    })

    const tabId = cp.createTab()
    cp.setPermissionMode(tabId, 'plan', 'test-source')

    expect(mockBridge.sendSetPlanMode).toHaveBeenLastCalledWith(
      tabId,
      true,
      undefined,
      'test-source',
      undefined,
    )

    // The helper logs via the logger's `log` export. We don't assert the
    // exact prefix (avoids brittleness against tag-rename refactors) —
    // only that the failure surfaced through the logger and named the
    // cause string.
    const failureLogs = mocks.log.mock.calls.filter((args: any[]) =>
      args.some((a) => typeof a === 'string' && a.includes('settings.json corrupted')),
    )
    expect(failureLogs.length).toBeGreaterThan(0)
  })

  it('mode=auto never reads settings or sends an allowlist (no-op for non-plan transitions)', () => {
    // Symmetric sanity check: switching to 'auto' must not invoke the
    // helper or send an allowlist, since the engine's allowlist applies
    // only to plan-mode runs. This guards against a future refactor that
    // accidentally calls resolveBashAllowlistFromSettings unconditionally.
    mocks.readSettings.mockReturnValue({ planModeAllowedBashCommands: ['gh'] })

    const tabId = cp.createTab()
    cp.setPermissionMode(tabId, 'auto', 'test-source')

    expect(mockBridge.sendSetPlanMode).toHaveBeenLastCalledWith(
      tabId,
      false,
      undefined,
      'test-source',
      undefined,
    )
    expect(mocks.readSettings).not.toHaveBeenCalled()
  })
})
