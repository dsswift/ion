import { describe, expect, it, vi } from 'vitest'

vi.mock('../../viewport-zoom', () => ({ zoomViewport: () => ({ width: 1400, height: 1000 }) }))

import {
  maximizedSettingsDialogGeometry, resizeSettingsDialog, resolveSettingsDialogGeometry, resolveSettingsDialogLayout, DIALOG_MIN_HEIGHT, DIALOG_MIN_WIDTH,
} from '../settings/settings-dialog-geometry'

describe('SettingsDialog geometry', () => {
  it('opens centred at its default size', () => {
    expect(resolveSettingsDialogGeometry({ width: 1400, height: 1000 })).toEqual({ x: 150, y: 90, width: 1100, height: 820 })
  })

  it('fits and centres in a small window', () => {
    expect(resolveSettingsDialogGeometry({ width: 700, height: 500 })).toEqual({ x: 8, y: 8, width: 684, height: 484 })
  })

  it('folds the sidebar only for narrow dialogs', () => {
    expect(resolveSettingsDialogLayout(719)).toBe('compact')
    expect(resolveSettingsDialogLayout(720)).toBe('wide')
  })

  it('fills the window, inset, when maximized', () => {
    expect(maximizedSettingsDialogGeometry({ width: 1400, height: 1000 })).toEqual({ x: 12, y: 12, width: 1376, height: 976 })
  })

  it('resizes from the corner within the minimum and the window', () => {
    const start = { x: 100, y: 100, width: 900, height: 700 }
    expect(resizeSettingsDialog(start, { x: 50, y: -20 }, { width: 1400, height: 1000 })).toEqual({ x: 100, y: 100, width: 950, height: 680 })
    expect(resizeSettingsDialog(start, { x: -5000, y: -5000 }, { width: 1400, height: 1000 })).toEqual({ x: 100, y: 100, width: DIALOG_MIN_WIDTH, height: DIALOG_MIN_HEIGHT })
    expect(resizeSettingsDialog(start, { x: 5000, y: 5000 }, { width: 1400, height: 1000 })).toEqual({ x: 100, y: 100, width: 1300, height: 900 })
  })
})
