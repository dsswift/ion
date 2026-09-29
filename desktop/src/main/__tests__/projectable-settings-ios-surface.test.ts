import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return false
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

vi.mock('../plan-bash-allowlist-store', () => ({
  readPlanBashAllowlist: () => [],
  writePlanBashAllowlist: vi.fn(),
}))

vi.mock('@ion/server/thin-view/remote-out', () => ({
  thinConnections: vi.fn(() => []),
  sendThinEventTo: vi.fn(() => true),
}))

vi.mock('@ion/server/theme-policy', () => ({
  getEnterpriseThemePolicy: () => null,
  isThemeLocked: () => false,
}))

import {
  PROJECTABLE_SETTINGS,
  PROJECTABLE_GROUP_ORDER,
  projectCurrentSettings,
  projectableGroups,
} from '@ion/server/projectable-settings'
import { CONNECTION_CRITICAL_KEYS } from '@ion/server/projectable-settings-data'
import { broadcastDesktopSettingsSnapshot } from '@ion/server/settings-broadcast'
import * as settingsStore from '@ion/server/persistence/settings-store'
import { sendThinEventTo, thinConnections } from '@ion/server/thin-view/remote-out'

describe('projectable settings iOS surface', () => {
  let readSettingsSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    readSettingsSpy = vi.spyOn(settingsStore, 'readSettings')
    readSettingsSpy.mockReturnValue({})
  })

  afterEach(() => {
    readSettingsSpy.mockRestore()
  })

  it('every entry declares a valid iosSurface', () => {
    const valid = new Set(['phone-critical', 'phone', 'desktop-only'])
    for (const entry of PROJECTABLE_SETTINGS) {
      expect(
        valid.has(entry.iosSurface),
        `entry ${entry.key}: iosSurface=${entry.iosSurface}`,
      ).toBe(true)
    }
  })

  it('classifies every connection-critical key as phone-critical', () => {
    for (const key of CONNECTION_CRITICAL_KEYS) {
      const entry = PROJECTABLE_SETTINGS.find((setting) => setting.key === key)
      expect(entry, `${key} must be projectable`).toBeTruthy()
      expect(entry?.iosSurface, `${key} must survive on phone`).toBe(
        'phone-critical',
      )
    }
  })

  it('classifies selectedTheme as desktop-only because theme selection is per-device', () => {
    expect(
      PROJECTABLE_SETTINGS.find((setting) => setting.key === 'selectedTheme')
        ?.iosSurface,
    ).toBe('desktop-only')
  })

  it('excludes desktop-only settings and includes every phone setting', () => {
    const out = projectCurrentSettings()
    for (const entry of PROJECTABLE_SETTINGS) {
      if (entry.iosSurface === 'desktop-only') {
        expect(out, `desktop-only key ${entry.key} absent`).not.toHaveProperty(
          entry.key,
        )
      } else {
        expect(out, `phone key ${entry.key} present`).toHaveProperty(entry.key)
        expect(out[entry.key], `phone key ${entry.key} default`).toEqual(
          entry.defaultValue,
        )
      }
    }
  })

  it('filters groups to groups with visible settings', () => {
    const expected = PROJECTABLE_GROUP_ORDER.filter((group) =>
      PROJECTABLE_SETTINGS.some(
        (setting) =>
          setting.group === group && setting.iosSurface !== 'desktop-only',
      ),
    )
    expect(projectableGroups().map((group) => group.id)).toEqual(expected)
  })

  it('emits no desktop-only setting in desktop_settings_snapshot', () => {
    // The snapshot goes out through the thin view's fan-out now, and only
    // when a client is attached -- `broadcastDesktopSettingsSnapshot` returns
    // early otherwise.
    const sent: unknown[] = []
    vi.mocked(thinConnections).mockReturnValue([{ id: 'phone', principal: { subject: 'local:operator' }, scopes: ['admin'] }] as never)
    vi.mocked(sendThinEventTo).mockImplementation((_conn: unknown, event: unknown) => { sent.push(event); return true })
    broadcastDesktopSettingsSnapshot('ios surface test')
    const snapshot = sent.find(
      (message: any) => message?.type === 'desktop_settings_snapshot',
    ) as any
    expect(snapshot, 'desktop settings snapshot').toBeTruthy()
    for (const entry of PROJECTABLE_SETTINGS.filter(
      (setting) => setting.iosSurface === 'desktop-only',
    )) {
      expect(
        snapshot.settings,
        `desktop-only key ${entry.key} absent from emission`,
      ).not.toHaveProperty(entry.key)
      expect(
        snapshot.schema.map((item: { key: string }) => item.key),
      ).not.toContain(entry.key)
    }
  })
})
