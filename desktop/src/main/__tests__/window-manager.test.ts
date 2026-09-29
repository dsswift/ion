/**
 * window-manager — tray lifecycle (Studio-only build).
 *
 * The overlay glass window, its `createWindow`/`showWindow`/`toggleWindow`
 * lifecycle, and the `resolveSurfacePlan` gate are gone with the Overlay
 * (see the desktop overlay removal spec). What remains here is tray
 * creation and the CSP installer — this file tests the tray.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const mockTrayOn = vi.fn()
const mockOpenStudioWindow = vi.fn()

vi.mock('electron', () => {
  return {
    app: {
      getPath: vi.fn().mockReturnValue('/tmp'),
      on: vi.fn(),
      quit: vi.fn(),
    },
    session: {
      defaultSession: {
        webRequest: { onHeadersReceived: vi.fn() },
      },
    },
    Menu: { buildFromTemplate: vi.fn((template: any) => template) },
    nativeImage: { createFromPath: vi.fn().mockReturnValue({ setTemplateImage: vi.fn() }) },
    Tray: vi.fn().mockImplementation(function () {
      return { setToolTip: vi.fn(), setContextMenu: vi.fn(), on: mockTrayOn, isDestroyed: vi.fn().mockReturnValue(false), destroy: vi.fn() }
    }),
  }
})

vi.mock('@ion/server/state', async (importOriginal) => ({ ...(await importOriginal()), ...{
  state: { tray: null },
  SPACES_DEBUG: false,
} }))

vi.mock('../logger', () => ({
  log: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../local-server-instance', () => ({
  localServer: { restart: vi.fn() },
}))

// Resolves rather than returns: restartEngineDaemon shells out to launchctl
// asynchronously so the tray click never blocks the main thread.
const mockRestartEngineDaemon = vi.fn().mockResolvedValue(true)
vi.mock('@ion/server/engine/engine-bootstrap', () => ({
  restartEngineDaemon: mockRestartEngineDaemon,
}))

vi.mock('../studio-window-manager', () => ({
  openStudioWindow: mockOpenStudioWindow,
}))

describe('window-manager createTray()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // window-all-closed keeps Ion resident whenever a tray exists, on the premise
  // that the tray can bring it back. On Windows and Linux a context menu opens
  // on right-click only, so without a 'click' handler the icon is inert and a
  // closed Studio window leaves a running app with no way into it.
  it('opens Ion Studio on a tray left-click off darwin', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const { createTray } = await import('../window-manager')
      createTray()

      const click = mockTrayOn.mock.calls.find((c) => c[0] === 'click')
      expect(click).toBeDefined()

      click![1]()
      expect(mockOpenStudioWindow).toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  // macOS opens the context menu on left-click itself; a handler there would be
  // a second, conflicting meaning for the same gesture.
  it('leaves the darwin left-click to the platform', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const { createTray } = await import('../window-manager')
      createTray()
      expect(mockTrayOn.mock.calls.find((c) => c[0] === 'click')).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('exposes a "Restart Engine" item that recycles the daemon (kickstart -k) without quitting', async () => {
    const electron = await import('electron')
    const { createTray } = await import('../window-manager')
    createTray()

    // The tray context menu was built from a template; find the Restart item.
    const buildCalls = (electron.Menu.buildFromTemplate as any).mock.calls
    const template = buildCalls[buildCalls.length - 1][0] as Array<{ label?: string; click?: () => void }>
    const restartItem = template.find((i) => i.label === 'Restart Engine')

    expect(restartItem).toBeDefined()
    expect(typeof restartItem!.click).toBe('function')

    // Invoking it force-restarts the persistent daemon so it re-reads config,
    // without booting it out or quitting the desktop.
    restartItem!.click!()
    expect(mockRestartEngineDaemon).toHaveBeenCalledTimes(1)
  })
})
