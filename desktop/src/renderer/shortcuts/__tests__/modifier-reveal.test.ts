/**
 * Modifier-reveal rules for on-chrome shortcut hints.
 *
 * These pin the subset rule: a family sharing a modifier prefix reveals
 * together on that prefix, and a narrower hold narrows the set.
 */
import { describe, expect, it } from 'vitest'
import { parseChord } from '../chord'
import { anyModifierHeld, chordRevealed, readHeldModifiers, NO_MODIFIERS } from '../modifier-reveal'

const held = (partial: Partial<typeof NO_MODIFIERS>) => ({ ...NO_MODIFIERS, ...partial })

describe('chordRevealed', () => {
  it('reveals a Mod chord and its Mod+Alt sibling on Mod alone', () => {
    const onlyMod = held({ mod: true })
    expect(chordRevealed(parseChord('Mod+b'), onlyMod)).toBe(true)
    expect(chordRevealed(parseChord('Mod+Alt+b'), onlyMod)).toBe(true)
    expect(chordRevealed(parseChord('Mod+Alt+1'), onlyMod)).toBe(true)
  })

  it('narrows to the Alt-bearing chords once Alt joins', () => {
    const modAlt = held({ mod: true, alt: true })
    expect(chordRevealed(parseChord('Mod+Alt+1'), modAlt)).toBe(true)
    expect(chordRevealed(parseChord('Mod+b'), modAlt)).toBe(false)
    expect(chordRevealed(parseChord('Mod+1'), modAlt)).toBe(false)
  })

  it('keeps the Ctrl family separate from the Mod family on macOS', () => {
    const onlyCtrl = held({ ctrl: true })
    expect(chordRevealed(parseChord('Ctrl+`'), onlyCtrl, true)).toBe(true)
    expect(chordRevealed(parseChord('Mod+1'), onlyCtrl, true)).toBe(false)
    expect(chordRevealed(parseChord('Ctrl+`'), held({ mod: true }), true)).toBe(false)
  })

  it('collapses Mod and Ctrl off macOS, where one Ctrl press means both', () => {
    // readHeldModifiers sets mod AND ctrl for a Windows/Linux Ctrl press.
    const platformCtrl = held({ mod: true, ctrl: true })
    expect(chordRevealed(parseChord('Mod+1'), platformCtrl, false)).toBe(true)
    expect(chordRevealed(parseChord('Ctrl+`'), platformCtrl, false)).toBe(true)
    expect(chordRevealed(parseChord('Shift+Tab'), platformCtrl, false)).toBe(false)
  })

  it('reveals nothing while no modifier is held', () => {
    expect(chordRevealed(parseChord('Mod+1'), NO_MODIFIERS)).toBe(false)
    expect(anyModifierHeld(NO_MODIFIERS)).toBe(false)
  })

  it('ignores a bare-key chord, which no modifier could reveal', () => {
    expect(chordRevealed(parseChord('Escape'), held({ mod: true }))).toBe(false)
  })

  it('treats a null chord (unbound command) as not revealed', () => {
    expect(chordRevealed(null, held({ mod: true }))).toBe(false)
  })
})

describe('readHeldModifiers', () => {
  it('maps Meta to mod on macOS and leaves ctrl independent', () => {
    const event = { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }
    expect(readHeldModifiers(event, true)).toEqual({ mod: true, ctrl: false, shift: false, alt: false })
  })

  it('maps Ctrl to both mod and ctrl off macOS, where the two families coincide', () => {
    const event = { metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }
    expect(readHeldModifiers(event, false)).toEqual({ mod: true, ctrl: true, shift: false, alt: false })
  })
})
