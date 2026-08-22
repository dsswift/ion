import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const events = new Map<string, Array<(...args: unknown[]) => void>>()
  const settings: Record<string, unknown> = { activeUi: 'studio' }
  const normalBounds = { x: 120, y: 80, width: 1440, height: 900 }
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isMaximized: vi.fn(() => true),
    isVisible: vi.fn(() => true),
    isFocused: vi.fn(() => true),
    getNormalBounds: vi.fn(() => normalBounds),
    minimize: vi.fn(),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    maximize: vi.fn(),
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const callbacks = events.get(event) ?? []
      callbacks.push(callback)
      events.set(event, callbacks)
    }),
    once: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const callbacks = events.get(event) ?? []
      callbacks.push(callback)
      events.set(event, callbacks)
    }),
    webContents: {
      isCrashed: vi.fn(() => false),
      on: vi.fn(),
      once: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      reload: vi.fn(),
      send: vi.fn(),
    },
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
  }
  return {
    events,
    settings,
    normalBounds,
    window,
    writeSettings: vi.fn(),
    appFocus: vi.fn(),
  }
})

vi.mock('electron', () => ({
  app: { focus: mocks.appFocus, setActivationPolicy: vi.fn(), dock: { hide: vi.fn() } },
  BrowserWindow: vi.fn(function BrowserWindow() { return mocks.window }),
}))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() }))
vi.mock('../state', () => ({
  enterprisePolicyCache: { policy: null },
  state: { mainWindow: null, studioWindow: null, forceQuit: false },
}))
vi.mock('../settings-store', () => ({
  readSettings: () => mocks.settings,
  writeSettings: mocks.writeSettings,
}))
vi.mock('../surface-launch', () => ({ resolveSurfacePlan: () => ({ activeUi: 'studio' }) }))
vi.mock('../studio-state-cache', () => ({ getStudioState: vi.fn(() => ({ agents: [] })) }))
vi.mock('../studio-beacon', () => ({ clearBeacon: vi.fn() }))
vi.mock('../deeplink/confirm', () => ({
  markDeepLinkConfirmationReady: vi.fn(),
  markDeepLinkConfirmationUnavailable: vi.fn(),
}))
vi.mock('../renderer-crash-guard', () => ({ attemptRendererRecovery: vi.fn(), resetRendererCrashGuard: vi.fn() }))
vi.mock('../webview-policy', () => ({ installWebviewPolicy: vi.fn() }))

import { state } from '../state'
import { openStudioWindow, toggleStudioWindow } from '../studio-window-manager'

function fire(event: string): void {
  for (const callback of mocks.events.get(event) ?? []) callback()
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.events.clear()
  mocks.settings.activeUi = 'studio'
  delete mocks.settings.studioBounds
  vi.clearAllMocks()
  Object.assign(mocks.window, {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isMaximized: vi.fn(() => true),
    isVisible: vi.fn(() => true),
    isFocused: vi.fn(() => true),
    getNormalBounds: vi.fn(() => mocks.normalBounds),
  })
  ;(state as { studioWindow: unknown }).studioWindow = mocks.window
})

afterEach(() => vi.useRealTimers())

describe('Studio shortcut window lifecycle', () => {
  it('minimizes focused Studio after synchronously preserving normal bounds and maximized state', () => {
    toggleStudioWindow('test shortcut')

    expect(mocks.writeSettings).toHaveBeenCalledWith({
      activeUi: 'studio',
      studioBounds: { bounds: mocks.normalBounds, maximized: true },
    })
    expect(mocks.window.minimize).toHaveBeenCalledTimes(1)
    expect(mocks.window.restore).not.toHaveBeenCalled()
    expect(mocks.window.show).not.toHaveBeenCalled()
  })

  it('restores minimized Studio natively without changing geometry', () => {
    mocks.window.isMinimized.mockReturnValue(true)
    mocks.window.isVisible.mockReturnValue(false)

    toggleStudioWindow('test shortcut')

    expect(mocks.window.restore).toHaveBeenCalledTimes(1)
    expect(mocks.window.focus).toHaveBeenCalledTimes(1)
    expect(mocks.window.show).not.toHaveBeenCalled()
    expect(mocks.window.minimize).not.toHaveBeenCalled()
    expect(mocks.writeSettings).not.toHaveBeenCalled()
  })

  it('focuses visible but backgrounded Studio without minimizing it', () => {
    mocks.window.isFocused.mockReturnValue(false)

    toggleStudioWindow('test shortcut')

    expect(mocks.window.focus).toHaveBeenCalledTimes(1)
    expect(mocks.window.minimize).not.toHaveBeenCalled()
    expect(mocks.window.show).not.toHaveBeenCalled()
  })

  it('does not overwrite saved bounds from resize events while Studio is minimized', () => {
    ;(state as { studioWindow: unknown }).studioWindow = null
    openStudioWindow('test setup')
    toggleStudioWindow('test shortcut')
    mocks.window.isMinimized.mockReturnValue(true)
    fire('resize')
    vi.advanceTimersByTime(400)

    expect(mocks.writeSettings).toHaveBeenCalledTimes(1)
  })

  it('flushes current geometry before closing Studio for a mode switch', () => {
    ;(state as { studioWindow: unknown }).studioWindow = null
    openStudioWindow('mode switch')
    fire('close')

    expect(mocks.writeSettings).toHaveBeenCalledWith({
      activeUi: 'studio',
      studioBounds: { bounds: mocks.normalBounds, maximized: true },
    })
  })
})
