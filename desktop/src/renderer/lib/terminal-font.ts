import '../assets/fonts/terminal-symbols.css'

/** The bundled Nerd Font symbols face declared in terminal-symbols.css. */
export const TERMINAL_SYMBOLS_FONT_FAMILY = 'Ion Nerd Font Symbols'

/**
 * The font-family a terminal view is given: the operator's choice, then the
 * bundled Nerd Font symbols.
 *
 * The symbols face goes last, after any generic family. Font matching runs per
 * character through the whole list, so every glyph the chosen fonts have is
 * drawn from them, and only a prompt icon none of them carries reaches the
 * bundled face instead of rendering as a box.
 */
export function terminalFontStack(family: string): string {
  const quoted = `"${TERMINAL_SYMBOLS_FONT_FAMILY}"`
  const chosen = family.trim()
  if (!chosen) return quoted
  if (chosen.includes(TERMINAL_SYMBOLS_FONT_FAMILY)) return chosen
  return `${chosen}, ${quoted}`
}
