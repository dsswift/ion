import { describe, expect, it } from 'vitest'
import { resolveOverlayPanelPlacement, resolveResponsiveColumns, resolveStudioResponsiveLayout, resolveViewportContentWidth } from '../responsive-layout'

describe('responsive layout', () => {
  it('keeps preferred Studio panes at wide widths', () => {
    expect(resolveStudioResponsiveLayout({ width: 1500, leftRequested: true, surfaceRequested: true, preferredLeftWidth: 440, preferredSurfaceWidth: 520 })).toEqual({ mode: 'wide', leftWidth: 440, surfaceWidth: 520 })
  })

  it('clamps both Studio side panes while preserving the center floor', () => {
    const result = resolveStudioResponsiveLayout({ width: 1120, leftRequested: true, surfaceRequested: true, preferredLeftWidth: 440, preferredSurfaceWidth: 520 })
    expect(result.mode).toBe('medium')
    expect(result.leftWidth + result.surfaceWidth).toBe(760)
  })

  it('uses one full-width pane in narrow Studio mode', () => {
    expect(resolveStudioResponsiveLayout({ width: 700, leftRequested: true, surfaceRequested: true, preferredLeftWidth: 440, preferredSurfaceWidth: 520 })).toEqual({ mode: 'narrow', leftWidth: 700, surfaceWidth: 700 })
  })

  it('moves overlay panels inside when outside clearance is too small', () => {
    expect(resolveOverlayPanelPlacement(1440, 700, 300, 8).external).toBe(true)
    expect(resolveOverlayPanelPlacement(900, 700, 440, 8)).toEqual({ external: false, width: 440 })
  })

  it('bounds content and resolves responsive columns', () => {
    expect(resolveViewportContentWidth(910, 600)).toBe(568)
    expect(resolveResponsiveColumns(700, 640)).toBe(2)
    expect(resolveResponsiveColumns(500, 640)).toBe(1)
  })
})
