/**
 * shortcut-catalog.ts — resolveBindings tests.
 *
 * Covers:
 *   - Defaults pass through when no overrides.
 *   - Valid override replaces default.
 *   - Malformed override is dropped (tolerant load).
 *   - Unknown command id in overrides is ignored.
 *   - Conflict: deterministic winner by catalog order + logged warning.
 *   - Default-equal override is stored (catalog doesn't strip it — that's
 *     the preferences setter's job).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// rWarn from rendererLogger is the conflict logging path. Mock the module so
// we can spy on it without needing a real contextBridge / window.ion setup.
const { rWarnMock } = vi.hoisted(() => ({ rWarnMock: vi.fn() }))
vi.mock('../../rendererLogger', () => ({
  rTrace: vi.fn(),
  rDebug: vi.fn(),
  rInfo: vi.fn(),
  rWarn: rWarnMock,
  rError: vi.fn(),
}))

import { resolveBindings, SHORTCUT_CATALOG } from '../../shortcuts/shortcut-catalog'
import { parseChord } from '../../shortcuts/chord'

beforeEach(() => {
  rWarnMock.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveBindings — defaults', () => {
  it('returns a Map with an entry for every catalog command', () => {
    const bindings = resolveBindings({})
    for (const entry of SHORTCUT_CATALOG.filter((candidate) => candidate.views.includes('overlay'))) {
      // Every entry that has a valid defaultBinding should appear in the map
      // (unless it was trumped by a conflict, which default-only can't produce).
      const chord = parseChord(entry.defaultBinding)
      if (chord) {
        expect(bindings.has(entry.id)).toBe(true)
      }
    }
  })

  it('tab.next resolves to the catalog default Mod+l', () => {
    const bindings = resolveBindings({})
    const chord = bindings.get('tab.next')
    expect(chord).toMatchObject({ mod: true, key: 'l' })
  })

  it('zoom.in resolves to Mod+=', () => {
    const bindings = resolveBindings({})
    const chord = bindings.get('zoom.in')
    expect(chord).toMatchObject({ mod: true, key: '=' })
  })
})

describe('resolveBindings — override-fires / old-default-doesn\'t', () => {
  it('a valid override replaces the default binding', () => {
    // Override tab.next from Mod+l to Mod+]
    const bindings = resolveBindings({ 'tab.next': 'Mod+]' })
    const chord = bindings.get('tab.next')
    expect(chord).toMatchObject({ mod: true, key: ']' })
  })

  it('the old default chord is no longer in the resolved map for the overridden command', () => {
    // With override, Mod+l no longer belongs to tab.next.
    const bindings = resolveBindings({ 'tab.next': 'Mod+]' })
    const chord = bindings.get('tab.next')
    // Chord should be ] not l
    expect(chord?.key).toBe(']')
    expect(chord?.key).not.toBe('l')
  })

  it('other commands are unaffected by the override', () => {
    const bindings = resolveBindings({ 'tab.next': 'Mod+]' })
    const prevChord = bindings.get('tab.prev')
    expect(prevChord).toMatchObject({ mod: true, key: 'h' })
  })
})

describe('resolveBindings — tolerant load', () => {
  it('drops a malformed override (unknown modifier) and falls back to default', () => {
    const bindings = resolveBindings({ 'tab.next': 'Super+]' })
    // Super is not a valid modifier — override dropped, default used
    const chord = bindings.get('tab.next')
    expect(chord).toMatchObject({ mod: true, key: 'l' })
  })

  it('drops an empty-string override and falls back to default', () => {
    const bindings = resolveBindings({ 'tab.next': '' })
    const chord = bindings.get('tab.next')
    expect(chord).toMatchObject({ mod: true, key: 'l' })
  })

  it('ignores an unknown command id without throwing', () => {
    expect(() => resolveBindings({ 'nonexistent.command': 'Mod+Z' })).not.toThrow()
    const bindings = resolveBindings({ 'nonexistent.command': 'Mod+Z' })
    expect(bindings.has('nonexistent.command')).toBe(false)
  })
})

describe('resolveBindings — conflict handling', () => {
  it('logs a warning when two commands share a chord', () => {
    // Override tab.prev to use Mod+l — same as tab.next default.
    // Catalog order: tab.prev comes before tab.next, so tab.prev wins.
    resolveBindings({ 'tab.prev': 'Mod+l' })
    expect(rWarnMock).toHaveBeenCalledWith(
      'shortcuts',
      expect.stringContaining('conflict'),
      expect.any(Object),
    )
  })

  it('first-in-catalog-order wins when two commands share a chord', () => {
    // Override tab.prev to Mod+l (same as tab.next default).
    // tab.prev appears before tab.next in SHORTCUT_CATALOG.
    const bindings = resolveBindings({ 'tab.prev': 'Mod+l' })
    // tab.prev should get Mod+l (first resolved, wins)
    expect(bindings.get('tab.prev')).toMatchObject({ mod: true, key: 'l' })
    // tab.next should be absent (lost the conflict)
    expect(bindings.has('tab.next')).toBe(false)
  })
})

// ── panel.statusDrawer (Cmd+4) ──────────────────────────────────────────────
//
// Numbered panel defaults are shared across views: Inbox, Explorer, Git; the
// fourth command is view-specific behavior (Overlay status, Studio right pane).

describe('panel.statusDrawer', () => {
  it('is in the catalog, in the Panels group, bound to Mod+4', () => {
    const entry = SHORTCUT_CATALOG.find((e) => e.id === 'panel.statusDrawer')
    expect(entry).toBeDefined()
    expect(entry!.defaultBinding).toBe('Mod+4')
    expect(entry!.group).toBe('Panels')
  })

  it('resolves Mod+4 with no conflict, so nothing else already owned that chord', () => {
    const bindings = resolveBindings({})
    expect(bindings.get('panel.statusDrawer')).toMatchObject({ mod: true, key: '4' })
    expect(rWarnMock).not.toHaveBeenCalled()
  })

  it('sits beside shared numbered panel commands', () => {
    const bindings = resolveBindings({})
    expect(bindings.get('panel.inbox')).toMatchObject({ mod: true, key: '1' })
    expect(bindings.get('panel.explorer')).toMatchObject({ mod: true, key: '2' })
    expect(bindings.get('panel.git')).toMatchObject({ mod: true, key: '3' })
    expect(bindings.has('panel.terminal')).toBe(false)
    expect(bindings.get('terminal.toggle')).toMatchObject({ ctrl: true, key: '`' })
  })

  it('is rebindable like any other command', () => {
    const bindings = resolveBindings({ 'panel.statusDrawer': 'Mod+9' })
    expect(bindings.get('panel.statusDrawer')).toMatchObject({ mod: true, key: '9' })
  })
})

describe('resolveViewBindings', () => {
  it('keeps Overlay and Studio conflicts independent', async () => {
    const { resolveViewBindings } = await import('../../shortcuts/shortcut-catalog')
    const overlay = resolveViewBindings('overlay', { 'tab.prev': 'Mod+l' })
    const studio = resolveViewBindings('studio', {})
    expect(overlay.shortcuts.find((entry) => entry.entry.id === 'tab.next')?.enabled).toBe(false)
    expect(studio.shortcuts.find((entry) => entry.entry.id === 'tab.next')?.enabled).toBe(true)
  })

  it('retains conflict loser binding for Settings display', async () => {
    const { resolveViewBindings } = await import('../../shortcuts/shortcut-catalog')
    const result = resolveViewBindings('studio', { 'tab.prev': 'Mod+l' })
    const loser = result.shortcuts.find((entry) => entry.entry.id === 'tab.next')
    expect(loser).toMatchObject({ binding: 'Mod+l', enabled: false, conflictsWith: 'tab.prev' })
  })

  it('makes Cmd+K palette-only and Cmd+Y the tall control', async () => {
    const { SHORTCUT_CATALOG } = await import('../../shortcuts/shortcut-catalog')
    const palette = SHORTCUT_CATALOG.find((entry) => entry.id === 'app.commandPalette')
    const tall = SHORTCUT_CATALOG.find((entry) => entry.id === 'layout.tall')
    expect(palette?.defaultBinding).toBe('Mod+k')
    expect(tall?.defaultBinding).toBe('Mod+y')
    expect(SHORTCUT_CATALOG.some((entry) => entry.id === 'layout.expand')).toBe(false)
  })
})
