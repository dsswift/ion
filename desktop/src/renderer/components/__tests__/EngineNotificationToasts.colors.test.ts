// @vitest-environment jsdom
/**
 * Pins that each toast level draws its text and dismiss control with the
 * foreground tokens named for that level's own fill. Sentinel values make
 * the driving token identifiable.
 */
import { describe, it, expect } from 'vitest'
import { toastColors } from '../EngineNotificationToasts'
import { darkColors, type ColorPalette } from '../../theme-tokens'

const palette: ColorPalette = {
  ...darkColors,
  surfaceSecondary: 'surface-fill',
  stopBg: 'danger-fill',
  statusWarning: 'warning-fill',
  textOnAccent: 'on-accent',
  textOnAccentMuted: 'on-accent-muted',
  textOnSurface: 'on-surface',
  textOnSurfaceMuted: 'on-surface-muted',
  textOnDanger: 'on-danger',
  textOnDangerMuted: 'on-danger-muted',
  textOnWarning: 'on-warning',
  textOnWarningMuted: 'on-warning-muted',
}

describe('toastColors', () => {
  it('a neutral toast resolves the neutral-surface foregrounds, not the accent ones', () => {
    for (const level of ['info', 'anything-else']) {
      expect(toastColors(level, palette)).toEqual({
        background: 'surface-fill',
        fg: 'on-surface',
        fgMuted: 'on-surface-muted',
      })
    }
  })

  it('an error toast resolves the danger foregrounds', () => {
    expect(toastColors('error', palette)).toEqual({
      background: 'danger-fill',
      fg: 'on-danger',
      fgMuted: 'on-danger-muted',
    })
  })

  it('a warning toast resolves the warning foregrounds', () => {
    expect(toastColors('warning', palette)).toEqual({
      background: 'warning-fill',
      fg: 'on-warning',
      fgMuted: 'on-warning-muted',
    })
  })
})
