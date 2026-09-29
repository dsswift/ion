import { describe, it, expect, vi } from 'vitest'

vi.mock('../../assets/fonts/terminal-symbols.css', () => ({}))

import { terminalFontStack, TERMINAL_SYMBOLS_FONT_FAMILY } from '../terminal-font'

describe('terminalFontStack', () => {
  it('keeps the chosen font first and appends the bundled symbols last', () => {
    expect(terminalFontStack('MesloLGL Nerd Font Mono')).toBe(`MesloLGL Nerd Font Mono, "${TERMINAL_SYMBOLS_FONT_FAMILY}"`)
    expect(terminalFontStack('ui-monospace, Menlo, monospace')).toBe(`ui-monospace, Menlo, monospace, "${TERMINAL_SYMBOLS_FONT_FAMILY}"`)
  })

  it('falls back to the symbols face alone for an empty choice', () => {
    expect(terminalFontStack('  ')).toBe(`"${TERMINAL_SYMBOLS_FONT_FAMILY}"`)
  })

  it('does not append the symbols face twice', () => {
    const once = terminalFontStack('Menlo')
    expect(terminalFontStack(once)).toBe(once)
  })
})
