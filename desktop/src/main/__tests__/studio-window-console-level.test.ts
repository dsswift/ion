/**
 * Electron's console levels are 0 verbose, 1 info, 2 warning, 3 error. The two
 * lowest were mapped the wrong way round -- verbose to DEBUG and info to TRACE
 * -- so the more important of the two was recorded at the lower level. At the
 * default level (DEBUG) that meant a stray console.log or console.info from
 * third-party renderer code was dropped while console.debug was kept.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logger = vi.hoisted(() => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() }))
const mocks = vi.hoisted(() => {
  const webContentsHandlers = new Map<string, (...args: unknown[]) => void>()
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isMaximized: vi.fn(() => true),
    isVisible: vi.fn(() => true),
    isFocused: vi.fn(() => true),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1440, height: 900 })),
    minimize: vi.fn(),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    maximize: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    webContents: {
      isCrashed: vi.fn(() => false),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => { webContentsHandlers.set(event, cb) }),
      once: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      reload: vi.fn(),
      send: vi.fn(),
    },
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
  }
  return { webContentsHandlers, window }
})

vi.mock('electron', () => ({
  app: { focus: vi.fn(), setActivationPolicy: vi.fn(), dock: { hide: vi.fn() } },
  BrowserWindow: vi.fn(function BrowserWindow() { return mocks.window }),
}))
vi.mock('../logger', () => logger)
vi.mock('@ion/server/state', async (importOriginal) => ({ ...(await importOriginal()), ...{
  enterprisePolicyCache: { policy: null },
  state: { mainWindow: null, studioWindow: null, forceQuit: false },
} }))
vi.mock('@ion/server/persistence/settings-store', () => ({
  readSettings: () => ({ studioTheme: 'ion-works' }),
  writeSettings: vi.fn(),
}))
vi.mock('@ion/server/engine/studio-state-cache', () => ({ getStudioState: vi.fn(() => ({ agents: [] })) }))
vi.mock('../studio-beacon', () => ({ clearBeacon: vi.fn() }))
vi.mock('@ion/server/deeplink/confirm', () => ({
  markDeepLinkConfirmationReady: vi.fn(),
  markDeepLinkConfirmationUnavailable: vi.fn(),
}))
vi.mock('../renderer-crash-guard', () => ({ attemptRendererRecovery: vi.fn(), resetRendererCrashGuard: vi.fn() }))
vi.mock('../webview-policy', () => ({ installWebviewPolicy: vi.fn() }))

import { state } from '../state'
import { openStudioWindow } from '../studio-window-manager'

/** Deliver one console message at an Electron level to the installed handler. */
function consoleMessage(level: number, message: string): void {
  const handler = mocks.webContentsHandlers.get('console-message')
  if (!handler) throw new Error('studio window installed no console-message handler')
  handler({}, level, message)
}

describe('studio renderer console forwarding', () => {
  beforeEach(() => {
    for (const fn of Object.values(logger)) fn.mockClear()
    mocks.webContentsHandlers.clear()
    state.studioWindow = null
    openStudioWindow()
  })

  it('records info above verbose, not below it', () => {
    consoleMessage(0, 'verbose chatter')
    consoleMessage(1, 'an info line')

    expect(logger.trace).toHaveBeenCalledWith('studio-renderer', 'verbose chatter')
    expect(logger.debug).toHaveBeenCalledWith('studio-renderer', 'an info line')
  })

  it('keeps warning and error at their own levels', () => {
    consoleMessage(2, 'a warning')
    consoleMessage(3, 'an error')

    expect(logger.warn).toHaveBeenCalledWith('studio-renderer', 'a warning')
    expect(logger.error).toHaveBeenCalledWith('studio-renderer', 'an error')
  })
})
