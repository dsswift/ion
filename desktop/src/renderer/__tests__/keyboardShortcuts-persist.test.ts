import { describe, expect, it, vi } from 'vitest'
import { sanitizeKeyboardShortcuts } from '../preferences-shortcuts'

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
    const { SETTINGS_DEFAULTS } = await import('../preferences-types')
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
    ;(globalThis as any).window = { ion: { loadSettings: () => Promise.resolve({ keyboardShortcuts: { overlay: { 'tab.next': 'Mod+]' }, studio: { 'tab.prev': 'Mod+[' } } }) } }
    ;(globalThis as any).document = { documentElement: { style: {} } }
    const setState = vi.fn()
    loadPersistedSettings(setState, () => ({}) as any, vi.fn())
    await new Promise((resolve) => setImmediate(resolve))
    expect(setState.mock.calls[0][0].keyboardShortcuts).toEqual({ overlay: { 'tab.next': 'Mod+]' }, studio: { 'tab.prev': 'Mod+[' } })
  })
})
