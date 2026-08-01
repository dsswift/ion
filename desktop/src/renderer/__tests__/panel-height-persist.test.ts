// @vitest-environment jsdom
/**
 * Panel-height persistence — the behavior half (the structural round-trip
 * test pins enumeration/hydration key coverage).
 *
 * jsdom: the debounce test imports the real preferences store, whose module
 * bootstrap applies the theme to document.documentElement.
 *
 * Pins:
 *   1. Hydration accepts a saved pixel height and rejects garbage (negative,
 *      NaN, string) back to null — null is "use the default".
 *   2. The setters debounce the disk write: a drag commits per mousemove
 *      frame, and persisting each frame would turn one drag into hundreds of
 *      atomic writes of ~/.ion/settings.json.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PreferencesState } from '../preferences-types'
import { loadPersistedSettings } from '../preferences-persist'

let originalIon: unknown

function stubIon(disk: Record<string, unknown>, saveSpy?: (s: Record<string, unknown>) => void): void {
  // jsdom provides window/document; only the ion bridge is stubbed.
  ;(window as unknown as { ion: unknown }).ion = {
    loadSettings: () => Promise.resolve(disk),
    saveSettings: (s: Record<string, unknown>) => { saveSpy?.(s); return Promise.resolve() },
  }
}

beforeEach(() => {
  originalIon = (window as unknown as { ion?: unknown }).ion
})

afterEach(() => {
  ;(window as unknown as { ion?: unknown }).ion = originalIon
  vi.useRealTimers()
})

async function hydrate(disk: Record<string, unknown>): Promise<Partial<PreferencesState>> {
  stubIon(disk)
  const setState = vi.fn()
  loadPersistedSettings(setState, () => ({ _systemIsDark: false } as unknown as PreferencesState), vi.fn())
  await new Promise((r) => setTimeout(r, 0))
  expect(setState).toHaveBeenCalled()
  return setState.mock.calls[0][0] as Partial<PreferencesState>
}

describe('panel height hydration', () => {
  it('accepts a saved pixel height for both panels', async () => {
    const patch = await hydrate({ gitPanelHeight: 640, fileExplorerHeight: 512 })
    expect(patch.gitPanelHeight).toBe(640)
    expect(patch.fileExplorerHeight).toBe(512)
  })

  it('rejects garbage back to null (use the default)', async () => {
    for (const bad of [-100, 0, NaN, Infinity, 'tall', true]) {
      const patch = await hydrate({ gitPanelHeight: bad, fileExplorerHeight: bad })
      expect(patch.gitPanelHeight, `gitPanelHeight should reject ${String(bad)}`).toBeNull()
      expect(patch.fileExplorerHeight, `fileExplorerHeight should reject ${String(bad)}`).toBeNull()
    }
  })

  it('hydrates absent keys (a pre-feature settings file) to null', async () => {
    const patch = await hydrate({})
    expect(patch.gitPanelHeight).toBeNull()
    expect(patch.fileExplorerHeight).toBeNull()
  })
})

describe('panel height save debouncing', () => {
  it('writes settings once after a burst of drag-frame commits', async () => {
    vi.useFakeTimers()
    const saves: Record<string, unknown>[] = []
    stubIon({}, (s) => saves.push(s))

    // Import fresh so the store binds to the stubbed window.ion.
    vi.resetModules()
    const { usePreferencesStore } = await import('../preferences')

    // A drag: dozens of per-frame commits.
    for (let h = 400; h <= 700; h += 10) {
      usePreferencesStore.getState().setGitPanelHeight(h)
    }
    expect(saves.length, 'no disk write during the drag').toBe(0)
    // The store tracked every frame live.
    expect(usePreferencesStore.getState().gitPanelHeight).toBe(700)

    vi.advanceTimersByTime(500)
    expect(saves.length, 'exactly one trailing-edge write').toBe(1)
    expect(saves[0].gitPanelHeight).toBe(700)
  })
})
