/**
 * window-manager — overlay window level regression
 *
 * Asserts that createWindow() sets the window level to 'modal-panel', not
 * 'screen-saver'. 'screen-saver' (CGWindowLevel 2000) sits above macOS TCC
 * and permission dialogs (~1000), hiding them behind the overlay in tall mode.
 * 'modal-panel' keeps the overlay above normal apps but below system dialogs.
 *
 * If this test fails after a change to window-manager.ts, the window level
 * was raised back to 'screen-saver' (or higher). Do not suppress — fix it.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ─── Shared mock state (hoisted so factory closures can capture it) ───────────

const { mockSetAlwaysOnTop, _mockSetVisibleOnAllWorkspaces, mockWindowInstance } = vi.hoisted(() => {
  const mockSetAlwaysOnTop = vi.fn()
  const _mockSetVisibleOnAllWorkspaces = vi.fn()

  const mockWindowInstance = {
    setAlwaysOnTop: mockSetAlwaysOnTop,
    setVisibleOnAllWorkspaces: _mockSetVisibleOnAllWorkspaces,
    webContents: {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      focus: vi.fn(),
    },
    once: vi.fn(),
    on: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    setBounds: vi.fn(),
    isVisible: vi.fn().mockReturnValue(false),
    isDestroyed: vi.fn().mockReturnValue(false),
  }

  return { mockSetAlwaysOnTop, _mockSetVisibleOnAllWorkspaces, mockWindowInstance }
})

vi.mock('electron', () => {
  // BrowserWindow must be a real constructor function so `new BrowserWindow()`
  // works. The constructor ignores its arguments and returns the shared mock
  // instance, which carries the spy methods we assert on.
  function BrowserWindow() {
    return mockWindowInstance
  }
  BrowserWindow.getAllWindows = vi.fn().mockReturnValue([])

  return {
    app: {
      getPath: vi.fn().mockReturnValue('/tmp'),
      on: vi.fn(),
    },
    BrowserWindow,
    screen: {
      getCursorScreenPoint: vi.fn().mockReturnValue({ x: 0, y: 0 }),
      getDisplayNearestPoint: vi.fn().mockReturnValue({
        id: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
    session: {
      defaultSession: {
        webRequest: { onHeadersReceived: vi.fn() },
      },
    },
    globalShortcut: { unregisterAll: vi.fn() },
    Menu: { buildFromTemplate: vi.fn((template: any) => template) },
    nativeImage: { createFromPath: vi.fn().mockReturnValue({ setTemplateImage: vi.fn() }) },
    Tray: vi.fn().mockImplementation(function () {
      return { setToolTip: vi.fn(), setContextMenu: vi.fn(), isDestroyed: vi.fn().mockReturnValue(false), destroy: vi.fn() }
    }),
    dialog: { showMessageBoxSync: vi.fn().mockReturnValue(2) },
    ipcMain: { on: vi.fn(), handle: vi.fn() },
  }
})

vi.mock('../state', () => ({
  state: { mainWindow: null, tray: null, toggleSequence: 0, forceQuit: false },
  SPACES_DEBUG: false,
  sessionPlane: { hasRunningTabs: vi.fn().mockReturnValue(false), shutdown: vi.fn() },
  engineBridge: { shutdownAndWait: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  flushLogs: vi.fn(),
}))

vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))

vi.mock('../terminal-manager-instance', () => ({
  terminalManager: { destroyAll: vi.fn() },
}))

const mockRestartEngineDaemon = vi.fn().mockReturnValue(true)
vi.mock('../engine-bootstrap', () => ({
  restartEngineDaemon: mockRestartEngineDaemon,
}))

const mockReassertPolicy = vi.hoisted(() => vi.fn())
vi.mock('../atv-window-manager', () => ({
  openAtvWindow: vi.fn(),
  reassertAtvActivationPolicy: mockReassertPolicy,
}))

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('window-manager createWindow()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls setAlwaysOnTop with modal-panel, not screen-saver', async () => {
    const { createWindow } = await import('../window-manager')
    createWindow()

    expect(mockSetAlwaysOnTop).toHaveBeenCalled()

    // The level is the second positional argument.
    const levelArg = mockSetAlwaysOnTop.mock.calls[0][1]
    expect(levelArg).toBe('modal-panel')
  })

  it('does NOT use screen-saver level (regression guard)', async () => {
    const { createWindow } = await import('../window-manager')
    createWindow()

    const usedScreenSaver = mockSetAlwaysOnTop.mock.calls.some((args) => args[1] === 'screen-saver')
    expect(usedScreenSaver).toBe(false)
  })

  it('always passes true as the first argument to setAlwaysOnTop', async () => {
    const { createWindow } = await import('../window-manager')
    createWindow()

    const enabledArg = mockSetAlwaysOnTop.mock.calls[0][0]
    expect(enabledArg).toBe(true)
  })

  it('re-asserts the activation policy after setVisibleOnAllWorkspaces (accessory side-effect regression)', async () => {
    // visibleOnFullScreen flips the app to 'accessory' as a macOS/Electron
    // side effect. With the ATV open ('regular' policy) that removed Ion
    // from Cmd-Tab and backgrounded the ATV window on every overlay show.
    const { createWindow, showWindow } = await import('../window-manager')
    createWindow()
    expect(_mockSetVisibleOnAllWorkspaces).toHaveBeenCalled()
    expect(mockReassertPolicy).toHaveBeenCalled()
    expect(
      mockReassertPolicy.mock.invocationCallOrder[mockReassertPolicy.mock.invocationCallOrder.length - 1],
    ).toBeGreaterThan(_mockSetVisibleOnAllWorkspaces.mock.invocationCallOrder[0])

    mockReassertPolicy.mockClear()
    _mockSetVisibleOnAllWorkspaces.mockClear()
    showWindow('test')
    expect(_mockSetVisibleOnAllWorkspaces).toHaveBeenCalled()
    expect(mockReassertPolicy).toHaveBeenCalled()
    expect(
      mockReassertPolicy.mock.invocationCallOrder[0],
    ).toBeGreaterThan(_mockSetVisibleOnAllWorkspaces.mock.invocationCallOrder[0])
  })
})

describe('window-manager createTray()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
