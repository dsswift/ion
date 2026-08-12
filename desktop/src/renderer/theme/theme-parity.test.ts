/**
 * Cross-platform theme parity — desktop side.
 *
 * The shared fixture (repo-root `assets/theme-parity.json`) pins the iOS
 * token values of the shared built-in themes to their desktop palette
 * sources. This test asserts the desktop half of the contract: for every
 * fixture entry, the named desktop palette token resolves to exactly the
 * fixture's #RRGGBBAA value. The iOS half is ThemeParityTests.swift.
 *
 * A palette edit that changes a mapped token fails here until the fixture
 * (and the Swift theme) are updated in the same change — that is the
 * mechanism keeping Ion Dark/Light/Classic pixel-identical across
 * platforms.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { IOS_THEME_TOKEN_KEYS } from '../../shared/theme-pack-types'
import { classicColors, darkColors, lightColors, contrastDarkColors, contrastLightColors, themes, type ColorPalette } from '../theme-tokens'

interface ParityToken {
  desktopToken: string
  hex: string
}
interface ParityTheme {
  preferredColorScheme?: 'light' | 'dark' | null
  tokens: Record<string, ParityToken>
}

const fixturePath = join(__dirname, '../../../../assets/theme-parity.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<
  string,
  ParityTheme | string
>

const PALETTES: Record<string, ColorPalette> = {
  'ion-dark': darkColors,
  'ion-light': lightColors,
  'ion-classic': classicColors,
  'ion-contrast-dark': contrastDarkColors,
  'ion-contrast-light': contrastLightColors,
}

/** Normalize a desktop palette value (#RGB/#RRGGBB hex or rgba()) to
 * uppercase #RRGGBBAA for comparison with the fixture. */
function toRgbaHex(cssValue: string): string {
  const hexMatch = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(cssValue)
  if (hexMatch) {
    let h = hexMatch[1]
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    if (h.length === 6) h = `${h}FF`
    return `#${h.toUpperCase()}`
  }
  const rgbaMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(cssValue)
  if (rgbaMatch) {
    const [r, g, b] = [rgbaMatch[1], rgbaMatch[2], rgbaMatch[3]].map((v) => parseInt(v, 10))
    const a = rgbaMatch[4] === undefined ? 255 : Math.round(parseFloat(rgbaMatch[4]) * 255)
    const to2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0')
    return `#${to2(r)}${to2(g)}${to2(b)}${to2(a)}`
  }
  throw new Error(`unparseable palette value: ${cssValue}`)
}

const themeEntries = Object.entries(fixture).filter(
  (e): e is [string, ParityTheme] => typeof e[1] !== 'string',
)

function expectForcedColorScheme(
  def: { forcedColorScheme?: 'light' | 'dark' },
  theme: ParityTheme,
): void {
  if (theme.preferredColorScheme === null || theme.preferredColorScheme === undefined) {
    expect(def.forcedColorScheme).toBeUndefined()
  } else {
    expect(def.forcedColorScheme).toBe(theme.preferredColorScheme)
  }
}

describe('theme parity fixture (desktop side)', () => {
  it('covers exactly the shared built-in themes', () => {
    expect(themeEntries.map(([id]) => id).sort()).toEqual([
      'ion-classic', 'ion-contrast-dark', 'ion-contrast-light',
      'ion-dark', 'ion-light',
    ])
  })

  it('covers every iOS token for every shared theme', () => {
    for (const [id, theme] of themeEntries) {
      expect(Object.keys(theme.tokens).sort(), `theme ${id}`).toEqual(
        [...IOS_THEME_TOKEN_KEYS].sort(),
      )
    }
  })

  it('fixture scheme matches the registry forcedColorScheme', () => {
    for (const [id, theme] of themeEntries) {
      const def = themes.find((t) => t.id === id)
      expect(def, `theme ${id} in registry`).toBeDefined()
      if (theme.preferredColorScheme === null) expect(def!.forcedColorScheme).toBeUndefined()
      else expect(def!.forcedColorScheme).toBe(theme.preferredColorScheme)
    }
  })

  it('accepts a follow-system fixture scheme without forced color scheme', () => {
    expectForcedColorScheme({ forcedColorScheme: undefined }, {
      preferredColorScheme: null,
      tokens: {},
    })
  })

  it('every fixture hex equals the mapped desktop palette value', () => {
    for (const [id, theme] of themeEntries) {
      const palette = PALETTES[id]
      expect(palette, `palette for ${id}`).toBeDefined()
      for (const [iosToken, entry] of Object.entries(theme.tokens)) {
        const desktopValue = palette[entry.desktopToken as keyof ColorPalette]
        expect(
          typeof desktopValue,
          `${id}.${iosToken} maps to desktop token ${entry.desktopToken}`,
        ).toBe('string')
        expect(
          toRgbaHex(desktopValue),
          `${id}: iOS ${iosToken} vs desktop ${entry.desktopToken}`,
        ).toBe(entry.hex.toUpperCase())
      }
    }
  })
})
