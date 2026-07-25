import { describe, expect, it } from 'vitest'
import {
  BUILTIN_THEME_IDS,
  IOS_THEME_TOKEN_KEYS,
  validateThemePackManifest,
} from './theme-pack-types'

const DESKTOP_KEYS = new Set(['accent', 'containerBg', 'textPrimary'])

function fullIosTokens(): Record<string, string> {
  return Object.fromEntries(IOS_THEME_TOKEN_KEYS.map((k) => [k, '#FF6600FF']))
}

function validManifest(): Record<string, unknown> {
  return {
    id: 'acme-corp',
    name: 'Acme Corp',
    version: '1.0.0',
    desktop: { base: 'ion-dark', tokens: { accent: '#FF6600' } },
    ios: { preferredColorScheme: 'dark', tokens: fullIosTokens() },
  }
}

describe('validateThemePackManifest', () => {
  it('accepts a pack with both components', () => {
    const r = validateThemePackManifest(validManifest(), 'acme-corp', DESKTOP_KEYS)
    expect(r.ok).toBe(true)
    expect(r.pack?.desktop?.base).toBe('ion-dark')
    expect(r.pack?.desktop?.tokens.accent).toBe('#FF6600')
    expect(r.pack?.ios?.preferredColorScheme).toBe('dark')
    expect(Object.keys(r.pack?.ios?.tokens ?? {})).toHaveLength(IOS_THEME_TOKEN_KEYS.length)
  })

  it('accepts a desktop-only pack', () => {
    const m = validManifest()
    delete m.ios
    const r = validateThemePackManifest(m, 'acme-corp', DESKTOP_KEYS)
    expect(r.ok).toBe(true)
    expect(r.pack?.ios).toBeUndefined()
    expect(r.pack?.desktop).toBeDefined()
  })

  it('accepts an ios-only pack', () => {
    const m = validManifest()
    delete m.desktop
    const r = validateThemePackManifest(m, 'acme-corp', DESKTOP_KEYS)
    expect(r.ok).toBe(true)
    expect(r.pack?.desktop).toBeUndefined()
    expect(r.pack?.ios).toBeDefined()
  })

  it('rejects non-object input', () => {
    expect(validateThemePackManifest('nope', 'acme-corp', DESKTOP_KEYS).ok).toBe(false)
    expect(validateThemePackManifest(null, 'acme-corp', DESKTOP_KEYS).ok).toBe(false)
  })

  it('rejects an id that does not match the directory name', () => {
    const r = validateThemePackManifest(validManifest(), 'other-dir', DESKTOP_KEYS)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('does not match directory')
  })

  it('rejects reserved built-in ids', () => {
    for (const id of BUILTIN_THEME_IDS) {
      const m = { ...validManifest(), id }
      const r = validateThemePackManifest(m, id, DESKTOP_KEYS)
      expect(r.ok).toBe(false)
      expect(r.error).toContain('built-in')
    }
  })

  it('rejects a pack with no usable component', () => {
    const r = validateThemePackManifest({ id: 'acme-corp', name: 'x' }, 'acme-corp', DESKTOP_KEYS)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('no usable')
  })

  it('drops unknown desktop tokens with a warning (non-fatal)', () => {
    const m = validManifest()
    ;(m.desktop as Record<string, unknown>).tokens = { accent: '#FF6600', notAToken: '#000000' }
    const r = validateThemePackManifest(m, 'acme-corp', DESKTOP_KEYS)
    expect(r.ok).toBe(true)
    expect(r.pack?.desktop?.tokens.notAToken).toBeUndefined()
    expect(r.pack?.desktop?.tokens.accent).toBe('#FF6600')
    expect(r.warnings.some((w) => w.includes('notAToken'))).toBe(true)
  })

  it('drops unsafe desktop token values', () => {
    const m = validManifest()
    ;(m.desktop as Record<string, unknown>).tokens = {
      accent: 'red; background: url(https://evil.example/x)',
      containerBg: 'url(https://evil.example/y)',
      textPrimary: '#fff',
    }
    const r = validateThemePackManifest(m, 'acme-corp', DESKTOP_KEYS)
    expect(r.ok).toBe(true)
    expect(r.pack?.desktop?.tokens.accent).toBeUndefined()
    expect(r.pack?.desktop?.tokens.containerBg).toBeUndefined()
    expect(r.pack?.desktop?.tokens.textPrimary).toBe('#fff')
  })

  it('rejects the desktop component when base is not a built-in (desktop-only pack becomes invalid)', () => {
    const m = validManifest()
    delete m.ios
    ;(m.desktop as Record<string, unknown>).base = 'acme-other'
    const r = validateThemePackManifest(m, 'acme-corp', DESKTOP_KEYS)
    expect(r.ok).toBe(false)
  })

  it('rejects the ios component when tokens are missing, keeping the desktop component', () => {
    const m = validManifest()
    const tokens = fullIosTokens()
    delete tokens.accent
    ;(m.ios as Record<string, unknown>).tokens = tokens
    const r = validateThemePackManifest(m, 'acme-corp', DESKTOP_KEYS)
    expect(r.ok).toBe(true)
    expect(r.pack?.ios).toBeUndefined()
    expect(r.pack?.desktop).toBeDefined()
    expect(r.warnings.some((w) => w.includes('accent'))).toBe(true)
  })

  it('rejects the ios component when a token is not hex', () => {
    const m = validManifest()
    const tokens = fullIosTokens()
    tokens.accent = 'rgba(1,2,3,0.5)'
    ;(m.ios as Record<string, unknown>).tokens = tokens
    const r = validateThemePackManifest(m, 'acme-corp', DESKTOP_KEYS)
    expect(r.ok).toBe(true)
    expect(r.pack?.ios).toBeUndefined()
  })

  it('drops malformed asset refs but keeps valid ones', () => {
    const m = validManifest()
    ;(m.desktop as Record<string, unknown>).assets = { background: 'assets/bg.png', logo: 42 }
    const r = validateThemePackManifest(m, 'acme-corp', DESKTOP_KEYS)
    expect(r.ok).toBe(true)
    expect(r.pack?.desktop?.assets?.background).toBe('assets/bg.png')
    expect(r.pack?.desktop?.assets?.logo).toBeUndefined()
  })

  it('defaults name and version when absent', () => {
    const m = validManifest()
    delete m.name
    delete m.version
    const r = validateThemePackManifest(m, 'acme-corp', DESKTOP_KEYS)
    expect(r.ok).toBe(true)
    expect(r.pack?.name).toBe('acme-corp')
    expect(r.pack?.version).toBe('0.0.0')
  })
})
