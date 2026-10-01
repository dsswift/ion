// @vitest-environment jsdom
/**
 * Pins `persist()`'s core contract: a setter call saves ONLY the field(s)
 * it changed, never the full in-memory snapshot.
 *
 * Production incident, 2026-09-16: every setter called
 * `saveSettings(getAllSettings(get))` -- the whole store. The server merges
 * a save onto the caller's existing per-identity overlay
 * (`user-settings-store.ts`), so every field in that snapshot became a
 * permanent override, whether or not the user had actually touched it. An
 * unrelated save froze an empty `projects: {}` and a stale `preferredModel`
 * into a real user's overlay file, silently hiding a newly-registered
 * Project and a shipped default-model fix until the frozen keys were found
 * and manually deleted from the overlay on the live server.
 *
 * This test reproduces the exact mechanism: seed the store with several
 * fields holding non-default values (standing in for "other tabs/settings
 * this session happens to have loaded"), call one unrelated setter, and
 * assert the save payload contains only that setter's own field. Before the
 * fix (`saveSettings(getAllSettings(get))`), this test fails because the
 * seeded fields ride along in every save.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { installFakeWire } from '../host/__tests__/fake-wire'

let originalIon: unknown

function stubIon(saveSpy: (s: Record<string, unknown>) => void, deviceSpy: (s: Record<string, unknown>) => void = () => {}): void {
  ;(window as unknown as { ion: unknown }).ion = installFakeWire({
    loadSettings: () => Promise.resolve({}),
    saveSettings: (s: Record<string, unknown>) => { saveSpy(s); return Promise.resolve() },
    hostSetDeviceSetting: (key: string, value: unknown) => { deviceSpy({ [key]: value }); return Promise.resolve() },
  })
}

afterEach(() => {
  ;(window as unknown as { ion?: unknown }).ion = originalIon
})

describe('persist() — save scope', () => {
  it('a setter call saves only its own field, not other in-memory fields', async () => {
    const saves: Record<string, unknown>[] = []
    const serverSaves: Record<string, unknown>[] = []
    originalIon = (window as unknown as { ion?: unknown }).ion
    // The sound toggle is a Device setting, so its one write lands in this
    // client's own store and nothing at all goes to the server.
    stubIon((s) => serverSaves.push(s), (s) => saves.push(s))

    vi.resetModules()
    const { usePreferencesStore } = await import('../preferences')

    // Stand in for "other settings this session happens to hold in memory"
    // -- exactly the shape of the real incident, where an unrelated field's
    // in-memory value got frozen into the overlay by a sibling setter call.
    usePreferencesStore.setState({
      preferredModel: 'dci-marketing/claude-sonnet-5',
      projects: { '/data/home/jdoe/orion': { addedManually: true, lastUsedAt: 0, isDefault: true } },
    })
    saves.length = 0 // setState() above is not a persisted setter; clear any incidental noise

    usePreferencesStore.getState().setSoundEnabled(false)

    expect(saves.length, 'exactly one save for the one setter call').toBe(1)
    expect(saves[0]).toEqual({ soundEnabled: false })
    expect(saves[0], 'must not carry the unrelated in-memory projects field').not.toHaveProperty('projects')
    expect(saves[0], 'must not carry the unrelated in-memory preferredModel field').not.toHaveProperty('preferredModel')
    expect(serverSaves, 'a Device setting never reaches a server').toEqual([])
  })

  it('a multi-field setter saves exactly the fields it changed, together', async () => {
    const saves: Record<string, unknown>[] = []
    originalIon = (window as unknown as { ion?: unknown }).ion
    stubIon((s) => saves.push(s))

    vi.resetModules()
    const { usePreferencesStore } = await import('../preferences')
    usePreferencesStore.setState({ preferredModel: 'dci-marketing/claude-sonnet-5' })
    saves.length = 0

    usePreferencesStore.getState().addRecentBaseDirectory('/data/home/jdoe/orion')

    expect(saves.length).toBe(1)
    expect(Object.keys(saves[0]).sort()).toEqual(['directoryUsageCounts', 'recentBaseDirectories'])
    expect(saves[0]).not.toHaveProperty('preferredModel')
  })
})
