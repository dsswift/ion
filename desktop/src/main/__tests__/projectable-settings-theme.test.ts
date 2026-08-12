/**
 * Theme-specific projectable-settings behavior, split from
 * projectable-settings.test.ts at the 600-line cap:
 *
 *   1. `selectedTheme` validation consults the LIVE theme registry
 *      (built-ins + installed packs with a desktop component), not the
 *      static choices — the regression that silently rejected custom-pack
 *      ids written from iOS.
 *   2. `selectedTheme` stays desktop-only even when packs are installed.
 *   3. Enterprise policy does not override an omitted phone projection.
 */
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
  readPlanBashAllowlist: vi.fn(() => [] as string[]),
  writePlanBashAllowlist: vi.fn(),
}))

// Enterprise theme policy: controllable so the lock tests set it without
// importing the full main-process state module.
const themePolicyMock = vi.hoisted(() => ({
  getEnterpriseThemePolicy: vi.fn(
    (): { themeId: string; locked: boolean } | null => null,
  ),
}))
vi.mock('../theme-policy', () => ({
  getEnterpriseThemePolicy: () => themePolicyMock.getEnterpriseThemePolicy(),
  isThemeLocked: () =>
    themePolicyMock.getEnterpriseThemePolicy()?.locked === true,
}))

import {
  validateSettingValue,
  projectableSchema,
  projectCurrentSettings,
} from '../projectable-settings'
import * as settingsStore from '../settings-store'
import { resetThemePacksForTest } from '../theme-packs'
import { IOS_THEME_TOKEN_KEYS } from '../../shared/theme-pack-types'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let themesUserRoot: string
let themesSystemRoot: string

function installThemePack(
  id: string,
  opts: { desktop?: boolean; ios?: boolean } = { desktop: true },
): void {
  const dir = join(themesUserRoot, id)
  mkdirSync(dir, { recursive: true })
  const manifest: Record<string, unknown> = {
    id,
    name: `Pack ${id}`,
    version: '1.0.0',
  }
  if (opts.desktop)
    manifest.desktop = { base: 'ion-dark', tokens: { accent: '#FF6600' } }
  if (opts.ios) {
    manifest.ios = {
      tokens: Object.fromEntries(
        IOS_THEME_TOKEN_KEYS.map((k) => [k, '#FF6600FF']),
      ),
    }
  }
  writeFileSync(join(dir, 'theme.json'), JSON.stringify(manifest))
  resetThemePacksForTest({ user: themesUserRoot, system: themesSystemRoot })
}

beforeEach(() => {
  themesUserRoot = mkdtempSync(join(tmpdir(), 'ion-proj-theme-user-'))
  themesSystemRoot = mkdtempSync(join(tmpdir(), 'ion-proj-theme-system-'))
  resetThemePacksForTest({ user: themesUserRoot, system: themesSystemRoot })
  themePolicyMock.getEnterpriseThemePolicy.mockReturnValue(null)
})

afterEach(() => {
  resetThemePacksForTest()
  rmSync(themesUserRoot, { recursive: true, force: true })
  rmSync(themesSystemRoot, { recursive: true, force: true })
})

describe('validateSettingValue: selectedTheme against the live registry', () => {
  it('accepts built-in ids with no packs installed', () => {
    for (const id of ['ion-dark', 'ion-light', 'ion-classic', 'jarvis-hud']) {
      expect(validateSettingValue('selectedTheme', id)).toBeNull()
    }
  })

  it('accepts an installed custom pack id (dynamic registry, not static choices)', () => {
    // Regression pin: before the registry-backed validation, this write was
    // silently rejected because the static enum choices only list built-ins.
    installThemePack('acme-corp', { desktop: true })
    expect(validateSettingValue('selectedTheme', 'acme-corp')).toBeNull()
  })

  it('rejects unknown ids and ios-only pack ids', () => {
    installThemePack('ios-only-pack', { desktop: false, ios: true })
    expect(
      validateSettingValue('selectedTheme', 'not-installed'),
    ).not.toBeNull()
    expect(
      validateSettingValue('selectedTheme', 'ios-only-pack'),
    ).not.toBeNull()
    expect(validateSettingValue('selectedTheme', null)).not.toBeNull()
  })
})

describe('projectableSchema: selectedTheme scope', () => {
  let readSettingsSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    readSettingsSpy = vi.spyOn(settingsStore, 'readSettings')
    readSettingsSpy.mockReturnValue({})
  })

  afterEach(() => {
    readSettingsSpy.mockRestore()
  })

  it('omits selectedTheme from phone schema even when desktop packs are installed', () => {
    expect(
      projectableSchema().find((s) => s.key === 'selectedTheme'),
    ).toBeUndefined()
    installThemePack('acme-corp', { desktop: true })
    expect(
      projectableSchema().find((s) => s.key === 'selectedTheme'),
    ).toBeUndefined()
  })
})

describe('projectCurrentSettings: selectedTheme scope', () => {
  let readSettingsSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    readSettingsSpy = vi.spyOn(settingsStore, 'readSettings')
  })

  afterEach(() => {
    readSettingsSpy.mockRestore()
  })

  it('omits selectedTheme from projection even when policy is locked', () => {
    readSettingsSpy.mockReturnValue({ selectedTheme: 'ion-light' })
    themePolicyMock.getEnterpriseThemePolicy.mockReturnValue({
      themeId: 'ion-classic',
      locked: true,
    })
    expect(projectCurrentSettings()).not.toHaveProperty('selectedTheme')
  })

  it('omits selectedTheme from projection when managed policy is unlocked', () => {
    readSettingsSpy.mockReturnValue({ selectedTheme: 'ion-light' })
    themePolicyMock.getEnterpriseThemePolicy.mockReturnValue({
      themeId: 'ion-classic',
      locked: false,
    })
    expect(projectCurrentSettings()).not.toHaveProperty('selectedTheme')
  })
})
