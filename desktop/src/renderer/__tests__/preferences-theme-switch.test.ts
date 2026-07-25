// @vitest-environment jsdom
/**
 * Theme selection is single-axis: the theme picker is the only control, and
 * every built-in theme declares its own color scheme (`forcedColorScheme`).
 * Regression heritage: an earlier design had a separate dark-mode toggle
 * whose state overrode the picker for the standard themes — selecting "Ion
 * Light" with the toggle on dark still rendered darkColors. The toggle is
 * gone; this suite pins the picker-only contract for all four built-ins.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { usePreferencesStore } from '../preferences'
import { resolveColors, darkColors, lightColors, classicColors, hudColors, themes } from '../theme-tokens'

function activePalette() {
  return resolveColors(usePreferencesStore.getState().selectedTheme)
}

beforeEach(() => {
  usePreferencesStore.setState({ selectedTheme: 'ion-dark' })
})

describe('theme picker fully determines the look', () => {
  it('every built-in theme declares its color scheme', () => {
    for (const theme of themes) {
      expect(theme.forcedColorScheme, `${theme.id} must declare forcedColorScheme`).toBeDefined()
    }
  })

  it('selecting ion-light renders lightColors and the light root class', () => {
    usePreferencesStore.getState().setSelectedTheme('ion-light')
    expect(activePalette()).toBe(lightColors)
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('selecting ion-dark renders darkColors and the dark root class', () => {
    usePreferencesStore.getState().setSelectedTheme('ion-light')
    usePreferencesStore.getState().setSelectedTheme('ion-dark')
    expect(activePalette()).toBe(darkColors)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('selecting ion-classic renders the preserved classic palette, dark scheme', () => {
    usePreferencesStore.getState().setSelectedTheme('ion-classic')
    expect(activePalette()).toBe(classicColors)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('selecting jarvis-hud renders hudColors', () => {
    usePreferencesStore.getState().setSelectedTheme('jarvis-hud')
    expect(activePalette()).toBe(hudColors)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('an unknown persisted theme id falls back to the default Ion Dark', () => {
    usePreferencesStore.setState({ selectedTheme: 'no-such-theme' })
    expect(activePalette()).toBe(darkColors)
  })
})
