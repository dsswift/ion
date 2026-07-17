// @vitest-environment jsdom
/**
 * chord.ts — parseChord / matchesChord / formatChord unit tests.
 *
 * Round-trip, matching synthetic KeyboardEvents, malformed input rejection,
 * and the Mod=Cmd/Ctrl platform mapping.
 */

import { describe, it, expect, afterAll, vi } from 'vitest'

// Set navigator.platform BEFORE chord.ts is imported so the module-scope
// IS_MAC const evaluates to true. vi.hoisted runs after the jsdom env is
// created but before static imports are resolved.
const _saved = vi.hoisted(() => {
  const saved = Object.getOwnPropertyDescriptor(globalThis.navigator, 'platform')
  Object.defineProperty(globalThis.navigator, 'platform', { value: 'MacIntel', configurable: true })
  return saved
})

import { parseChord, matchesChord, formatChord } from '../../shortcuts/chord'

afterAll(() => {
  if (_saved) Object.defineProperty(navigator, 'platform', _saved)
  else Object.defineProperty(navigator, 'platform', { value: '', configurable: true })
})

// Helper: build a minimal KeyboardEvent-like object.
function makeEvent(key: string, { meta = false, ctrl = false, shift = false, alt = false } = {}): KeyboardEvent {
  return { key, metaKey: meta, ctrlKey: ctrl, shiftKey: shift, altKey: alt } as KeyboardEvent
}

// ── parseChord ─────────────────────────────────────────────────────────────

describe('parseChord', () => {
  it('parses Mod+= into { mod: true, key: "=" }', () => {
    const c = parseChord('Mod+=')
    expect(c).toMatchObject({ mod: true, ctrl: false, shift: false, alt: false, key: '=' })
  })

  it('parses Ctrl+Shift+T', () => {
    const c = parseChord('Ctrl+Shift+T')
    expect(c).toMatchObject({ mod: false, ctrl: true, shift: true, alt: false, key: 'T' })
  })

  it('parses Ctrl+` (backtick)', () => {
    const c = parseChord('Ctrl+`')
    expect(c).toMatchObject({ mod: false, ctrl: true, shift: false, alt: false, key: '`' })
  })

  it('parses Shift+Tab', () => {
    const c = parseChord('Shift+Tab')
    expect(c).toMatchObject({ mod: false, ctrl: false, shift: true, alt: false, key: 'Tab' })
  })

  it('parses Mod+Shift+g (multi-modifier)', () => {
    const c = parseChord('Mod+Shift+g')
    expect(c).toMatchObject({ mod: true, shift: true, key: 'g' })
  })

  it('returns null for empty string', () => {
    expect(parseChord('')).toBeNull()
  })

  it('returns null for an unknown modifier token', () => {
    // 'Super' is not a recognized modifier
    expect(parseChord('Super+X')).toBeNull()
  })

  it('returns null for null/undefined input', () => {
    expect(parseChord(null as any)).toBeNull()
    expect(parseChord(undefined as any)).toBeNull()
  })

  it('returns null for a non-string input', () => {
    expect(parseChord(42 as any)).toBeNull()
  })
})

// ── matchesChord ───────────────────────────────────────────────────────────

describe('matchesChord (macOS — Mod = metaKey)', () => {
  it('matches Mod+= on Cmd+= keypress', () => {
    const chord = parseChord('Mod+=')
    const e = makeEvent('=', { meta: true })
    expect(matchesChord(e, chord)).toBe(true)
  })

  it('does NOT match Mod+= on plain Ctrl+= (wrong modifier)', () => {
    const chord = parseChord('Mod+=')
    const e = makeEvent('=', { ctrl: true })
    expect(matchesChord(e, chord)).toBe(false)
  })

  it('matches Ctrl+` on Ctrl+` keypress', () => {
    const chord = parseChord('Ctrl+`')
    const e = makeEvent('`', { ctrl: true })
    expect(matchesChord(e, chord)).toBe(true)
  })

  it('matches Shift+Tab on Shift+Tab keypress', () => {
    const chord = parseChord('Shift+Tab')
    const e = makeEvent('Tab', { shift: true })
    expect(matchesChord(e, chord)).toBe(true)
  })

  it('does NOT match Shift+Tab on plain Tab', () => {
    const chord = parseChord('Shift+Tab')
    const e = makeEvent('Tab')
    expect(matchesChord(e, chord)).toBe(false)
  })

  it('does NOT match Mod+= when Shift is also pressed (unintended modifier)', () => {
    const chord = parseChord('Mod+=')
    // This would be Cmd+Shift+= — the chord doesn't require shift
    const e = makeEvent('=', { meta: true, shift: true })
    expect(matchesChord(e, chord)).toBe(false)
  })

  it('returns false for a null chord', () => {
    expect(matchesChord(makeEvent('='), null)).toBe(false)
  })

  it('returns false for an invalid chord (wrong key)', () => {
    const chord = parseChord('Mod+=')
    const e = makeEvent('-', { meta: true })
    expect(matchesChord(e, chord)).toBe(false)
  })
})

// ── shiftOptional (Mod++) ──────────────────────────────────────────────────

describe('parseChord — shiftOptional for + key', () => {
  it('parseChord("Mod++") sets shiftOptional: true', () => {
    const c = parseChord('Mod++')
    // Without the shiftOptional flag being set by parseChord, matchesChord would
    // reject a Cmd++ event where shiftKey=true (browser always reports shiftKey
    // on '+' regardless of whether Shift is in the binding string).
    expect(c).not.toBeNull()
    expect(c!.shiftOptional).toBe(true)
  })

  it('parseChord("Mod++") still has key "+" and mod: true, shift: false', () => {
    const c = parseChord('Mod++')
    expect(c).toMatchObject({ mod: true, ctrl: false, shift: false, alt: false, key: '+' })
  })

  it('parseChord("Mod+=") does NOT set shiftOptional (= is not shiftOptional)', () => {
    const c = parseChord('Mod+=')
    expect(c).not.toBeNull()
    expect(c!.shiftOptional).toBeUndefined()
  })
})

describe('matchesChord — shiftOptional allows shiftKey=true for + key', () => {
  it('matchesChord accepts a Cmd++ event (shiftKey=true) for Mod++ chord', () => {
    // Browsers fire shiftKey=true for '+' on a US keyboard because '+' is
    // Shift+=. Without shiftOptional the negative-shift guard would reject it.
    const chord = parseChord('Mod++')
    const e = makeEvent('+', { meta: true, shift: true })
    expect(matchesChord(e, chord)).toBe(true)
  })

  it('matchesChord rejects a Cmd++ event for a non-shiftOptional chord (Mod+=)', () => {
    // Revert check: if shiftOptional were applied to all chords this would
    // mistakenly pass. It must remain false for chords that don't set the flag.
    const chord = parseChord('Mod+=')
    const e = makeEvent('=', { meta: true, shift: true })
    expect(matchesChord(e, chord)).toBe(false)
  })

  it('matchesChord rejects Cmd+= (no shift) for Mod++ chord (wrong key)', () => {
    const chord = parseChord('Mod++')
    const e = makeEvent('=', { meta: true, shift: false })
    expect(matchesChord(e, chord)).toBe(false)
  })
})

// ── formatChord (macOS) ────────────────────────────────────────────────────

describe('formatChord (macOS glyphs)', () => {
  it('formats Mod+= as ⌘=', () => {
    expect(formatChord('Mod+=')).toBe('⌘=')
  })

  it('formats Mod+Shift+g as ⌘⇧g', () => {
    expect(formatChord('Mod+Shift+g')).toBe('⌘⇧g')
  })

  it('formats Ctrl+` as ⌃`', () => {
    expect(formatChord('Ctrl+`')).toBe('⌃`')
  })

  it('formats Shift+Tab as ⇧Tab', () => {
    expect(formatChord('Shift+Tab')).toBe('⇧Tab')
  })

  it('returns the original string for a malformed chord', () => {
    // parseChord('bad') returns null → formatChord returns 'bad'
    expect(formatChord('bad-chord')).toBe('bad-chord')
  })
})
