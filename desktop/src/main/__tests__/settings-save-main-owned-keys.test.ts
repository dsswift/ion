/**
 * Regression test for the paired-device clobber: the renderer saves its whole
 * settings object on every preference change, and that object is a snapshot
 * from whenever its store last loaded. A save carrying a stale pairedDevices
 * array silently reverted a fresh pairing on disk — the just-paired iPhone
 * became "unknown device" on every reconnect after the next desktop restart.
 *
 * SAVE_SETTINGS must always keep the DISK value for main-owned keys
 * (MAIN_OWNED_SETTINGS_KEYS), ignoring whatever the renderer payload carries.
 * Fails on the unfixed handler (the stale renderer array reaches the write).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  app: { get isPackaged() { return false }, relaunch: vi.fn(), quit: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { ipcHandlers.set(channel, fn) },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

const settingsStoreMock = vi.hoisted(() => ({
  onDisk: {} as Record<string, unknown>,
  written: null as Record<string, unknown> | null,
}))

vi.mock('../settings-store', () => ({
  SETTINGS_DEFAULTS: {},
  SETTINGS_DIR: '/tmp/ion-test-settings',
  SETTINGS_FILE: '/tmp/ion-test-settings/settings.json',
  SESSION_CHAINS_FILE: '/tmp/ion-test-settings/chains.json',
  TABS_FILE: '/tmp/ion-test-settings/tabs.json',
  currentBackend: 'api',
  loadSessionChains: vi.fn(),
  loadSessionLabels: vi.fn().mockReturnValue({}),
  readEngineConfig: vi.fn().mockReturnValue({}),
  readSettings: () => ({ ...settingsStoreMock.onDisk }),
  saveSessionChains: vi.fn(),
  saveSessionLabels: vi.fn(),
  writeEngineConfig: vi.fn(),
  writeSettings: (data: Record<string, unknown>) => { settingsStoreMock.written = data },
}))

vi.mock('../settings-broadcast', async () => {
  const store = await import('../settings-store')
  return {
    // Mirror the real helper's persistence step only — broadcast is out of
    // scope for this test.
    persistAndBroadcastSettings: (next: Record<string, unknown>) => { store.writeSettings(next) },
  }
})

vi.mock('../remote/transport-init', () => ({ initRemoteTransport: vi.fn() }))
vi.mock('../state', () => ({ state: { remoteTransport: null }, engineBridge: {} }))
vi.mock('../tab-migration-unify-runner', () => ({ runTabUnifyMigration: vi.fn().mockReturnValue({ reason: 'skipped' }) }))
vi.mock('../tab-migration-split-runner', () => ({ runTabSplitMigration: vi.fn().mockReturnValue({ reason: 'skipped' }) }))

import { registerSettingsIpc } from '../ipc/settings'
import { IPC } from '../../shared/types'

describe('SAVE_SETTINGS main-owned keys', () => {
  beforeEach(() => {
    ipcHandlers.clear()
    settingsStoreMock.written = null
    registerSettingsIpc()
  })

  it('keeps the disk pairedDevices when the renderer payload carries a stale copy', async () => {
    const freshPairing = [{ id: '38384c8589cceb69', name: 'iPhone' }]
    const stalePairing = [{ id: '121c1d1feb692bbd', name: 'iPhone' }]
    settingsStoreMock.onDisk = { theme: 'dark', pairedDevices: freshPairing }

    const save = ipcHandlers.get(IPC.SAVE_SETTINGS)!
    await save({}, { theme: 'light', pairedDevices: stalePairing })

    expect(settingsStoreMock.written).not.toBeNull()
    // The renderer-owned key persists...
    expect(settingsStoreMock.written!.theme).toBe('light')
    // ...but the main-owned key keeps the disk value, not the stale payload.
    expect(settingsStoreMock.written!.pairedDevices).toEqual(freshPairing)
  })

  it('does not resurrect a main-owned key absent from disk', async () => {
    settingsStoreMock.onDisk = { theme: 'dark' }

    const save = ipcHandlers.get(IPC.SAVE_SETTINGS)!
    await save({}, { theme: 'light', pairedDevices: [{ id: 'ghost', name: 'iPhone' }] })

    expect(settingsStoreMock.written).not.toBeNull()
    expect('pairedDevices' in settingsStoreMock.written!).toBe(false)
  })
})
