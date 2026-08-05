import { describe, it, expect } from 'vitest'
import { darkColors } from '../../theme/palette-dark'
import { lightColors } from '../../theme/palette-light'
import { buildIonShikiTheme, ionThemeName } from './ionShikiTheme'

describe('buildIonShikiTheme', () => {
  it('derives bg/fg from the palette (codeBg / textPrimary)', () => {
    const theme = buildIonShikiTheme(darkColors, 'dark')
    expect(theme.colors['editor.background']).toBe(darkColors.codeBg)
    expect(theme.colors['editor.foreground']).toBe(darkColors.textPrimary)
    // The scope-less global default carries the same pair.
    expect(theme.settings[0].scope).toBeUndefined()
    expect(theme.settings[0].settings.foreground).toBe(darkColors.textPrimary)
    expect(theme.settings[0].settings.background).toBe(darkColors.codeBg)
  })

  it('maps the keyword scope onto codeKeyword', () => {
    const theme = buildIonShikiTheme(darkColors, 'dark')
    const keywordEntry = theme.settings.find((s) => s.scope?.includes('keyword'))
    expect(keywordEntry).toBeDefined()
    expect(keywordEntry!.settings.foreground).toBe(darkColors.codeKeyword)
  })

  it('maps every code token onto at least one scope entry', () => {
    const theme = buildIonShikiTheme(darkColors, 'dark')
    const foregrounds = new Set(theme.settings.map((s) => s.settings.foreground))
    for (const token of [
      darkColors.codeKeyword, darkColors.codeString, darkColors.codeNumber,
      darkColors.codeComment, darkColors.codeFunction, darkColors.codeType,
      darkColors.codeVariable, darkColors.codeOperator,
    ]) {
      expect(foregrounds.has(token), `token ${token} mapped`).toBe(true)
    }
  })

  it('produces a stable name for the same palette and a different one across palettes', () => {
    expect(ionThemeName(darkColors)).toBe(ionThemeName(darkColors))
    expect(buildIonShikiTheme(darkColors, 'dark').name).toBe(ionThemeName(darkColors))
    expect(ionThemeName(darkColors)).not.toBe(ionThemeName(lightColors))
  })

  it('sets the registration type from the scheme', () => {
    expect(buildIonShikiTheme(darkColors, 'dark').type).toBe('dark')
    expect(buildIonShikiTheme(lightColors, 'light').type).toBe('light')
  })
})
