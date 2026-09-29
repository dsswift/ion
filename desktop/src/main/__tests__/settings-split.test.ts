/**
 * settings-split: partitions a pre-split settings.json into desktop.json
 * (device keys) + a trimmed settings.json (server keys), with a byte-for-byte
 * backup and a verified round trip (spec 12 §Acceptance Criteria "Split test").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn((_p: string) => false),
  copyFileSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  unlinkSync: vi.fn(),
  readSettings: vi.fn(() => ({}) as Record<string, unknown>),
  writeSettings: vi.fn(),
  deviceStore: {} as Record<string, unknown>,
}))

vi.mock('fs', () => ({
  existsSync: mocks.existsSync,
  copyFileSync: mocks.copyFileSync,
  readFileSync: mocks.readFileSync,
  unlinkSync: mocks.unlinkSync,
  mkdirSync: vi.fn(),
}))
vi.mock('@ion/server/persistence/settings-store', () => ({
  settingsFile: () => '/fake/.ion/settings.json',
  readSettings: mocks.readSettings,
  writeSettings: mocks.writeSettings,
}))
vi.mock('@ion/server/utils/atomicWrite', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../device-settings', () => ({
  DEVICE_KEYS: [
    'logLevel', 'selectedTheme', 'soundEnabled',
    'showDirLabel', 'preferredOpenWith', 'expandToolResults',
    'terminalFontFamily', 'terminalFontSize', 'showHiddenFiles',
    'studioTheme', 'studioZoom', 'studioSeed', 'studioHeat',
    'studioBeacon', 'studioSound', 'studioLayout', 'studioSurface',
    'studioShortcut',
  ],
  deviceSettingsFile: vi.fn(() => '/fake/.ion/desktop.json'),
  readDeviceSettings: vi.fn(() => mocks.deviceStore),
  writeDeviceSettings: vi.fn((data: Record<string, unknown>) => {
    mocks.deviceStore = data
  }),
}))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { runSettingsSplit, stripStaleDeviceKeys, rollbackSettingsSplit, preSplitBackupFile, LEGACY_SETTINGS_KEYS, returnStrandedServerKeys } from '../settings-split'
import { writeDeviceSettings } from '../device-settings'

const LEGACY_SETTINGS = {
  logLevel: 'INFO',
  selectedTheme: 'ion-light',
  soundEnabled: false,
  defaultBaseDirectory: '/home/x',
  showDirLabel: false,
  preferredOpenWith: 'vscode',
  expandToolResults: true,
  terminalFontFamily: 'monospace',
  terminalFontSize: 14,
  showHiddenFiles: true,
  studioTheme: 'ion-works',
  studioZoom: 0,
  studioSeed: '',
  studioHeat: false,
  studioSound: true,
  studioBeacon: true,
  studioLayout: { leftSidebarVisible: false },
  studioSurface: { version: 4 },
  studioPlaywrightEnabled: true,
  studioTabStripVisible: true,
  studioShortcut: 'Alt+Shift+Space',
  activeUi: 'overlay',
  activeUiPolicy: { mode: 'both' },
  surfacePolicy: 'both',
  launchSurface: 'overlay',
  // server-owned keys that must survive untouched
  allowSettingsEdits: false,
  preferredModel: 'claude-opus-4-6',
  projects: { '/home/x': { addedManually: true, lastUsedAt: 1 } },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.deviceStore = {}
  mocks.readSettings.mockReturnValue(structuredClone(LEGACY_SETTINGS))
})

describe('runSettingsSplit', () => {
  it('is a no-op when desktop.json already exists', () => {
    mocks.existsSync.mockImplementation((p: string) => p === '/fake/.ion/desktop.json')
    const outcome = runSettingsSplit()
    expect(outcome).toEqual({ ran: false, reason: 'already-split' })
    expect(mocks.copyFileSync).not.toHaveBeenCalled()
  })

  it('is a no-op when there is no settings.json to split', () => {
    mocks.existsSync.mockReturnValue(false)
    const outcome = runSettingsSplit()
    expect(outcome).toEqual({ ran: false, reason: 'no-settings-file' })
  })

  it('backs up settings.json byte-for-byte before writing anything', () => {
    mocks.existsSync.mockImplementation((p: string) => p === '/fake/.ion/settings.json')
    runSettingsSplit()
    expect(mocks.copyFileSync).toHaveBeenCalledWith('/fake/.ion/settings.json', preSplitBackupFile())
  })

  it('moves exactly the device keys to desktop.json and strips them (plus legacy keys) from settings.json', () => {
    mocks.existsSync.mockImplementation((p: string) => p === '/fake/.ion/settings.json')
    const outcome = runSettingsSplit()
    expect(outcome.ran).toBe(true)
    expect(outcome.reason).toBe('success')

    const written = vi.mocked(writeDeviceSettings).mock.calls[0][0]
    expect(written.logLevel).toBe('INFO')
    expect(written.studioLayout).toEqual({ leftSidebarVisible: false })
    // No server key or legacy key leaked into desktop.json.
    expect(written).not.toHaveProperty('allowSettingsEdits')
    expect(written).not.toHaveProperty('defaultBaseDirectory')
    expect(written).not.toHaveProperty('activeUi')

    const remaining = mocks.writeSettings.mock.calls[0][0] as Record<string, unknown>
    // Server settings stay; a retired key no device list names is not the
    // split's to remove.
    const serverKeys = new Set(['allowSettingsEdits', 'preferredModel', 'projects', 'defaultBaseDirectory', 'studioPlaywrightEnabled', 'studioTabStripVisible'])
    for (const key of Object.keys(LEGACY_SETTINGS)) {
      if (serverKeys.has(key)) continue
      expect(remaining).not.toHaveProperty(key)
    }
    expect(remaining.allowSettingsEdits).toBe(false)
    // An Account setting: the server reads it, so it stays on the server.
    expect(remaining.defaultBaseDirectory).toBe('/home/x')
    expect(remaining.studioPlaywrightEnabled).toBe(true)
    expect(remaining.preferredModel).toBe('claude-opus-4-6')
    for (const key of LEGACY_SETTINGS_KEYS) expect(remaining).not.toHaveProperty(key)
  })

  it('fails verification (and never writes settings.json) when a device key does not round-trip', () => {
    mocks.existsSync.mockImplementation((p: string) => p === '/fake/.ion/settings.json')
    vi.mocked(writeDeviceSettings).mockImplementationOnce(() => {
      mocks.deviceStore = { logLevel: 'CORRUPTED' }
    })
    const outcome = runSettingsSplit()
    expect(outcome.reason).toBe('verify-failed')
    expect(mocks.writeSettings).not.toHaveBeenCalled()
  })
})

describe('stripStaleDeviceKeys', () => {
  it('strips device keys that reappeared in settings.json after the split', () => {
    mocks.existsSync.mockImplementation((p: string) => p === '/fake/.ion/settings.json')
    mocks.readSettings.mockReturnValue({ allowSettingsEdits: true, studioZoom: 2, activeUi: 'studio' })
    const stale = stripStaleDeviceKeys()
    expect(stale).toEqual(expect.arrayContaining(['studioZoom', 'activeUi']))
    const written = mocks.writeSettings.mock.calls[0][0] as Record<string, unknown>
    expect(written).toEqual({ allowSettingsEdits: true })
  })

  it('is a no-op when nothing is stale', () => {
    mocks.existsSync.mockImplementation((p: string) => p === '/fake/.ion/settings.json')
    mocks.readSettings.mockReturnValue({ allowSettingsEdits: true })
    expect(stripStaleDeviceKeys()).toEqual([])
    expect(mocks.writeSettings).not.toHaveBeenCalled()
  })
})

describe('rollbackSettingsSplit', () => {
  it('restores settings.json from the backup and removes desktop.json', () => {
    mocks.existsSync.mockReturnValue(true)
    mocks.readFileSync.mockReturnValue('{"original":true}')
    const result = rollbackSettingsSplit()
    expect(result).toEqual({ restored: true, reason: 'success' })
    expect(mocks.unlinkSync).toHaveBeenCalledWith('/fake/.ion/desktop.json')
  })

  it('reports no-backup when the pre-split file is absent', () => {
    mocks.existsSync.mockReturnValue(false)
    expect(rollbackSettingsSplit()).toEqual({ restored: false, reason: 'no-backup' })
  })
})

describe('returnStrandedServerKeys', () => {
  const deviceFile = (content: Record<string, unknown>): void => {
    mocks.existsSync.mockImplementation((p: string) => p === '/fake/.ion/desktop.json')
    mocks.readFileSync.mockReturnValue(JSON.stringify(content) as never)
  }

  it('moves a server setting the server lacks back to settings.json, and leaves device keys', () => {
    deviceFile({ selectedTheme: 'dusk', defaultBaseDirectory: '/work/ion', studioPlaywrightEnabled: false })
    mocks.readSettings.mockReturnValue({ preferredModel: 'm' })

    const outcome = returnStrandedServerKeys()

    expect(outcome.restored.sort()).toEqual(['defaultBaseDirectory', 'studioPlaywrightEnabled'])
    expect(mocks.writeSettings).toHaveBeenCalledWith({ preferredModel: 'm', defaultBaseDirectory: '/work/ion', studioPlaywrightEnabled: false })
    expect(mocks.deviceStore).toEqual({ selectedTheme: 'dusk' })
  })

  it('keeps the server value when both hold one, and drops the device copy', () => {
    deviceFile({ allowSettingsEdits: false, selectedTheme: 'dusk' })
    mocks.readSettings.mockReturnValue({ allowSettingsEdits: true })

    const outcome = returnStrandedServerKeys()

    expect(outcome).toEqual({ restored: [], discarded: ['allowSettingsEdits'] })
    expect(mocks.writeSettings).not.toHaveBeenCalled()
    expect(mocks.deviceStore).toEqual({ selectedTheme: 'dusk' })
  })

  it('writes nothing when desktop.json holds no server setting', () => {
    deviceFile({ selectedTheme: 'dusk', environments: [] })
    expect(returnStrandedServerKeys()).toEqual({ restored: [], discarded: [] })
    expect(mocks.writeSettings).not.toHaveBeenCalled()
    expect(writeDeviceSettings).not.toHaveBeenCalled()
  })
})
