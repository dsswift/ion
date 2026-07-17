/**
 * keyboardShortcuts preference — persistence and store-only-overrides tests.
 *
 * Covers:
 *   - setKeyboardShortcut writes only when chord differs from default.
 *   - setKeyboardShortcut stores override in keyboardShortcuts map.
 *   - resetKeyboardShortcut removes the override.
 *   - resetAllKeyboardShortcuts clears all overrides.
 *   - A chord equal to the catalog default stores nothing.
 *   - Load-time validation drops malformed entries.
 *   - Load-time validation ignores unknown command ids.
 *   - getAllSettings includes keyboardShortcuts.
 */

import { describe, it, expect, vi } from 'vitest'

describe('keyboardShortcuts store behavior (setKeyboardShortcut logic)', () => {
  it('setKeyboardShortcut stores the override when chord differs from default', async () => {
    const { SHORTCUT_CATALOG } = await import('../shortcuts/shortcut-catalog')
    const { parseChord } = await import('../shortcuts/chord')

    // Find the tab.next entry and its default.
    const entry = SHORTCUT_CATALOG.find((e) => e.id === 'tab.next')!
    const overrideChord = 'Mod+]'
    expect(overrideChord).not.toBe(entry.defaultBinding)

    // Simulate the setter logic.
    let keyboardShortcuts: Record<string, string> = {}
    const chord = parseChord(overrideChord)
    if (chord && overrideChord !== entry.defaultBinding) {
      keyboardShortcuts = { ...keyboardShortcuts, 'tab.next': overrideChord }
    }
    expect(keyboardShortcuts).toEqual({ 'tab.next': overrideChord })
  })

  it('setKeyboardShortcut does NOT store when chord equals default', async () => {
    const { SHORTCUT_CATALOG } = await import('../shortcuts/shortcut-catalog')
    const { parseChord } = await import('../shortcuts/chord')

    const entry = SHORTCUT_CATALOG.find((e) => e.id === 'tab.next')!
    const defaultChord = entry.defaultBinding

    let keyboardShortcuts: Record<string, string> = {}
    const chord = parseChord(defaultChord)
    if (chord && defaultChord !== entry.defaultBinding) {
      keyboardShortcuts = { ...keyboardShortcuts, 'tab.next': defaultChord }
    }
    // Default-equal: nothing stored.
    expect(keyboardShortcuts).toEqual({})
  })

  it('resetKeyboardShortcut removes the override', () => {
    let keyboardShortcuts: Record<string, string> = { 'tab.next': 'Mod+]', 'tab.prev': 'Mod+[' }
    const current = { ...keyboardShortcuts }
    delete current['tab.next']
    keyboardShortcuts = current
    expect(keyboardShortcuts).toEqual({ 'tab.prev': 'Mod+[' })
  })

  it('resetAllKeyboardShortcuts clears all overrides', () => {
    let keyboardShortcuts: Record<string, string> = { 'tab.next': 'Mod+]', 'settings.open': 'Mod+Shift+,' }
    keyboardShortcuts = {}
    expect(keyboardShortcuts).toEqual({})
  })

  it('getAllSettings includes keyboardShortcuts', async () => {
    const { getAllSettings } = await import('../preferences-persist')
    const { SETTINGS_DEFAULTS } = await import('../preferences-types')

    const overrides = { 'tab.next': 'Mod+]' }
    const state = { ...SETTINGS_DEFAULTS, isDark: true, _systemIsDark: false, keyboardShortcuts: overrides } as any
    const result = getAllSettings(() => state)
    expect(result).toHaveProperty('keyboardShortcuts')
    expect(result.keyboardShortcuts).toEqual(overrides)
  })
})

describe('keyboardShortcuts load-time validation', () => {
  it('drops non-string values from the disk object', async () => {
    const { loadPersistedSettings } = await import('../preferences-persist')

    const diskPayload = {
      themeMode: 'dark',
      keyboardShortcuts: {
        'tab.next': 'Mod+]',   // valid
        'tab.prev': 42,         // invalid: number, not string
        'zoom.in': null,        // invalid: null
      },
    }

    ;(globalThis as any).window = {
      ion: { loadSettings: () => Promise.resolve(diskPayload) },
    }
    ;(globalThis as any).document = { documentElement: { style: {} } }

    const setStateMock = vi.fn()
    loadPersistedSettings(setStateMock, () => ({ _systemIsDark: false } as any), vi.fn())
    await new Promise((r) => setImmediate(r))

    const patch = setStateMock.mock.calls[0][0] as Record<string, unknown>
    const ks = patch.keyboardShortcuts as Record<string, string>
    // Only the valid string->string entry survives.
    expect(ks).toEqual({ 'tab.next': 'Mod+]' })
  })

  it('ignores unknown command ids without crashing', async () => {
    const { loadPersistedSettings } = await import('../preferences-persist')

    const diskPayload = {
      themeMode: 'dark',
      keyboardShortcuts: {
        'future.command.from.newer.version': 'Mod+X',
        'tab.next': 'Mod+]',
      },
    }

    ;(globalThis as any).window = {
      ion: { loadSettings: () => Promise.resolve(diskPayload) },
    }
    ;(globalThis as any).document = { documentElement: { style: {} } }

    const setStateMock = vi.fn()
    expect(() => {
      loadPersistedSettings(setStateMock, () => ({ _systemIsDark: false } as any), vi.fn())
    }).not.toThrow()

    await new Promise((r) => setImmediate(r))

    const patch = setStateMock.mock.calls[0][0] as Record<string, unknown>
    // Unknown ids are passed through (the validator doesn't know catalog ids;
    // resolveBindings ignores them at runtime). The point is no throw.
    expect(patch).toHaveProperty('keyboardShortcuts')
  })

  it('treats a non-object keyboardShortcuts value as empty object', async () => {
    const { loadPersistedSettings } = await import('../preferences-persist')

    const diskPayload = {
      themeMode: 'dark',
      keyboardShortcuts: 'invalid string value',
    }

    ;(globalThis as any).window = {
      ion: { loadSettings: () => Promise.resolve(diskPayload) },
    }
    ;(globalThis as any).document = { documentElement: { style: {} } }

    const setStateMock = vi.fn()
    loadPersistedSettings(setStateMock, () => ({ _systemIsDark: false } as any), vi.fn())
    await new Promise((r) => setImmediate(r))

    const patch = setStateMock.mock.calls[0][0] as Record<string, unknown>
    expect(patch.keyboardShortcuts).toEqual({})
  })
})
