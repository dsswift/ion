// @vitest-environment jsdom
/**
 * The macOS Option layer replaces KeyboardEvent.key before the renderer sees
 * it: ⌥1 arrives as `¡`, ⌥b as `∫`. A chord written `Mod+Alt+1` would never
 * match on the platform it was authored for, so any Alt-bearing chord matches
 * on the physical `code` instead.
 *
 * These tests fail on the pre-fix matcher, which compared `key` alone.
 */
import { describe, it, expect, afterAll, vi } from 'vitest'

const _saved = vi.hoisted(() => {
  const saved = Object.getOwnPropertyDescriptor(globalThis.navigator, 'platform')
  Object.defineProperty(globalThis.navigator, 'platform', { value: 'MacIntel', configurable: true })
  return saved
})

import { baseKeyFromCode, matchesChord, parseChord } from '../chord'

afterAll(() => {
  if (_saved) Object.defineProperty(navigator, 'platform', _saved)
  else Object.defineProperty(navigator, 'platform', { value: '', configurable: true })
})

/** An Option-layer event: `key` carries the composed glyph, `code` the key. */
function optionEvent(key: string, code: string, extra: { meta?: boolean; shift?: boolean } = {}): KeyboardEvent {
  return {
    key,
    code,
    metaKey: extra.meta ?? true,
    ctrlKey: false,
    shiftKey: extra.shift ?? false,
    altKey: true,
  } as KeyboardEvent
}

describe('baseKeyFromCode', () => {
  it('resolves digits, letters, and the ASCII punctuation row', () => {
    expect(baseKeyFromCode('Digit4')).toBe('4')
    expect(baseKeyFromCode('KeyB')).toBe('b')
    expect(baseKeyFromCode('Backquote')).toBe('`')
    expect(baseKeyFromCode('Equal')).toBe('=')
  })

  it('returns null for a key with no fixed character, so `key` stays authoritative', () => {
    expect(baseKeyFromCode('F5')).toBeNull()
    expect(baseKeyFromCode('IntlBackslash')).toBeNull()
  })
})

describe('matchesChord with the macOS Option layer', () => {
  it('matches Mod+Alt+1 when the event reports the composed glyph', () => {
    expect(matchesChord(optionEvent('¡', 'Digit1'), parseChord('Mod+Alt+1'))).toBe(true)
  })

  it('matches every digit in the canvas-tab family', () => {
    const composed = ['¡', '™', '£', '¢', '∞', '§', '¶']
    composed.forEach((glyph, index) => {
      const digit = index + 1
      expect(matchesChord(optionEvent(glyph, `Digit${digit}`), parseChord(`Mod+Alt+${digit}`))).toBe(true)
    })
  })

  it('matches Mod+Alt+b, whose Option layer is the integral sign', () => {
    expect(matchesChord(optionEvent('∫', 'KeyB'), parseChord('Mod+Alt+b'))).toBe(true)
  })

  it('still rejects the wrong physical key', () => {
    expect(matchesChord(optionEvent('¡', 'Digit1'), parseChord('Mod+Alt+2'))).toBe(false)
  })

  it('leaves non-Alt chords matching on key, unaffected by the code path', () => {
    const plain = { key: '1', code: 'Digit1', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false } as KeyboardEvent
    expect(matchesChord(plain, parseChord('Mod+1'))).toBe(true)
    expect(matchesChord(plain, parseChord('Mod+Alt+1'))).toBe(false)
  })
})
