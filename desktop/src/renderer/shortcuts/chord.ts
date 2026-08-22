/**
 * Chord parsing, matching, and display utilities for the keyboard-shortcut
 * system. A "chord" is a single key combination expressed as a normalized
 * string like `Mod+=`, `Ctrl+Shift+T`, `Ctrl+\``.
 *
 * Normalization rules:
 *   - `Mod` means Cmd on macOS, Ctrl on everything else.
 *   - Modifier tokens: `Mod`, `Ctrl`, `Shift`, `Alt` (case-insensitive on parse).
 *   - The key token is the last `+`-delimited segment. It is stored as-is
 *     (so `=`, `+`, `` ` ``, `1`, `T`, etc. all work).
 *   - At most one of each modifier is recognized; duplicates are ignored.
 */

/** Parsed representation of a key chord. */
export interface Chord {
  /** True when the platform modifier (Cmd/Ctrl) must be held. */
  mod: boolean
  /** True when Ctrl must be held (on top of, or instead of, Mod). */
  ctrl: boolean
  /** True when Shift must be held. */
  shift: boolean
  /** True when Alt/Option must be held. */
  alt: boolean
  /** The bare key string as it appears on KeyboardEvent.key. */
  key: string
  /**
   * When true, the shift-negative guard in matchesChord is suppressed.
   * Set automatically by parseChord for keys that browsers always report
   * with shiftKey=true regardless of whether shift is explicitly in the
   * binding string (e.g. '+' on a US keyboard is Shift+= but e.key is '+').
   */
  shiftOptional?: boolean
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)

/**
 * The unmodified key a physical code produces, or null when the code is not
 * one we can resolve without a keyboard-layout map.
 *
 * This exists because macOS applies its Option-key layer BEFORE the browser
 * reports `KeyboardEvent.key`: with ⌥ held, Digit1 arrives as `¡`, KeyB as
 * `∫`, and so on. A chord written `Mod+Alt+1` would therefore never match on
 * the platform it was written for. `code` is the physical key and is immune
 * to that layer, so it is the reliable signal for any Alt-bearing chord.
 *
 * Only the ASCII rows are mapped. A layout-dependent key (a non-US symbol) has
 * no fixed code→character relationship, so it falls back to `key` matching.
 */
export function baseKeyFromCode(code: string): string | null {
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  switch (code) {
    case 'Backquote': return '`'
    case 'Minus': return '-'
    case 'Equal': return '='
    case 'BracketLeft': return '['
    case 'BracketRight': return ']'
    case 'Backslash': return '\\'
    case 'Semicolon': return ';'
    case 'Quote': return "'"
    case 'Comma': return ','
    case 'Period': return '.'
    case 'Slash': return '/'
    default: return null
  }
}

/**
 * Parse a normalized chord string into a structured Chord.
 * Returns null when the string is malformed (empty, no key, unknown token).
 *
 * Examples:
 *   `parseChord('Mod+=')` → { mod: true, ctrl: false, shift: false, alt: false, key: '=' }
 *   `parseChord('Ctrl+Shift+T')` → { mod: false, ctrl: true, shift: true, alt: false, key: 'T' }
 *   `parseChord('Ctrl+\`')` → { mod: false, ctrl: true, shift: false, alt: false, key: '`' }
 */
export function parseChord(s: string): Chord | null {
  if (!s || typeof s !== 'string') return null
  const parts = s.split('+')
  if (parts.length === 0) return null

  // The key is the last segment. A literal '+' key is written by doubling the
  // trailing separator: `Mod++` splits to ["Mod","",""] so both the last and
  // second-to-last segments are empty strings — that's our signal that the key
  // is '+'. Any other trailing empty string is a malformed chord.
  let key: string
  let modifiers: string[]
  const lastEmpty = parts[parts.length - 1] === ''
  const secondLastEmpty = parts.length >= 2 && parts[parts.length - 2] === ''
  if (lastEmpty && secondLastEmpty) {
    // e.g. "Mod++" → parts=["Mod","",""] → key="+", modifiers=["Mod"]
    key = '+'
    modifiers = parts.slice(0, parts.length - 2)
  } else {
    key = parts[parts.length - 1]
    modifiers = parts.slice(0, parts.length - 1)
  }

  let mod = false
  let ctrl = false
  let shift = false
  let alt = false

  for (const tok of modifiers) {
    const upper = tok.toLowerCase()
    if (upper === 'mod') { mod = true }
    else if (upper === 'ctrl') { ctrl = true }
    else if (upper === 'shift') { shift = true }
    else if (upper === 'alt') { alt = true }
    else {
      // Unknown modifier token — reject the chord.
      return null
    }
  }

  if (!key) return null
  // '+' is always reported with shiftKey=true on standard keyboards regardless
  // of whether Shift is explicit in the binding string. Flag it so matchesChord
  // doesn't reject the event when shiftKey is present.
  const shiftOptional = key === '+'
  return { mod, ctrl, shift, alt, key, ...(shiftOptional ? { shiftOptional: true } : {}) }
}

/**
 * Returns true when the keyboard event matches the given chord.
 * `Mod` maps to `e.metaKey` on macOS, `e.ctrlKey` on other platforms.
 */
export function matchesChord(e: KeyboardEvent, chord: Chord | null): boolean {
  if (!chord) return false
  const modMatch = chord.mod ? (IS_MAC ? e.metaKey : e.ctrlKey) : true
  const ctrlMatch = chord.ctrl ? e.ctrlKey : true
  const shiftMatch = chord.shift ? e.shiftKey : true
  const altMatch = chord.alt ? e.altKey : true

  // Negative checks: if the chord does NOT require a modifier, that modifier
  // must NOT be pressed (avoids `Ctrl+T` firing on `Mod+Ctrl+T`).
  const modNotPressed = chord.mod ? true : IS_MAC ? !e.metaKey : !e.ctrlKey
  // If chord.ctrl is false and mod is the only modifier, we still allow the
  // ctrl key if it's the platform Mod key. But if ctrl is explicitly false
  // and mod is also false, ctrlKey must not be pressed.
  const ctrlNotPressed = chord.ctrl ? true : (chord.mod && !IS_MAC) ? true : !e.ctrlKey
  const shiftNotPressed = chord.shift ? true : chord.shiftOptional ? true : !e.shiftKey
  const altNotPressed = chord.alt ? true : !e.altKey

  return (
    modMatch &&
    ctrlMatch &&
    shiftMatch &&
    altMatch &&
    modNotPressed &&
    ctrlNotPressed &&
    shiftNotPressed &&
    altNotPressed &&
    keyMatches(e, chord)
  )
}

/**
 * Compare the event's key against the chord's key.
 *
 * The physical `code` is consulted first for any Alt-bearing chord, because
 * macOS has already replaced `key` with the Option-layer character by the time
 * the event arrives. When `code` cannot be resolved to a base character (a
 * layout-dependent symbol), or the chord has no Alt, `key` is authoritative.
 */
function keyMatches(e: KeyboardEvent, chord: Chord): boolean {
  const wanted = chord.key.toLowerCase()
  if (chord.alt && e.code) {
    const base = baseKeyFromCode(e.code)
    if (base !== null) return base.toLowerCase() === wanted
  }
  return e.key.toLowerCase() === wanted
}

/**
 * Render a chord's key for display.
 *
 * A single letter is uppercased because that is how every platform prints a
 * chord: macOS menus show ⌘B, never ⌘b, and Windows shows Ctrl+B. A named key
 * (`Tab`, `Escape`) and a symbol are left exactly as written.
 */
function displayKey(key: string): string {
  return key.length === 1 && /[a-z]/i.test(key) ? key.toUpperCase() : key
}

/**
 * Format a chord string for display using platform-appropriate glyphs.
 * On macOS: ⌘, ⇧, ⌃, ⌥. On other platforms: Ctrl+, Shift+, etc.
 *
 * Examples (macOS):
 *   `formatChord('Mod+=')` → '⌘='
 *   `formatChord('Ctrl+\`')` → '⌃`'
 *   `formatChord('Mod+Shift+T')` → '⌘⇧T'
 */
export function formatChord(s: string): string {
  const chord = parseChord(s)
  if (!chord) return s

  if (IS_MAC) {
    let out = ''
    if (chord.mod) out += '⌘'
    if (chord.ctrl) out += '⌃'
    if (chord.shift) out += '⇧'
    if (chord.alt) out += '⌥'
    out += displayKey(chord.key)
    return out
  }

  const parts: string[] = []
  if (chord.mod) parts.push('Ctrl')
  if (chord.ctrl && !chord.mod) parts.push('Ctrl')
  if (chord.shift) parts.push('Shift')
  if (chord.alt) parts.push('Alt')
  parts.push(displayKey(chord.key))
  return parts.join('+')
}
