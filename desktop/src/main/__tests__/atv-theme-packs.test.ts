/**
 * Theme-pack discovery + asset-read containment, exercised against the REAL
 * committed ion-works pack (bundledRoot resolves to desktop/resources under
 * vitest just as it does in the packaged app). The traversal cases pin the
 * resolve-and-contain guard on atv:read-theme-asset's backing function.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { listThemePacks, readPackBundle, readThemeAsset } from '../atv-theme-packs'

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
