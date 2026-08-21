import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { SurfacePlan } from '../surface-launch'

const splash = { isDestroyed: () => false, destroy: vi.fn(), webContents: { id: 99 } }
const mainWindow = { webContents: { id: 7 } }
const mockState = { splashWindow: splash as any, mainWindow: mainWindow as any, studioWindow: null as any }

const showWindow = vi.fn()
const createTray = vi.fn()
const revealStudioWindow = vi.fn()
const registerActiveUiShortcuts = vi.fn()
const broadcast = vi.fn()
const warn = vi.fn()
const log = vi.fn()

vi.stubGlobal('__ION_DESKTOP_VERSION__', '1.83.0-dev.abcdef123456')

vi.mock('electron', () => ({ app: { getVersion: () => '1.2.3', relaunch: vi.fn(), exit: vi.fn(), quit: vi.fn() } }))
vi.mock('../state', () => ({ state: mockState }))
vi.mock('../logger', () => ({ log: (...a: unknown[]) => log(...a), warn: (...a: unknown[]) => warn(...a) }))
vi.mock('../startup-window', () => ({ createStartupWindow: vi.fn() }))
vi.mock('../window-manager', () => ({
  showWindow: (...a: unknown[]) => showWindow(...a),
  createTray: () => createTray(),
}))
vi.mock('../active-ui', () => ({ registerActiveUiShortcuts: (...a: unknown[]) => registerActiveUiShortcuts(...a) }))
vi.mock('../studio-window-manager', () => ({
  openStudioWindow: vi.fn(),
  revealStudioWindow: (...a: unknown[]) => revealStudioWindow(...a),
}))
const signIn = vi.fn()

vi.mock('../oauth/entra-auth', () => ({ signIn: (...args: unknown[]) => signIn(...args) }))
vi.mock('../broadcast', () => ({ broadcast: (...a: unknown[]) => broadcast(...a) }))

const overlayPlan = {
  activeUi: 'overlay',
  showOverlayOnLaunch: true,
  openStudioOnLaunch: false,
  studioEnabled: false,
  overlayEnabled: true,
  studioShortcut: '',
} as unknown as SurfacePlan

const owner = mainWindow.webContents as unknown as WebContents

async function freshCoordinator(): Promise<typeof import('../startup-coordinator')> {
  vi.resetModules()
  return import('../startup-coordinator')
}

beforeEach(() => {
  vi.clearAllMocks()
  signIn.mockResolvedValue({ user: 'user@example.com' })
  mockState.splashWindow = splash as any
})

describe('startup coordinator', () => {
  it('publishes the version in the first startup state', async () => {
    const c = await freshCoordinator()
    expect(c.getStartupState().appVersion).toBe('1.83.0-dev.abcdef123456')
    c.startStartup(overlayPlan)
    expect(c.getStartupState().appVersion).toBe('1.83.0-dev.abcdef123456')
  })

  it('reveals the target and destroys the splash on the owner ready report', async () => {
    const c = await freshCoordinator()
    c.startStartup(overlayPlan)
    for (let i = 1; i <= 78; i++) {
      c.reportStartup({ source: 'owner', sequence: i, status: `Restoring tab ${i}…` }, owner)
    }
    expect(c.isStartupRevealed()).toBe(false)

    expect(c.reportStartup({ source: 'owner', sequence: 79, status: 'Ion is ready', ready: true }, owner)).toBe(true)

    expect(c.getStartupState().ownerReady).toBe(true)
    expect(c.isStartupRevealed()).toBe(true)
    expect(showWindow).toHaveBeenCalledWith('startup complete')
    expect(createTray).toHaveBeenCalled()
    expect(splash.destroy).toHaveBeenCalled()
  })

  it('drops a ready report that trails its own source, and says so in the log', async () => {
    // The shipped wedge: two renderer modules reported as `owner` with private
    // counters, so the ready report arrived at sequence 4 behind progress at
    // 78 and was discarded — splash up forever, product window never shown.
    const c = await freshCoordinator()
    c.startStartup(overlayPlan)
    for (let i = 1; i <= 78; i++) {
      c.reportStartup({ source: 'owner', sequence: i, status: `Restoring tab ${i}…` }, owner)
    }

    expect(c.reportStartup({ source: 'owner', sequence: 4, status: 'Ion is ready', ready: true }, owner)).toBe(false)

    expect(c.getStartupState().ownerReady).toBe(false)
    expect(c.isStartupRevealed()).toBe(false)
    expect(splash.destroy).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      'startup',
      'startup report dropped: sequence not ahead of source',
      expect.objectContaining({ source: 'owner', report_sequence: 4, last_accepted_sequence: 78, ready: true }),
    )
  })

  it('enters required authentication mode without revealing product UI', async () => {
    const c = await freshCoordinator()
    c.startStartup(overlayPlan)
    c.requireStartupAuthentication()

    expect(c.getStartupState()).toMatchObject({
      mode: 'authentication',
      authenticationBusy: false,
      status: 'Sign in to continue',
    })
    expect(c.isStartupRevealed()).toBe(false)
    expect(showWindow).not.toHaveBeenCalled()
    expect(splash.destroy).not.toHaveBeenCalled()
  })

  it('completes required authentication and returns to loading state', async () => {
    const c = await freshCoordinator()
    c.startStartup(overlayPlan)
    c.requireStartupAuthentication()

    await c.authenticateStartup()

    expect(signIn).toHaveBeenCalledOnce()
    expect(c.getStartupState()).toMatchObject({
      mode: 'loading',
      authenticationBusy: false,
      authenticationError: null,
      status: 'Signed in. Preparing your workspace…',
    })
  })

  it('rejects a report whose sender is not the source window', async () => {
    const c = await freshCoordinator()
    c.startStartup(overlayPlan)
    const impostor = { id: 1234 } as unknown as WebContents

    expect(c.reportStartup({ source: 'owner', sequence: 1, status: 'Ion is ready', ready: true }, impostor)).toBe(false)
    expect(c.getStartupState().ownerReady).toBe(false)
    expect(c.isStartupRevealed()).toBe(false)
  })
})
