// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyTheme,
  darkColors,
  getAllThemes,
  getTheme,
  onThemeRegistryChanged,
  registerCustomThemes,
  resolveCustomThemeDefinition,
  themes,
} from './theme-tokens'
import type { CustomThemeForRenderer } from '../shared/theme-pack-types'

function acmePayload(overrides: Partial<CustomThemeForRenderer> = {}): CustomThemeForRenderer {
  return {
    id: 'acme-corp',
    name: 'Acme Corp',
    version: '1.0.0',
    base: 'ion-dark',
    tokens: { accent: '#FF6600', containerBg: '#101013' },
    ...overrides,
  }
}

afterEach(() => {
  registerCustomThemes([])
})

describe('custom theme registry', () => {
  it('resolveCustomThemeDefinition spreads the base palette under the overlay', () => {
    const def = resolveCustomThemeDefinition(acmePayload())
    expect(def.id).toBe('acme-corp')
    expect(def.custom).toBe(true)
    expect(def.colors.accent).toBe('#FF6600')
    expect(def.colors.containerBg).toBe('#101013')
    // Unspecified tokens inherit the base (ion-dark) values.
    expect(def.colors.textPrimary).toBe(darkColors.textPrimary)
    // The resolved palette is complete — every ColorPalette key present.
    expect(Object.keys(def.colors).sort()).toEqual(Object.keys(darkColors).sort())
  })

  it('ignores unknown token keys in the payload', () => {
    const def = resolveCustomThemeDefinition(
      acmePayload({ tokens: { accent: '#FF6600', notAKey: '#000' } }),
    )
    expect((def.colors as Record<string, string>).notAKey).toBeUndefined()
  })

  it('inherits forcedColorScheme from the base when the pack omits it', () => {
    expect(resolveCustomThemeDefinition(acmePayload()).forcedColorScheme).toBe('dark')
    expect(
      resolveCustomThemeDefinition(acmePayload({ base: 'ion-light' })).forcedColorScheme,
    ).toBe('light')
    expect(
      resolveCustomThemeDefinition(acmePayload({ forcedColorScheme: 'light' })).forcedColorScheme,
    ).toBe('light')
  })

  it('getTheme resolves custom ids and falls back to ion-dark for stale ids', () => {
    registerCustomThemes([acmePayload()])
    expect(getTheme('acme-corp').displayName).toBe('Acme Corp')
    registerCustomThemes([])
    expect(getTheme('acme-corp').id).toBe('ion-dark')
  })

  it('getAllThemes lists built-ins first, then customs; registration notifies subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = onThemeRegistryChanged(listener)
    registerCustomThemes([acmePayload()])
    expect(listener).toHaveBeenCalledTimes(1)
    const all = getAllThemes()
    expect(all.slice(0, themes.length).map((t) => t.id)).toEqual(themes.map((t) => t.id))
    expect(all[all.length - 1].id).toBe('acme-corp')
    unsubscribe()
    registerCustomThemes([])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('applyTheme sets and clears the theme background-image var', () => {
    registerCustomThemes([
      acmePayload({ backgroundDataUrl: 'data:image/png;base64,AAAA' }),
    ])
    applyTheme('acme-corp')
    expect(
      document.documentElement.style.getPropertyValue('--ion-theme-background-image'),
    ).toBe('url("data:image/png;base64,AAAA")')
    applyTheme('ion-dark')
    expect(
      document.documentElement.style.getPropertyValue('--ion-theme-background-image'),
    ).toBe('')
  })
})
