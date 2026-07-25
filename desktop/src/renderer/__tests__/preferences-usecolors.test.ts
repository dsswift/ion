import { describe, it, expect } from 'vitest'
import { hudColors, darkColors, lightColors, classicColors, resolveColors } from '../theme-tokens'

describe('resolveColors — theme id resolves its own palette', () => {
  it('returns hudColors for jarvis-hud', () => {
    const palette = resolveColors('jarvis-hud')
    expect(palette.accent).toBe('#33C3F7')
    expect(palette).toBe(hudColors)
  })

  it('returns darkColors for ion-dark', () => {
    expect(resolveColors('ion-dark')).toBe(darkColors)
  })

  it('returns lightColors for ion-light', () => {
    expect(resolveColors('ion-light')).toBe(lightColors)
  })

  it('returns classicColors for ion-classic', () => {
    const palette = resolveColors('ion-classic')
    expect(palette.accent).toBe('#d97757')
    expect(palette).toBe(classicColors)
  })

  it('falls back to the default Ion Dark for unknown ids', () => {
    expect(resolveColors('not-a-theme')).toBe(darkColors)
  })
})
