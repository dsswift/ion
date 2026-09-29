import { describe, expect, it } from 'vitest'
import { resolveResponsiveColumns, resolveStudioResponsiveLayout } from '../responsive-layout'

describe('responsive layout', () => {
  it('keeps preferred Studio panes at wide widths', () => {
    expect(resolveStudioResponsiveLayout({ width: 1500, leftRequested: true, surfaceRequested: true, preferredLeftWidth: 440, preferredSurfaceWidth: 520 })).toEqual({ mode: 'wide', leftWidth: 440, surfaceWidth: 520 })
  })

  it('clamps both Studio side panes while preserving the center floor', () => {
    const result = resolveStudioResponsiveLayout({ width: 1120, leftRequested: true, surfaceRequested: true, preferredLeftWidth: 440, preferredSurfaceWidth: 520 })
    expect(result.mode).toBe('medium')
    expect(result.leftWidth + result.surfaceWidth).toBe(760)
  })

  it('keeps all three panes on screen below the minimum total, scaling them together', () => {
    // Regression pin: this used to answer `narrow` with both side panes at
    // the full viewport width, and StudioShell then rendered ONE of them --
    // opening a sidebar on a small window hid the conversation entirely,
    // which the desktop never does on resize.
    const result = resolveStudioResponsiveLayout({ width: 700, leftRequested: true, surfaceRequested: true, preferredLeftWidth: 440, preferredSurfaceWidth: 520 })
    expect(result.mode).toBe('compressed')
    expect(result.leftWidth).toBeGreaterThan(0)
    expect(result.surfaceWidth).toBeGreaterThan(0)
    // Both sides fit inside the viewport with room left for the conversation.
    expect(result.leftWidth + result.surfaceWidth).toBeLessThan(700)
  })

  it('gives an unrequested pane zero width rather than a scaled one', () => {
    const result = resolveStudioResponsiveLayout({ width: 500, leftRequested: false, surfaceRequested: true, preferredLeftWidth: 440, preferredSurfaceWidth: 520 })
    expect(result.leftWidth).toBe(0)
    expect(result.surfaceWidth).toBeGreaterThan(0)
  })

  it('resolves responsive columns', () => {
    expect(resolveResponsiveColumns(700, 640)).toBe(2)
    expect(resolveResponsiveColumns(500, 640)).toBe(1)
  })
})
