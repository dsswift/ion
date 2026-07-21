import { describe, it, expect } from 'vitest'
import { hudColors, darkColors, lightColors, resolveColors } from '../theme-tokens'

describe('useColors / resolveColors — forced-scheme theme palette', () => {
  it('resolveColors returns hudColors when selectedTheme is jarvis-hud', () => {
    const palette = resolveColors('jarvis-hud', true)
    expect(palette.accent).toBe('#33C3F7')
    expect(palette).toBe(hudColors)
  })

  it('resolveColors returns darkColors for ion-dark with isDark=true', () => {
    const palette = resolveColors('ion-dark', true)
    expect(palette).toBe(darkColors)
  })

  it('resolveColors returns lightColors for ion-light with isDark=false', () => {
    const palette = resolveColors('ion-light', false)
    expect(palette).toBe(lightColors)
  })

  it('resolveColors ignores isDark for forced-scheme theme', () => {
    // jarvis-hud has forcedColorScheme: 'dark' — isDark=false should still return hudColors
    expect(resolveColors('jarvis-hud', false)).toBe(hudColors)
  })
})
