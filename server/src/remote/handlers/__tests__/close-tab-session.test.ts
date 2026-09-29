/**
 * Tests for `handleCloseTab` — engine-session teardown on tab close.
 *
 * What this file covers
 * ─────────────────────
 *   1. `handleCloseTab` delegates tab lifecycle policy (settle-vs-delete,
 *      busy guard, session teardown) to `useSessionStore.getState().closeTab`
 *      rather than reimplementing it — the store runs in-process with this
 *      handler now, so there is no renderer round trip to route through.
 *   2. `engineBridge.stopSession` is called with the BARE tabId, inside the
 *      store's `closeTab` action (via `host-api-engine.ts`'s `closeTab`).
 *      This is the load-bearing contract: after ADR-010, conversations key
 *      their engine session by the bare tabId. `stopByPrefix(`${tabId}:`)`
 *      only matches compound keys (terminals, legacy `${tabId}:main`) and
 *      would silently leave the bare-key conversation session orphaned in
 *      both the desktop activeSessions map and the engine daemon.
 *   3. `engineBridge.stopByPrefix(`${tabId}:`)` is still called so terminal
 *      and legacy compound-key sessions on the same tab are also stopped.
 *
 * Regression contract
 * ───────────────────
 * Revert the `engineBridge.stopSession(tabId)` call in
 * `store/host-api-engine.ts`'s `closeTab` and test #2 goes red — the
 * bare-key conversation session is never stopped, which was the
 * orphaned-session leak.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// Electron is not installed in CI (npm ci --ignore-scripts skips the binary
// download). Any module in the transitive import chain that does
// `import ... from 'electron'` at the top level will throw at load time
// without this stub. This test runs headless main-process logic only; no
// real Electron APIs are exercised.
vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  nativeImage: { createFromPath: vi.fn(), createFromBuffer: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

const mocks = vi.hoisted(() => ({
  stopSession: vi.fn().mockResolvedValue(undefined),
  stopByPrefix: vi.fn(),
  sessionPlaneCloseTab: vi.fn(),
  destroyByPrefix: vi.fn(),
  storeCloseTab: vi.fn(),
  broadcast: vi.fn(),
  send: vi.fn(),
}))

const snapshotCache = vi.hoisted(() => ({ value: null as null | { tabs: Array<Record<string, unknown>> } }))

vi.mock('../../../state', () => ({
  state: {
    remoteTransport: { send: (...a: any[]) => mocks.send(...a) },
    get rendererSnapshotCache() { return snapshotCache.value },
  },
  sessionPlane: { closeTab: (...a: any[]) => mocks.sessionPlaneCloseTab(...a) },
  engineBridge: {
    stopSession: (...a: any[]) => mocks.stopSession(...a),
    stopByPrefix: (...a: any[]) => mocks.stopByPrefix(...a),
  },
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map(),
  lastForwardedTabStatus: new Map(),
  extensionCommandRegistry: new Map(),
}))

// The store's own closeTab action (busy guard, settle-vs-delete policy) is
// covered by tab-slice.ts's own tests; this handler test only needs to prove
// handleCloseTab delegates to it, so the mock here forwards straight to the
// real engine-teardown host-api function under test.
vi.mock('../../../store/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      closeTab: (...a: any[]) => mocks.storeCloseTab(...a),
    }),
  },
}))

vi.mock('../../broadcast', () => ({ broadcast: (...a: any[]) => mocks.broadcast(...a) }))
vi.mock('../../../terminal/terminal-manager-instance', () => ({
  terminalManager: { destroyByPrefix: (...a: any[]) => mocks.destroyByPrefix(...a) },
}))
vi.mock('../../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../../persistence/settings-store', () => ({ readSettings: vi.fn(() => ({})), readClaudeCompat: vi.fn(), settingsDir: () => '/tmp/ion-close-tab-session-test', onStreamThinkingToRemoteChange: vi.fn(() => () => {}) }))
vi.mock('../snapshot', () => ({ getRemoteTabStates: vi.fn(() => []) }))
vi.mock('./diagnostics', () => ({ autoPullDiagnosticLogs: vi.fn() }))
vi.mock('./tabs-sync', () => ({ broadcastSync: vi.fn(), sendSync: vi.fn() }))
vi.mock('../../ipc-validation', () => ({ resolveDiscoveryWorkingDir: vi.fn() }))

import { closeTabGuarded } from '../tabs'
import { closeTab as engineCloseTab } from '../../../store/host-api-engine'

beforeEach(() => {
  mocks.stopSession.mockReset().mockResolvedValue(undefined)
  mocks.stopByPrefix.mockReset()
  mocks.sessionPlaneCloseTab.mockReset()
  mocks.destroyByPrefix.mockReset()
  mocks.storeCloseTab.mockReset()
  snapshotCache.value = null
})

describe('closeTabGuarded — engine session teardown', () => {
  it('routes through the owner store so close and settle share lifecycle policy', async () => {
    await closeTabGuarded('tab-abc')

    expect(mocks.storeCloseTab).toHaveBeenCalledWith('tab-abc')
  })

  it('stops the bare-key conversation session (ADR-010 orphan fix)', async () => {
    mocks.storeCloseTab.mockImplementation((tabId: string) => engineCloseTab(tabId))

    await closeTabGuarded('tab-abc')
    await vi.waitFor(() => expect(mocks.stopSession).toHaveBeenCalled())

    expect(mocks.stopSession).toHaveBeenCalledTimes(1)
    expect(mocks.stopSession).toHaveBeenCalledWith('tab-abc')
  })

  it('still stops compound-key (terminal/legacy) sessions by prefix', async () => {
    mocks.storeCloseTab.mockImplementation((tabId: string) => engineCloseTab(tabId))

    await closeTabGuarded('tab-abc')
    await vi.waitFor(() => expect(mocks.stopByPrefix).toHaveBeenCalled())

    expect(mocks.stopByPrefix).toHaveBeenCalledTimes(1)
    expect(mocks.stopByPrefix).toHaveBeenCalledWith('tab-abc:')
  })
})

describe('closeTabGuarded — what the caller of tabs.close is told', () => {
  it('closes an idle conversation and says so', async () => {
    snapshotCache.value = { tabs: [{ id: 'tab-abc', status: 'idle' }] }
    expect(await closeTabGuarded('tab-abc')).toEqual({ closed: true, blocked: false, orchestratorRunning: false, agentCount: 0, shellCount: 0 })
    expect(mocks.storeCloseTab).toHaveBeenCalledWith('tab-abc')
  })

  it('refuses while work is in flight, leaves the tab open, and names what is running', async () => {
    snapshotCache.value = { tabs: [{ id: 'tab-abc', status: 'idle', conversationInstances: [{ isRunning: true, runningAgentCount: 2, backgroundShellCount: 1 }] }] }
    expect(await closeTabGuarded('tab-abc')).toEqual({ closed: false, blocked: true, orchestratorRunning: true, agentCount: 2, shellCount: 1 })
    expect(mocks.storeCloseTab).not.toHaveBeenCalled()
  })
})
