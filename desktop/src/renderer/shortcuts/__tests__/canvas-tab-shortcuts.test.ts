// @vitest-environment jsdom
/**
 * The canvas-tab chord family and its on-chrome hints.
 *
 * Two contracts are pinned here. First, every canvas tab owns a command and a
 * chord in one coherent family, and none of them lands on a chord macOS
 * reserves. Second, a hint reflects the LIVE binding: a rebind changes the
 * glyphs and the modifier that reveals them, with nothing hardcoded at the
 * call site.
 */
import { describe, expect, it, vi, afterAll } from 'vitest'

const _saved = vi.hoisted(() => {
  const saved = Object.getOwnPropertyDescriptor(globalThis.navigator, 'platform')
  Object.defineProperty(globalThis.navigator, 'platform', { value: 'MacIntel', configurable: true })
  return saved
})

import { SHORTCUT_CATALOG, resolveViewBindings } from '../shortcut-catalog'
import { parseChord, formatChord } from '../chord'
import { chordRevealed, NO_MODIFIERS } from '../modifier-reveal'
import { CANVAS_TAB_COMMANDS } from '../../studio/surface/canvas-tab-commands'
import { SINGLETON_ORDER, NOTIFICATION_SURFACE_ID } from '../../../shared/studio-surface-types'

afterAll(() => {
  if (_saved) Object.defineProperty(navigator, 'platform', _saved)
  else Object.defineProperty(navigator, 'platform', { value: '', configurable: true })
})

const held = (partial: Partial<typeof NO_MODIFIERS>) => ({ ...NO_MODIFIERS, ...partial })

describe('canvas-tab command coverage', () => {
  it('binds every canvas singleton plus the notification tab', () => {
    for (const id of SINGLETON_ORDER) expect(CANVAS_TAB_COMMANDS[id]).toBeTruthy()
    expect(CANVAS_TAB_COMMANDS[NOTIFICATION_SURFACE_ID]).toBeTruthy()
  })

  it('gives each canvas command an active studio binding', () => {
    const resolution = resolveViewBindings('studio', {})
    for (const command of Object.values(CANVAS_TAB_COMMANDS)) {
      expect(resolution.activeBindings.get(command), command).toBeTruthy()
    }
  })

  it('places the whole family on Mod+Alt+<digit>', () => {
    const resolution = resolveViewBindings('studio', {})
    const digits = Object.values(CANVAS_TAB_COMMANDS).map((command) => {
      const chord = parseChord(resolution.activeBindings.get(command)!.binding)!
      expect(chord).toMatchObject({ mod: true, alt: true, shift: false, ctrl: false })
      return chord.key
    })
    // Distinct digits, so no two canvas tabs fight for one chord.
    expect(new Set(digits).size).toBe(digits.length)
    expect(digits.every((key) => /^[0-9]$/.test(key))).toBe(true)
  })
})

describe('macOS-reserved chords', () => {
  it('claims no Mod+Shift+3 or Mod+Shift+4, which macOS takes for screenshots', () => {
    const reserved = SHORTCUT_CATALOG.filter((entry) => {
      const chord = parseChord(entry.defaultBinding)
      return chord?.mod === true && chord.shift === true && (chord.key === '3' || chord.key === '4')
    })
    expect(reserved.map((entry) => entry.id)).toEqual([])
  })
})

describe('reveal families', () => {
  const resolution = resolveViewBindings('studio', {})
  const bindingOf = (id: string) => resolution.activeBindings.get(id)!.binding

  it('reveals the region toggles on Mod and the canvas tabs alongside them', () => {
    const onlyMod = held({ mod: true })
    expect(chordRevealed(parseChord(bindingOf('studio.layout.sidebar')), onlyMod, true)).toBe(true)
    expect(chordRevealed(parseChord(bindingOf('studio.layout.surface')), onlyMod, true)).toBe(true)
    expect(chordRevealed(parseChord(bindingOf('studio.surface.diff')), onlyMod, true)).toBe(true)
  })

  it('narrows to canvas tabs and the canvas toggle once Alt joins', () => {
    const modAlt = held({ mod: true, alt: true })
    expect(chordRevealed(parseChord(bindingOf('studio.surface.status')), modAlt, true)).toBe(true)
    expect(chordRevealed(parseChord(bindingOf('studio.layout.surface')), modAlt, true)).toBe(true)
    expect(chordRevealed(parseChord(bindingOf('studio.layout.sidebar')), modAlt, true)).toBe(false)
  })

  it('reveals the terminal toggle on Ctrl only', () => {
    const terminal = parseChord(bindingOf('terminal.toggle'))
    expect(chordRevealed(terminal, held({ ctrl: true }), true)).toBe(true)
    expect(chordRevealed(terminal, held({ mod: true }), true)).toBe(false)
  })
})

describe('hints follow a rebind', () => {
  it('reports the override glyphs and the override modifier, not the default', () => {
    const overrides = { 'studio.layout.sidebar': 'Ctrl+Shift+s' }
    const rebound = resolveViewBindings('studio', overrides).activeBindings.get('studio.layout.sidebar')!
    expect(formatChord(rebound.binding)).toBe('⌃⇧S')
    // The default was ⌘B, so ⌘ must no longer reveal it and ⌃ must.
    expect(chordRevealed(parseChord(rebound.binding), held({ mod: true }), true)).toBe(false)
    expect(chordRevealed(parseChord(rebound.binding), held({ ctrl: true }), true)).toBe(true)
  })
})
