/**
 * iOS routing test for the engine-config-backed plan-mode Bash allowlist.
 *
 * iOS edits the allowlist the same way it edits any projectable setting: it
 * sends set_desktop_setting{planModeAllowedBashCommands}. iOS never learns
 * where the value is stored. The desktop must route this key to engine.json
 * (via plan-bash-allowlist-store), NOT settings.json, and the subsequent
 * projection must read it back from engine.json so the snapshot iOS receives
 * reflects engine policy.
 *
 * This pins the single interception seam in settings-broadcast that both edit
 * surfaces (renderer SAVE_SETTINGS and iOS set_desktop_setting) funnel through.
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

// settings.json store — capture writes so we can assert the allowlist NEVER
// lands here.
const settingsStore = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  writes: [] as Record<string, unknown>[],
}))
vi.mock('../settings-store', () => ({
  readSettings: () => ({ ...settingsStore.settings }),
  writeSettings: (data: Record<string, unknown>) => { settingsStore.writes.push(data); settingsStore.settings = data },
  SETTINGS_DEFAULTS: {},
}))

// engine.json-backed allowlist store — capture writes so we can assert the
// allowlist DOES land here, and control reads for the projection.
const engineStore = vi.hoisted(() => ({ allowlist: [] as string[], writes: [] as string[][] }))
vi.mock('../plan-bash-allowlist-store', () => ({
  readPlanBashAllowlist: () => engineStore.allowlist,
  writePlanBashAllowlist: (cmds: string[]) => { engineStore.writes.push(cmds); engineStore.allowlist = cmds },
}))

// Capture the outbound snapshot so we can assert iOS receives the engine.json
// value.
const transport = vi.hoisted(() => ({ sent: [] as any[] }))
vi.mock('../state', () => ({
  state: { get remoteTransport() { return { send: (m: any) => transport.sent.push(m) } } },
}))
vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { handleSetDesktopSetting } from '../remote/handlers/desktop-settings'

describe('iOS set_desktop_setting routing for the plan-mode Bash allowlist', () => {
  beforeEach(() => {
    settingsStore.settings = {}
    settingsStore.writes = []
    engineStore.allowlist = []
    engineStore.writes = []
    transport.sent = []
  })

  it('routes the allowlist to engine.json, never settings.json', async () => {
    await handleSetDesktopSetting(
      { type: 'desktop_set_desktop_setting', key: 'planModeAllowedBashCommands', value: ['gh', 'git log'] },
      'device-abc',
    )

    // Landed in engine.json.
    expect(engineStore.writes).toHaveLength(1)
    expect(engineStore.writes[0]).toEqual(['gh', 'git log'])

    // Never written into settings.json (the key must be stripped before the
    // settings.json write).
    for (const write of settingsStore.writes) {
      expect(write).not.toHaveProperty('planModeAllowedBashCommands')
    }
  })

  it('re-emits a desktop_settings_snapshot that reads the allowlist back from engine.json', async () => {
    // Simulate the store now holding the just-written value (the real store
    // would; our mock updates engineStore.allowlist on write).
    await handleSetDesktopSetting(
      { type: 'desktop_set_desktop_setting', key: 'planModeAllowedBashCommands', value: ['gh', 'git diff'] },
      'device-abc',
    )

    const snapshot = transport.sent.find((m) => m?.type === 'desktop_settings_snapshot')
    expect(snapshot, 'a settings snapshot was broadcast').toBeTruthy()
    expect(snapshot.settings.planModeAllowedBashCommands).toEqual(['gh', 'git diff'])
  })

  it('a normal (settings.json) key still lands in settings.json', async () => {
    await handleSetDesktopSetting(
      { type: 'desktop_set_desktop_setting', key: 'enableEarlyStopContinuation', value: true },
      'device-abc',
    )
    expect(settingsStore.writes.length).toBeGreaterThan(0)
    const last = settingsStore.writes.at(-1)!
    expect(last.enableEarlyStopContinuation).toBe(true)
    // And it did NOT get routed to the engine.json store.
    expect(engineStore.writes).toHaveLength(0)
  })
})
