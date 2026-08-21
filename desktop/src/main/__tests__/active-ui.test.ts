/**
 * Live active-UI switch (F3): flipping activeUi closes the active UI,
 * opens the other, re-registers shortcuts, rebuilds the tray — and the
 * owner window object is never recreated (uninterrupted renderer).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  unregisterAll: vi.fn(),
  register: vi.fn(() => true),
  showWindow: vi.fn(),
  toggleWindow: vi.fn(),
  createTray: vi.fn(),
  openStudioWindow: vi.fn(),
  toggleStudioWindow: vi.fn(),
  mainWindow: { hide: vi.fn(), isDestroyed: () => false, isVisible: () => true },
  studioWindow: null as { close: () => void; isDestroyed: () => boolean } | null,
  settings: {} as Record<string, unknown>,
}))

vi.mock('electron', () => ({
  globalShortcut: { unregisterAll: mocks.unregisterAll, register: mocks.register },
}))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../settings-store', () => ({
  readSettings: () => mocks.settings,
}))
vi.mock('../state', () => ({
  enterprisePolicyCache: { policy: null },
  state: {
    get mainWindow() {
      return mocks.mainWindow
    },
    get studioWindow() {
      return mocks.studioWindow
    },
    tray: { destroy: vi.fn() },
  },
}))
vi.mock('../window-manager', () => ({
  showWindow: mocks.showWindow,
  toggleWindow: mocks.toggleWindow,
  createTray: mocks.createTray,
}))
vi.mock('../studio-window-manager', () => ({
  openStudioWindow: mocks.openStudioWindow,
  toggleStudioWindow: mocks.toggleStudioWindow,
}))

import { applyActiveUiSwitch, registerActiveUiShortcuts, getActiveUiPlan } from '../active-ui'

function registeredShortcut(accelerator: string): () => void {
  const calls = mocks.register.mock.calls as unknown as Array<[string, () => void]>
  const callback = calls.findLast(([registered]) => registered === accelerator)?.[1]
  expect(callback).toBeTypeOf('function')
  return callback!
}

beforeEach(() => {
  mocks.unregisterAll.mockClear()
  mocks.register.mockClear()
  mocks.showWindow.mockClear()
  mocks.toggleWindow.mockClear()
  mocks.createTray.mockClear()
  mocks.openStudioWindow.mockClear()
  mocks.mainWindow.hide.mockClear()
  mocks.studioWindow = null
})

describe('applyActiveUiSwitch', () => {
  it('overlay → studio: hides the glass, opens Studio, re-registers, rebuilds tray', () => {
    mocks.settings = { activeUi: 'overlay' }
    registerActiveUiShortcuts(getActiveUiPlan())
    mocks.register.mockClear()

    mocks.settings = { activeUi: 'studio' }
    applyActiveUiSwitch()

    expect(mocks.unregisterAll).toHaveBeenCalledTimes(1)
    expect(mocks.mainWindow.hide).toHaveBeenCalledTimes(1)
    expect(mocks.openStudioWindow).toHaveBeenCalledTimes(1)
    expect(mocks.showWindow).not.toHaveBeenCalled()
    // Alt+Space re-registered (now targeting the Studio toggle) + the
    // studio accelerator.
    const registered = mocks.register.mock.calls.map((c) => (c as unknown[])[0])
    expect(registered).toContain('Alt+Space')
    expect(registered).toContain('Alt+Shift+Space')
    expect(mocks.createTray).toHaveBeenCalledTimes(1)

    const altSpace = registeredShortcut('Alt+Space')
    altSpace()
    expect(mocks.toggleStudioWindow).toHaveBeenCalledWith('shortcut Alt+Space (studio mode)')
    expect(mocks.toggleWindow).not.toHaveBeenCalled()
  })

  it('studio → overlay: closes the Studio window, shows the glass', () => {
    mocks.settings = { activeUi: 'studio' }
    registerActiveUiShortcuts(getActiveUiPlan())
    const close = vi.fn()
    mocks.studioWindow = { close, isDestroyed: () => false }

    mocks.settings = { activeUi: 'overlay' }
    applyActiveUiSwitch()

    expect(close).toHaveBeenCalledTimes(1)
    expect(mocks.showWindow).toHaveBeenCalledTimes(1)
    expect(mocks.openStudioWindow).not.toHaveBeenCalled()

    mocks.toggleStudioWindow.mockClear()
    const altSpace = registeredShortcut('Alt+Space')
    altSpace()
    expect(mocks.toggleWindow).toHaveBeenCalledWith('shortcut Alt+Space (overlay mode)')
    expect(mocks.toggleStudioWindow).not.toHaveBeenCalled()

  })

  it('no-op when the resolved UI is unchanged', () => {
    mocks.settings = { activeUi: 'overlay' }
    registerActiveUiShortcuts(getActiveUiPlan())
    applyActiveUiSwitch()
    expect(mocks.unregisterAll).not.toHaveBeenCalled()
    expect(mocks.showWindow).not.toHaveBeenCalled()
    expect(mocks.openStudioWindow).not.toHaveBeenCalled()
  })
})
