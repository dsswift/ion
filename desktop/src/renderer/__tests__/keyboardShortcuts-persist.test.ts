import { describe, expect, it, vi } from 'vitest'
import { sanitizeKeyboardShortcuts } from '../preferences-shortcuts'
import { installFakeWire } from '../host/__tests__/fake-wire'

describe('per-view keyboard shortcut persistence', () => {
  it('keeps overlay and Studio overrides isolated', () => {
    expect(sanitizeKeyboardShortcuts({
      overlay: { 'tab.next': 'Mod+]' },
      studio: { 'tab.next': 'Mod+Shift+]' },
    })).toEqual({
      overlay: { 'tab.next': 'Mod+]' },
      studio: { 'tab.next': 'Mod+Shift+]' },
    })
  })

  it('migrates legacy flat overrides to overlay only', () => {
    expect(sanitizeKeyboardShortcuts({ 'tab.next': 'Mod+]' })).toEqual({
      overlay: { 'tab.next': 'Mod+]' },
      studio: {},
    })
  })

  it('drops malformed view values without affecting valid view', () => {
    expect(sanitizeKeyboardShortcuts({ overlay: { 'tab.next': 'Mod+]' }, studio: ['bad'] })).toEqual({
      overlay: { 'tab.next': 'Mod+]' },
      studio: {},
    })
  })

  it('persists nested per-view overrides', async () => {
    const { getAllSettings } = await import('../preferences-persist')
    const { SETTINGS_DEFAULTS } = await import('@ion/server/preferences-types')
    const keyboardShortcuts = { overlay: { 'tab.next': 'Mod+]' }, studio: {} }
    const state = { ...SETTINGS_DEFAULTS, keyboardShortcuts } as any
    expect(getAllSettings(() => state).keyboardShortcuts).toEqual(keyboardShortcuts)
  })

  it('updates and resets only selected view', async () => {
    const { createKeyboardShortcutActions } = await import('../preferences-shortcuts')
    let state: any = { keyboardShortcuts: { overlay: {}, studio: {} } }
    const save = vi.fn()
    const actions = createKeyboardShortcutActions(
      (patch) => { state = { ...state, ...patch } },
      () => state,
      save,
    )
    actions.setKeyboardShortcut('studio', 'tab.next', 'Mod+]')
    expect(state.keyboardShortcuts).toEqual({ overlay: {}, studio: { 'tab.next': 'Mod+]' } })
    actions.resetKeyboardShortcuts('studio')
    expect(state.keyboardShortcuts).toEqual({ overlay: {}, studio: {} })
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('hydrates nested per-view overrides', async () => {
    const { loadPersistedSettings } = await import('../preferences-persist')
    ;(globalThis as any).window = { ion: installFakeWire({ loadSettings: () => Promise.resolve({ keyboardShortcuts: { overlay: { 'tab.next': 'Mod+]' }, studio: { 'tab.prev': 'Mod+[' } } }) }) }
    ;(globalThis as any).document = { documentElement: { style: {} } }
    // The funnel reaches the stub through `host.shell` now. host-instance
    // re-decides Electron-vs-browser on every access, but it caches the host
    // INSTANCES; an ElectronStudioHost built by an earlier test already holds
    // a bridged shell bound to the previous `window.ion`, so drop it and let
    // the next access build one against the fake wire installed above.
    const { resetHostInstanceForTests } = await import('../host/host-instance')
    resetHostInstanceForTests()
    const setState = vi.fn()
    loadPersistedSettings(setState, () => ({}) as any, vi.fn())
    await new Promise((resolve) => setImmediate(resolve))
    expect(setState.mock.calls[0][0].keyboardShortcuts).toEqual({ overlay: { 'tab.next': 'Mod+]' }, studio: { 'tab.prev': 'Mod+[' } })
  })
})
