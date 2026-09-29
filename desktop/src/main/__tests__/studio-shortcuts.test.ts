/**
 * studio-shortcuts — regression coverage for the single-UI shortcut
 * registration that replaced active-ui.ts's registerActiveUiShortcuts once
 * there was nothing left to switch between (the Overlay glass is gone).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  unregisterAll: vi.fn(),
  register: vi.fn((_accelerator: string, _callback: () => void) => true),
  toggleStudioWindow: vi.fn(),
  settings: {} as Record<string, unknown>,
}))

vi.mock('electron', () => ({
  globalShortcut: { unregisterAll: mocks.unregisterAll, register: mocks.register },
}))
vi.mock('@ion/server/persistence/settings-store', () => ({
  readSettings: () => mocks.settings,
}))
vi.mock('../studio-window-manager', () => ({
  toggleStudioWindow: mocks.toggleStudioWindow,
}))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

import { registerStudioShortcuts, resolveStudioShortcut, DEFAULT_STUDIO_SHORTCUT } from '../studio-shortcuts'

describe('resolveStudioShortcut', () => {
  it('falls back to the default accelerator when unset', () => {
    expect(resolveStudioShortcut({})).toBe(DEFAULT_STUDIO_SHORTCUT)
  })

  it('honors a valid configured accelerator', () => {
    expect(resolveStudioShortcut({ studioShortcut: 'Control+Alt+S' })).toBe('Control+Alt+S')
  })

  it('rejects a malformed accelerator (never arbitrary text)', () => {
    expect(resolveStudioShortcut({ studioShortcut: 'not an accelerator!' })).toBe('')
  })

  it('honors an explicit empty string as "no shortcut"', () => {
    expect(resolveStudioShortcut({ studioShortcut: '' })).toBe('')
  })
})

describe('registerStudioShortcuts', () => {
  beforeEach(() => {
    mocks.unregisterAll.mockClear()
    mocks.register.mockClear()
    mocks.settings = {}
  })

  it('unregisters everything first, then registers Alt+Space and the configured shortcut', () => {
    mocks.settings = { studioShortcut: 'Control+Alt+S' }
    registerStudioShortcuts()
    expect(mocks.unregisterAll).toHaveBeenCalledTimes(1)
    expect(mocks.register).toHaveBeenCalledWith('Alt+Space', expect.any(Function))
    expect(mocks.register).toHaveBeenCalledWith('Control+Alt+S', expect.any(Function))
  })

  it('registers only Alt+Space when the configured shortcut is empty', () => {
    mocks.settings = { studioShortcut: '' }
    registerStudioShortcuts()
    expect(mocks.register).toHaveBeenCalledTimes(1)
    expect(mocks.register).toHaveBeenCalledWith('Alt+Space', expect.any(Function))
  })

  it('Alt+Space toggles the Studio window', () => {
    registerStudioShortcuts()
    const altSpaceHandler = mocks.register.mock.calls.find((call) => call[0] === 'Alt+Space')?.[1]
    altSpaceHandler?.()
    expect(mocks.toggleStudioWindow).toHaveBeenCalledWith('shortcut Alt+Space')
  })
})
