import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const once = new Map<string, () => void>()
  const window = {
    isDestroyed: vi.fn(() => false),
    show: vi.fn(),
    on: vi.fn(),
    once: vi.fn((event: string, callback: () => void) => { once.set(event, callback) }),
    webContents: { on: vi.fn() },
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
  }
  return { once, window, options: [] as Array<Record<string, unknown>>, appFocus: vi.fn() }
})

vi.mock('electron', () => ({
  app: { focus: mocks.appFocus },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
  BrowserWindow: vi.fn(function BrowserWindow(options: Record<string, unknown>) {
    mocks.options.push(options)
    return mocks.window
  }),
}))
vi.mock('../logger', () => ({ log: vi.fn(), error: vi.fn() }))
vi.mock('../state', () => ({ state: { splashWindow: null } }))

import { state } from '../state'
import { createStartupWindow } from '../startup-window'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.options.length = 0
  mocks.once.clear()
  ;(state as { splashWindow: unknown }).splashWindow = null
})

describe('startup splash window', () => {
  // Pinned on top, the splash covered the installer and the browser sign-in
  // page it had opened itself, and it was absent from Cmd-Tab, Stage Manager
  // and the taskbar, so there was no way to switch back to it either.
  it('is an ordinary window: not pinned on top, listed in the app switcher, and movable', () => {
    createStartupWindow()

    const options = mocks.options[0]
    expect(options.alwaysOnTop).not.toBe(true)
    expect(options.skipTaskbar).not.toBe(true)
    expect(options.movable).toBe(true)
    expect(options.title).toBe('Ion')
  })

  it('opens in front once when first shown', () => {
    createStartupWindow()
    mocks.once.get('ready-to-show')?.()

    expect(mocks.window.show).toHaveBeenCalled()
    if (process.platform === 'darwin') expect(mocks.appFocus).toHaveBeenCalledWith({ steal: true })
  })
})
