import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IOS_THEME_TOKEN_KEYS } from '../shared/theme-pack-types'

vi.mock('./logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

import {
  buildThemeManifest,
  customThemeChoices,
  getRendererThemes,
  getThemePacks,
  isKnownDesktopThemeId,
  onThemePacksChanged,
  readIosThemeAsset,
  rescanThemePacks,
  resetThemePacksForTest,
  THEME_ASSET_MAX_BYTES,
} from './theme-packs'

// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

let userRoot: string
let systemRoot: string

function iosTokens(): Record<string, string> {
  return Object.fromEntries(IOS_THEME_TOKEN_KEYS.map((k) => [k, '#33C3F7FF']))
}

function writePack(
  root: string,
  id: string,
  manifest: Record<string, unknown>,
  assets: Record<string, Buffer> = {},
): void {
  const dir = join(root, id)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'theme.json'), JSON.stringify(manifest))
  for (const [rel, bytes] of Object.entries(assets)) {
    writeFileSync(join(dir, rel), bytes)
  }
}

function basicManifest(id: string): Record<string, unknown> {
  return {
    id,
    name: `Theme ${id}`,
    version: '1.0.0',
    desktop: { base: 'ion-dark', tokens: { accent: '#FF6600' } },
    ios: { tokens: iosTokens() },
  }
}

beforeEach(() => {
  userRoot = mkdtempSync(join(tmpdir(), 'ion-themes-user-'))
  systemRoot = mkdtempSync(join(tmpdir(), 'ion-themes-system-'))
  resetThemePacksForTest({ user: userRoot, system: systemRoot })
})

afterEach(() => {
  resetThemePacksForTest()
  rmSync(userRoot, { recursive: true, force: true })
  rmSync(systemRoot, { recursive: true, force: true })
})

describe('theme pack scanning', () => {
  it('loads a valid pack with both components', () => {
    writePack(userRoot, 'acme-corp', basicManifest('acme-corp'))
    const packs = getThemePacks()
    expect(packs).toHaveLength(1)
    expect(packs[0].manifest.id).toBe('acme-corp')
    expect(packs[0].source).toBe('user')
    expect(packs[0].manifest.desktop?.tokens.accent).toBe('#FF6600')
    expect(packs[0].manifest.ios).toBeDefined()
  })

  it('skips invalid JSON and dirs without theme.json', () => {
    mkdirSync(join(userRoot, 'no-manifest'), { recursive: true })
    const dir = join(userRoot, 'broken-json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'theme.json'), '{not json')
    expect(getThemePacks()).toHaveLength(0)
  })

  it('refuses a pack claiming a built-in id', () => {
    writePack(userRoot, 'ion-dark', basicManifest('ion-dark'))
    expect(getThemePacks()).toHaveLength(0)
  })

  it('refuses a pack whose id mismatches its directory', () => {
    writePack(userRoot, 'dir-name', basicManifest('other-id'))
    expect(getThemePacks()).toHaveLength(0)
  })

  it('system pack shadows user pack on id collision (enterprise wins)', () => {
    writePack(userRoot, 'acme-corp', {
      ...basicManifest('acme-corp'),
      name: 'User Copy',
    })
    writePack(systemRoot, 'acme-corp', {
      ...basicManifest('acme-corp'),
      name: 'System Copy',
    })
    const packs = getThemePacks()
    expect(packs).toHaveLength(1)
    expect(packs[0].source).toBe('system')
    expect(packs[0].manifest.name).toBe('System Copy')
  })
})

describe('assets', () => {
  it('validates and hashes a declared asset', () => {
    const m = basicManifest('acme-corp')
    ;(m.ios as Record<string, unknown>).assets = { background: 'assets/bg.png' }
    writePack(userRoot, 'acme-corp', m, { 'assets/bg.png': PNG_BYTES })
    const packs = getThemePacks()
    expect(packs[0].iosAssets).toHaveLength(1)
    expect(packs[0].iosAssets[0].slot).toBe('background')
    expect(packs[0].iosAssets[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(packs[0].iosAssets[0].mime).toBe('image/png')
  })

  it('drops an asset that escapes the pack root', () => {
    const m = basicManifest('acme-corp')
    ;(m.desktop as Record<string, unknown>).assets = { background: '../outside.png' }
    writePack(userRoot, 'acme-corp', m)
    writeFileSync(join(userRoot, 'outside.png'), PNG_BYTES)
    expect(getThemePacks()[0].desktopAssets).toHaveLength(0)
  })

  it('drops an oversized asset', () => {
    const m = basicManifest('acme-corp')
    ;(m.ios as Record<string, unknown>).assets = { background: 'assets/big.png' }
    writePack(userRoot, 'acme-corp', m, {
      'assets/big.png': Buffer.alloc(THEME_ASSET_MAX_BYTES + 1),
    })
    expect(getThemePacks()[0].iosAssets).toHaveLength(0)
  })

  it('drops an unsupported asset type', () => {
    const m = basicManifest('acme-corp')
    ;(m.ios as Record<string, unknown>).assets = { logo: 'assets/logo.svg' }
    writePack(userRoot, 'acme-corp', m, { 'assets/logo.svg': Buffer.from('<svg/>') })
    expect(getThemePacks()[0].iosAssets).toHaveLength(0)
  })

  it('serves an ios asset as a data URL with its scan-time hash', () => {
    const m = basicManifest('acme-corp')
    ;(m.ios as Record<string, unknown>).assets = { background: 'assets/bg.png' }
    writePack(userRoot, 'acme-corp', m, { 'assets/bg.png': PNG_BYTES })
    getThemePacks()
    const asset = readIosThemeAsset('acme-corp', 'background')
    expect(asset).not.toBeNull()
    expect(asset!.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(asset!.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns null for an undeclared slot or unknown pack', () => {
    writePack(userRoot, 'acme-corp', basicManifest('acme-corp'))
    getThemePacks()
    expect(readIosThemeAsset('acme-corp', 'background')).toBeNull()
    expect(readIosThemeAsset('nonexistent', 'logo')).toBeNull()
  })
})

describe('rescan + consumers', () => {
  it('rescan detects pack-set changes and notifies listeners', () => {
    writePack(userRoot, 'acme-corp', basicManifest('acme-corp'))
    getThemePacks()
    const listener = vi.fn()
    onThemePacksChanged(listener)

    // No change → no notification.
    expect(rescanThemePacks()).toBe(false)
    expect(listener).not.toHaveBeenCalled()

    // New pack → change + notification.
    writePack(userRoot, 'beta-theme', basicManifest('beta-theme'))
    expect(rescanThemePacks()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    // Removal → change + notification.
    rmSync(join(userRoot, 'beta-theme'), { recursive: true, force: true })
    expect(rescanThemePacks()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('isKnownDesktopThemeId accepts built-ins and installed desktop packs only', () => {
    const builtins = ['ion-dark', 'ion-light', 'ion-classic', 'jarvis-hud']
    const iosOnly = basicManifest('ios-only-pack')
    delete iosOnly.desktop
    writePack(userRoot, 'acme-corp', basicManifest('acme-corp'))
    writePack(userRoot, 'ios-only-pack', iosOnly)
    expect(isKnownDesktopThemeId('ion-dark', builtins)).toBe(true)
    expect(isKnownDesktopThemeId('acme-corp', builtins)).toBe(true)
    expect(isKnownDesktopThemeId('ios-only-pack', builtins)).toBe(false)
    expect(isKnownDesktopThemeId('unknown', builtins)).toBe(false)
  })

  it('customThemeChoices lists desktop-component packs by display name', () => {
    writePack(userRoot, 'acme-corp', basicManifest('acme-corp'))
    const iosOnly = basicManifest('ios-only-pack')
    delete iosOnly.desktop
    writePack(userRoot, 'ios-only-pack', iosOnly)
    expect(customThemeChoices()).toEqual([{ value: 'acme-corp', label: 'Theme acme-corp' }])
  })

  it('buildThemeManifest ships ios components only, with asset descriptors and a stable hash', () => {
    const withAsset = basicManifest('acme-corp')
    ;(withAsset.ios as Record<string, unknown>).assets = { background: 'assets/bg.png' }
    ;(withAsset.ios as Record<string, unknown>).preferredColorScheme = 'dark'
    writePack(userRoot, 'acme-corp', withAsset, { 'assets/bg.png': PNG_BYTES })
    const desktopOnly = basicManifest('desktop-only-pack')
    delete desktopOnly.ios
    writePack(userRoot, 'desktop-only-pack', desktopOnly)

    const manifest = buildThemeManifest()
    // Desktop-only packs never ride the wire.
    expect(manifest.themes.map((t) => t.id)).toEqual(['acme-corp'])
    expect(manifest.themes[0].preferredColorScheme).toBe('dark')
    expect(Object.keys(manifest.themes[0].tokens)).toHaveLength(15)
    expect(manifest.themes[0].assets).toHaveLength(1)
    expect(manifest.themes[0].assets![0].slot).toBe('background')
    expect(manifest.themes[0].assets![0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.hash).toMatch(/^[0-9a-f]{64}$/)

    // Hash is stable for an unchanged pack set.
    expect(buildThemeManifest().hash).toBe(manifest.hash)
  })

  it('getRendererThemes inlines desktop assets as data URLs', () => {
    const m = basicManifest('acme-corp')
    ;(m.desktop as Record<string, unknown>).assets = {
      background: 'assets/bg.png',
      logo: 'assets/logo.png',
    }
    writePack(userRoot, 'acme-corp', m, {
      'assets/bg.png': PNG_BYTES,
      'assets/logo.png': PNG_BYTES,
    })
    const themes = getRendererThemes()
    expect(themes).toHaveLength(1)
    expect(themes[0].base).toBe('ion-dark')
    expect(themes[0].backgroundDataUrl?.startsWith('data:image/png;base64,')).toBe(true)
    expect(themes[0].logoDataUrl?.startsWith('data:image/png;base64,')).toBe(true)
  })
})
