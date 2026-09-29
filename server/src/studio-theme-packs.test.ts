/**
 * Theme-pack discovery + asset-read containment, exercised against the REAL
 * committed ion-works pack (the dev-checkout fallback resolves to
 * desktop/resources under vitest; the packaged desktop names the same packs
 * through ION_STUDIO_THEMES_BUNDLED_DIR). The traversal cases pin the
 * resolve-and-contain guard behind `studio.readThemeAsset`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { listThemePacks, readPackBundle, readThemeAsset, _setThemePackRootsForTest, BUNDLED_THEMES_DIR_ENV } from './studio-theme-packs'

afterEach(() => {
  _setThemePackRootsForTest(null)
  delete process.env[BUNDLED_THEMES_DIR_ENV]
})

describe('theme pack discovery', () => {
  it('lists the shipped ion-works pack as builtin', () => {
    const packs = listThemePacks()
    const ionWorks = packs.find((p) => p.id === 'ion-works')
    expect(ionWorks).toBeDefined()
    expect(ionWorks?.builtin).toBe(true)
  })

  it('reads the full raw bundle for a known pack', () => {
    const bundle = readPackBundle('ion-works')
    expect(bundle).not.toBeNull()
    expect(Object.keys(bundle!.characters)).toContain('mgr-blazer')
    expect(Object.keys(bundle!.dressing).sort()).toEqual(['break', 'corridor', 'department', 'lobby', 'mail', 'manager', 'meeting'])
    expect(bundle!.bubbles).not.toBeNull()
  })

  it('returns null for unknown or malformed pack ids', () => {
    expect(readPackBundle('no-such-pack')).toBeNull()
    expect(readPackBundle('../escape')).toBeNull()
    expect(readPackBundle('Bad Id')).toBeNull()
  })
})

describe('asset read containment', () => {
  it('serves a real asset inside the pack', () => {
    const buf = readThemeAsset('ion-works', 'characters/mgr-blazer/idle.png')
    expect(buf).not.toBeNull()
    // PNG signature.
    expect(buf![0]).toBe(0x89)
    expect(buf![1]).toBe(0x50)
  })

  it.each([
    ['relative traversal', '../../../package.json'],
    ['nested traversal', 'characters/../../ion-works/../../package.json'],
    ['absolute path', '/etc/hosts'],
    ['non-png file', 'theme.json'],
    ['missing file', 'characters/mgr-blazer/nope.png'],
    ['traversal with png suffix', '../../../icon.png'],
  ])('refuses %s', (_label, relPath) => {
    expect(readThemeAsset('ion-works', relPath)).toBeNull()
  })

  it('refuses reads from unknown packs entirely', () => {
    expect(readThemeAsset('no-such-pack', 'theme.png')).toBeNull()
  })
})

describe('root resolution', () => {
  it('reads bundled packs from the directory the environment names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-themes-'))
    mkdirSync(join(dir, 'custom-pack'))
    writeFileSync(join(dir, 'custom-pack', 'theme.json'), JSON.stringify({ id: 'custom-pack', name: 'Custom', version: '1.0.0' }))
    process.env[BUNDLED_THEMES_DIR_ENV] = dir
    const packs = listThemePacks()
    expect(packs.find((p) => p.id === 'custom-pack')).toEqual({ id: 'custom-pack', name: 'Custom', version: '1.0.0', builtin: true })
    expect(packs.find((p) => p.id === 'ion-works')).toBeUndefined()
  })

  it('serves only user packs when no bundled root exists (headless deployment)', () => {
    const user = mkdtempSync(join(tmpdir(), 'ion-user-themes-'))
    mkdirSync(join(user, 'mine'))
    writeFileSync(join(user, 'mine', 'theme.json'), JSON.stringify({ id: 'mine', name: 'Mine', version: '0.1.0' }))
    _setThemePackRootsForTest({ bundled: null, user })
    expect(listThemePacks()).toEqual([{ id: 'mine', name: 'Mine', version: '0.1.0', builtin: false }])
  })
})
