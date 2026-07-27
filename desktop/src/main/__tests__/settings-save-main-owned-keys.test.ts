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
vi.mock('../remote/relay-config-push', () => ({ sendRelayConfigToPeers: vi.fn().mockResolvedValue({ sent: false }) }))
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

  // ─── Relay OIDC config survival ───
  //
  // The renderer's SAVE_SETTINGS payload is a FIXED key list (getAllSettings in
  // renderer/preferences-persist.ts) that contains none of the relay OIDC keys.
  // Before the merge, writeSettings serialized exactly the payload it was
  // handed, so every preference toggle DELETED the probe-persisted OIDC config
  // from settings.json. The peer-connect handler then read relayAuthMode as
  // undefined, fell through to PSK, and pushed an empty credential to the
  // paired iPhone — which persisted the emptiness and lost relay reconnect.
  //
  // Fails on the unfixed handler: the keys vanish from the write.

  it('preserves main-written relay OIDC keys absent from the renderer payload', async () => {
    settingsStoreMock.onDisk = {
      theme: 'dark',
      relayUrl: 'wss://relay.example.com',
      relayAuthMode: 'oidc',
      relayOidcIssuer: 'https://issuer.example.com/v2.0',
      relayOidcAudience: 'api://audience-id',
      relayOidcRequiredScope: 'api://audience-id/Relay.Access',
    }

    const save = ipcHandlers.get(IPC.SAVE_SETTINGS)!
    // A realistic renderer payload: knows relayUrl, knows nothing about the
    // four probe-derived OIDC keys.
    await save({}, { theme: 'light', relayUrl: 'wss://relay.example.com' })

    expect(settingsStoreMock.written).not.toBeNull()
    expect(settingsStoreMock.written!.theme).toBe('light')
    expect(settingsStoreMock.written!.relayAuthMode).toBe('oidc')
    expect(settingsStoreMock.written!.relayOidcIssuer).toBe('https://issuer.example.com/v2.0')
    expect(settingsStoreMock.written!.relayOidcAudience).toBe('api://audience-id')
    expect(settingsStoreMock.written!.relayOidcRequiredScope).toBe('api://audience-id/Relay.Access')
  })

  it('preserves any main-written key the renderer payload omits', async () => {
    // The rule is general, not an OIDC special case: writeSettings replaces the
    // file wholesale, so ANY key written only by a main-process path must
    // survive a renderer save that has never heard of it.
    settingsStoreMock.onDisk = { theme: 'dark', atvBounds: { x: 10, y: 20 } }

    const save = ipcHandlers.get(IPC.SAVE_SETTINGS)!
    await save({}, { theme: 'light' })

    expect(settingsStoreMock.written!.atvBounds).toEqual({ x: 10, y: 20 })
  })

  it('lets the renderer overwrite the keys it does own', async () => {
    // Merging must not make renderer-owned keys sticky: the renderer always
    // emits its full list, and those values are authoritative.
    settingsStoreMock.onDisk = { theme: 'dark', soundEnabled: true, relayAuthMode: 'oidc' }

    const save = ipcHandlers.get(IPC.SAVE_SETTINGS)!
    await save({}, { theme: 'light', soundEnabled: false })

    expect(settingsStoreMock.written!.theme).toBe('light')
    expect(settingsStoreMock.written!.soundEnabled).toBe(false)
    expect(settingsStoreMock.written!.relayAuthMode).toBe('oidc')
  })

  it('keeps the disk relay auth mode when a renderer payload carries a stale one', async () => {
    // Second line of defence: relayAuthMode is in MAIN_OWNED_SETTINGS_KEYS, so
    // even a renderer that starts sending it cannot downgrade the probe's
    // resolution.
    settingsStoreMock.onDisk = { theme: 'dark', relayAuthMode: 'oidc' }

    const save = ipcHandlers.get(IPC.SAVE_SETTINGS)!
    await save({}, { theme: 'light', relayAuthMode: 'psk' })

    expect(settingsStoreMock.written!.relayAuthMode).toBe('oidc')
  })
})
