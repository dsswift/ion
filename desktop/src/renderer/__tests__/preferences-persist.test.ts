/**
 * Structural tests for preferences-persist round-trip.
 *
 * Two assertions pin the persistence defect class that produced the
 * `planModeAllowedBashCommands` BLOCKER in alignment-review:
 *
 *   1. `getAllSettings` enumerates every key in `SETTINGS_DEFAULTS`. The
 *      enumeration drives the `SAVE_SETTINGS` IPC payload; any key the
 *      enumeration omits is silently wiped from `~/.ion/settings.json`
 *      on every renderer save. Without this assertion every new
 *      preference is a silent persistence bug waiting to happen.
 *
 *   2. `loadPersistedSettings` hydrates every key in `SETTINGS_DEFAULTS`
 *      from disk. Any key the hydration omits is reset to its default
 *      on every launch even when the user saved a different value.
 *
 * The two assertions together cover both halves of the persistence
 * round-trip: save (renderer → disk) and load (disk → renderer).
 *
 * Pre-existing exclusions from `SETTINGS_DEFAULTS` that are intentional:
 *
 *   - `isDark`: derived at hydration time from `themeMode` + `_systemIsDark`.
 *     It's an output of the state, not a persisted input.
 *   - `_systemIsDark`: OS-environment value, not persisted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SETTINGS_DEFAULTS, type PreferencesState } from '../preferences-types'
import { getAllSettings, loadPersistedSettings } from '../preferences-persist'

// `isDark` is set inside loadPersistedSettings as a derived field. It
// belongs to the state but not to the persisted-defaults surface.
const DERIVED_KEYS_IN_HYDRATION = new Set(['isDark'])

// Build a synthetic PreferencesState. The data fields come from
// SETTINGS_DEFAULTS; action setters are no-ops; reads of unknown
// properties (none expected from getAllSettings) throw to make any
// future drift loud.
function syntheticState(): PreferencesState {
  const data: Record<string, unknown> = { ...SETTINGS_DEFAULTS, isDark: true, _systemIsDark: false }
  return new Proxy(data, {
    get(target, prop, recv) {
      if (typeof prop === 'string' && prop in target) return Reflect.get(target, prop, recv)
      // Action setters and any other functions called from getAllSettings
      // would be no-ops; but getAllSettings only reads data fields.
      return () => {}
    },
  }) as unknown as PreferencesState
}

describe('preferences-persist round-trip — structural', () => {
  it('getAllSettings enumerates every key in SETTINGS_DEFAULTS', () => {
    const state = syntheticState()
    const result = getAllSettings(() => state)

    const defaultKeys = Object.keys(SETTINGS_DEFAULTS).sort()
    const resultKeys = Object.keys(result).sort()

    // Differences in both directions. Diff in the failure message so the
    // first developer who adds a new preference sees exactly what they
    // missed.
    const missingFromGet = defaultKeys.filter((k) => !(k in result))
    const extraInGet = resultKeys.filter((k) => !(k in SETTINGS_DEFAULTS))

    expect(missingFromGet, `getAllSettings is missing keys from SETTINGS_DEFAULTS: ${missingFromGet.join(', ')}`).toEqual([])
    expect(extraInGet, `getAllSettings has keys not in SETTINGS_DEFAULTS: ${extraInGet.join(', ')}`).toEqual([])
  })

  describe('loadPersistedSettings hydrates every key in SETTINGS_DEFAULTS', () => {
    let setStateMock: ReturnType<typeof vi.fn<(patch: Partial<PreferencesState>) => void>>
    let originalIon: unknown

    beforeEach(() => {
      // Stash whatever `window.ion` was so we can restore it.
      originalIon = (globalThis as { window?: { ion?: unknown } }).window?.ion

      // Mock window.ion.loadSettings to resolve with a sentinel disk
      // payload. Use non-default values for every persisted key so the
      // hydration is forced to emit each one (otherwise we couldn't
      // distinguish "key was hydrated to default" from "key was omitted").
      const diskPayload: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) {
        diskPayload[k] = sentinelFor(k, v)
      }

      ;(globalThis as { window?: { ion?: unknown } }).window = {
        ion: {
          loadSettings: () => Promise.resolve(diskPayload),
        },
      } as unknown as Window & typeof globalThis

      // Minimal document stub for the `document.documentElement.style.zoom`
      // call inside loadPersistedSettings (fires when uiZoom !== 1, which
      // the sentinel forces). The renderer assumes a DOM at runtime; in
      // the node-only test environment we provide just enough surface
      // for the assignment to succeed.
      ;(globalThis as { document?: unknown }).document = {
        documentElement: { style: {} as Record<string, string> },
      }

      setStateMock = vi.fn()
    })

    afterEach(() => {
      ;(globalThis as { window?: { ion?: unknown } }).window = { ion: originalIon } as Window & typeof globalThis
    })

    it('emits every SETTINGS_DEFAULTS key in the setState patch', async () => {
      const getStateMock = () => ({ _systemIsDark: false } as unknown as PreferencesState)
      const applyThemeMock = vi.fn()

      loadPersistedSettings(setStateMock, getStateMock, applyThemeMock)

      // loadPersistedSettings calls window.ion.loadSettings() which is
      // async; flush the microtask queue before asserting.
      await new Promise((resolve) => setImmediate(resolve))

      expect(setStateMock).toHaveBeenCalledOnce()
      const patch = setStateMock.mock.calls[0][0] as Record<string, unknown>

      const defaultKeys = Object.keys(SETTINGS_DEFAULTS).sort()
      const patchKeys = Object.keys(patch).sort()

      const missingFromPatch = defaultKeys.filter((k) => !(k in patch))
      // Extras in the patch are allowed only for documented derived keys.
      const extraInPatch = patchKeys.filter((k) => !(k in SETTINGS_DEFAULTS) && !DERIVED_KEYS_IN_HYDRATION.has(k))

      expect(missingFromPatch, `loadPersistedSettings did not hydrate: ${missingFromPatch.join(', ')}`).toEqual([])
      expect(extraInPatch, `loadPersistedSettings emitted keys neither in SETTINGS_DEFAULTS nor in DERIVED_KEYS_IN_HYDRATION: ${extraInPatch.join(', ')}`).toEqual([])
    })
  })
})

/**
 * Produce a sentinel disk value for a given default. The sentinel must
 * be type-compatible with the default (so hydration accepts it) but
 * distinct (so we can be sure the value flowed through hydration
 * rather than being silently re-defaulted). For arrays and maps we
 * use empty literals — the hydration validators check `Array.isArray`
 * / object-shape, not non-emptiness.
 */
function sentinelFor(key: string, defaultValue: unknown): unknown {
  if (defaultValue === null) {
    // remoteDisplay default is null. Pass a valid object so hydration
    // emits it as a non-default value.
    if (key === 'remoteDisplay') {
      return { customName: 'test', customIcon: 'icon', updatedAt: 1 }
    }
    // Group-id fields default to null; pass a string so the hydration
    // string-typeof check picks them up.
    return 'group-id'
  }
  if (typeof defaultValue === 'boolean') return !defaultValue
  if (typeof defaultValue === 'number') {
    // Stay within validated ranges (uiZoom is clamped 0.5..2.0,
    // tabRecoveryTimeoutSec is clamped 30..600, editorFontSize 8..24).
    if (key === 'uiZoom') return 1.2
    if (key === 'tabRecoveryTimeoutSec') return 90
    if (key === 'editorFontSize') return 14
    return 42
  }
  if (typeof defaultValue === 'string') {
    // themeMode must be one of 'light', 'dark', or it falls back to 'dark'.
    // preferredOpenWith must be 'cli' or 'vscode'.
    // gitOpsMode must be 'manual' or 'worktree'.
    // worktreeCompletionStrategy must be 'merge-ff' | 'merge' | 'pr'.
    // defaultPermissionMode must be 'auto' or 'plan'.
    // tabGroupMode must be 'off' | 'auto' | 'manual'.
    if (key === 'themeMode') return 'light'
    if (key === 'preferredOpenWith') return 'vscode'
    if (key === 'gitOpsMode') return 'worktree'
    if (key === 'worktreeCompletionStrategy') return 'merge'
    if (key === 'defaultPermissionMode') return 'auto'
    if (key === 'tabGroupMode') return 'manual'
    return 'sentinel'
  }
  if (Array.isArray(defaultValue)) {
    // engineProfiles / quickTools / tabGroups / pairedDevices have
    // per-item shape filters; an empty array is fine for the hydration
    // shape check.
    return []
  }
  if (typeof defaultValue === 'object') {
    return {}
  }
  return defaultValue
}
