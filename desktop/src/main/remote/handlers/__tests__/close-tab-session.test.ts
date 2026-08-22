/**
 * Tests for `handleCloseTab` — engine-session teardown on tab close.
 *
 * What this file covers
 * ─────────────────────
 *   1. `engineBridge.stopSession` is called with the BARE tabId.
 *      This is the load-bearing contract: after ADR-010, conversations key
 *      their engine session by the bare tabId. `stopByPrefix(`${tabId}:`)`
 *      only matches compound keys (terminals, legacy `${tabId}:main`) and
 *      would silently leave the bare-key conversation session orphaned in
 *      both the desktop activeSessions map and the engine daemon.
 *   2. A live owner renderer receives `closeTab`, so normal close can settle a
 *      non-empty conversation and permanently delete only an empty one.
 *   3. `engineBridge.stopByPrefix(`${tabId}:`)` is still called so terminal
 *      and legacy compound-key sessions on the same tab are also stopped.
 *
 * Regression contract
 * ───────────────────
 * Revert the direct-fallback `void engineBridge.stopSession(tabId)` line in
 * handlers/tabs.ts and test #1 goes red — the bare-key conversation
 * session is never stopped, which was the orphaned-session leak.
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
  executeJavaScript: vi.fn(),
  closeTab: vi.fn(),
  destroyByPrefix: vi.fn(),
  broadcast: vi.fn(),
  send: vi.fn(),
}))

vi.mock('../../../state', () => ({
  state: {
    remoteTransport: { send: (...a: any[]) => mocks.send(...a) },
    mainWindow: {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: (...a: any[]) => mocks.executeJavaScript(...a),
        send: vi.fn(),
      },
    },
  },
  sessionPlane: { closeTab: (...a: any[]) => mocks.closeTab(...a) },
  engineBridge: {
    stopSession: (...a: any[]) => mocks.stopSession(...a),
    stopByPrefix: (...a: any[]) => mocks.stopByPrefix(...a),
  },
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map(),
  lastForwardedTabStatus: new Map(),
  extensionCommandRegistry: new Map(),
}))

vi.mock('../../broadcast', () => ({ broadcast: (...a: any[]) => mocks.broadcast(...a) }))
vi.mock('../../terminal-manager-instance', () => ({
  terminalManager: { destroyByPrefix: (...a: any[]) => mocks.destroyByPrefix(...a) },
}))
vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../settings-store', () => ({ readSettings: vi.fn(), readClaudeCompat: vi.fn() }))
vi.mock('../snapshot', () => ({ getRemoteTabStates: vi.fn(() => []) }))
vi.mock('./diagnostics', () => ({ autoPullDiagnosticLogs: vi.fn() }))
vi.mock('./tabs-sync', () => ({ broadcastSync: vi.fn(), sendSync: vi.fn() }))
vi.mock('../../ipc-validation', () => ({ resolveDiscoveryWorkingDir: vi.fn() }))

import { handleCloseTab } from '../tabs'

beforeEach(() => {
  mocks.stopSession.mockReset().mockResolvedValue(undefined)
  mocks.stopByPrefix.mockReset()
  mocks.closeTab.mockReset()
  mocks.executeJavaScript.mockReset().mockResolvedValue(false)
})

describe('handleCloseTab — engine session teardown', () => {
  it('stops the bare-key conversation session (ADR-010 orphan fix)', async () => {
    await handleCloseTab({ type: 'desktop_close_tab', tabId: 'tab-abc' })

    expect(mocks.stopSession).toHaveBeenCalledTimes(1)
    expect(mocks.stopSession).toHaveBeenCalledWith('tab-abc')
  })

  it('routes through the owner so close and settle share lifecycle policy', async () => {
    mocks.executeJavaScript.mockResolvedValueOnce(true)

    await handleCloseTab({ type: 'desktop_close_tab', tabId: 'tab-abc' })

    expect(mocks.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("closeTab('tab-abc')"))
    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(mocks.stopSession).not.toHaveBeenCalled()
  })

  it('still stops compound-key (terminal/legacy) sessions by prefix', async () => {
    await handleCloseTab({ type: 'desktop_close_tab', tabId: 'tab-abc' })

    expect(mocks.stopByPrefix).toHaveBeenCalledTimes(1)
    expect(mocks.stopByPrefix).toHaveBeenCalledWith('tab-abc:')
  })
})
