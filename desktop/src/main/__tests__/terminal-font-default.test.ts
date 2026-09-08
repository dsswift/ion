import { describe, it, expect } from 'vitest'
import { SETTINGS_DEFAULTS } from '../settings-store'
import { DEFAULT_MONO_FONT } from '../../renderer/typography'

// The terminal wrapped at roughly a third of its pane width on Windows. The
// default font stack was macOS-only ("Menlo, Monaco, monospace"); none of
// those exist on Windows, so the browser substituted a PROPORTIONAL fallback.
// xterm derives its column count from measured character width, so a
// proportional font yields far too few columns.
describe('terminal font default', () => {
  it('matches the renderer stack, so the two cannot drift', () => {
    expect(SETTINGS_DEFAULTS.terminalFontFamily).toBe(DEFAULT_MONO_FONT)
  })

  it.each([
    ['Consolas', 'ships with Windows itself'],
    ['Cascadia Code', 'ships with Windows Terminal'],
    ['Menlo', 'macOS'],
    ['ui-monospace', 'the generic system mono keyword'],
    ['monospace', 'the final generic fallback'],
  ])('names %s (%s)', (font) => {
    expect(SETTINGS_DEFAULTS.terminalFontFamily).toContain(font)
  })

  // A stack whose every entry is macOS-only is the defect. At least one
  // Windows-resident family must appear before the generic fallback.
  it('resolves to a real monospace family on Windows', () => {
    const stack = SETTINGS_DEFAULTS.terminalFontFamily
    const windowsFonts = ['Cascadia Code', 'Consolas']
    expect(windowsFonts.some((f) => stack.includes(f))).toBe(true)
  })
})
