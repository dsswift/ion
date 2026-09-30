import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { WebContents } from 'electron'

const splash = { isDestroyed: () => false, destroy: vi.fn(), webContents: { id: 99 } }
const studioWindow = { webContents: { id: 7 } }
const mockState = { splashWindow: splash as any, mainWindow: null as any, studioWindow: studioWindow as any }

const createTray = vi.fn()
const revealStudioWindow = vi.fn()
const openStudioWindow = vi.fn()
const registerStudioShortcuts = vi.fn()
const broadcast = vi.fn()
const warn = vi.fn()
const log = vi.fn()

vi.stubGlobal('__ION_DESKTOP_VERSION__', '1.83.0-dev.abcdef123456')

vi.mock('electron', () => ({ app: { getVersion: () => '1.2.3', relaunch: vi.fn(), exit: vi.fn(), quit: vi.fn() } }))
vi.mock('../state', () => ({ state: mockState }))
const debug = vi.fn()
vi.mock('../logger', () => ({ log: (...a: unknown[]) => log(...a), warn: (...a: unknown[]) => warn(...a), debug: (...a: unknown[]) => debug(...a) }))
vi.mock('../window-manager', () => ({
  createTray: () => createTray(),
}))
vi.mock('../studio-shortcuts', () => ({ registerStudioShortcuts: (...a: unknown[]) => registerStudioShortcuts(...a) }))
vi.mock('../studio-window-manager', () => ({
  openStudioWindow: (...a: unknown[]) => openStudioWindow(...a),
  revealStudioWindow: (...a: unknown[]) => revealStudioWindow(...a),
}))
const signIn = vi.fn()

// The engine-owned sign-in runs in the Studio server; the coordinator asks
// for it over the wire. `signIn` stands in for the server's flow.
vi.mock('../connections/broker-instance', () => ({
  broker: {
    sendAction: async (_env: string, action: string) => {
      if (action !== 'entra.signIn') throw new Error(`unexpected action ${action}`)
      try {
        return { ok: true, identity: await signIn() }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
  },
}))
vi.mock('../broadcast', () => ({ broadcast: (...a: unknown[]) => broadcast(...a) }))

const studio = studioWindow.webContents as unknown as WebContents

/** The LOCAL server's terminal report, as the studio bridge relays it off the wire. */
function serverReady(c: typeof import('../startup-coordinator'), sequence = 40): boolean {
  return c.relayServerStartupReport('local', { type: 'studio_event', channel: 'startup:progress', payload: { source: 'server', sequence, status: 'Workspace ready', ready: true } })
}

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
  })

  it('reveals Studio and destroys the splash once both the server and the studio report ready', async () => {
    const c = await freshCoordinator()
    expect(serverReady(c)).toBe(true)
    for (let i = 1; i <= 78; i++) {
      c.reportStartup({ source: 'studio', sequence: i, status: `Restoring tab ${i}…` }, studio)
    }
    expect(c.isStartupRevealed()).toBe(false)

    expect(c.reportStartup({ source: 'studio', sequence: 79, status: 'Ion is ready', ready: true }, studio)).toBe(true)

    expect(c.getStartupState().studioReady).toBe(true)
    expect(c.getStartupState().serverReady).toBe(true)
    expect(c.isStartupRevealed()).toBe(true)
    expect(revealStudioWindow).toHaveBeenCalledWith('startup complete')
    expect(registerStudioShortcuts).toHaveBeenCalled()
    expect(createTray).toHaveBeenCalled()
    expect(splash.destroy).toHaveBeenCalled()
  })

  // The renderer's bootstrap finishes seconds before the server has restored
  // every tab. Shipped once the store moved into the server: the splash came
  // down on the renderer's ready alone, over a sidebar that filled in chunk
  // by chunk behind a "Syncing" placeholder for the rest of the restore.
  it('keeps the splash up on the studio ready report until the LOCAL server reports its workspace ready', async () => {
    const c = await freshCoordinator()
    c.relayServerStartupReport('local', { type: 'studio_event', channel: 'startup:progress', payload: { source: 'server', sequence: 3, status: 'Restoring tab 4 of 28…' } })
    expect(c.reportStartup({ source: 'studio', sequence: 1, status: 'Ion Studio is ready', ready: true }, studio)).toBe(true)

    expect(c.getStartupState().studioReady).toBe(true)
    expect(c.getStartupState().serverReady).toBe(false)
    expect(c.isStartupRevealed()).toBe(false)
    expect(revealStudioWindow).not.toHaveBeenCalled()
    expect(splash.destroy).not.toHaveBeenCalled()
    // The splash keeps showing the restore while it waits.
    c.relayServerStartupReport('local', { type: 'studio_event', channel: 'startup:progress', payload: { source: 'server', sequence: 4, status: 'Starting restored sessions 1 of 25…' } })
    expect(c.getStartupState().status).toBe('Starting restored sessions 1 of 25…')
    expect(c.isStartupRevealed()).toBe(false)

    expect(serverReady(c, 5)).toBe(true)
    expect(c.isStartupRevealed()).toBe(true)
    expect(revealStudioWindow).toHaveBeenCalledWith('startup complete')
    expect(splash.destroy).toHaveBeenCalled()
  })

  it('reveals on the studio ready report when the server was ready first, as on a fast restore', async () => {
    const c = await freshCoordinator()
    // A small workspace finishes restoring before the desktop's wire opens;
    // the server replays its terminal report on attach.
    expect(serverReady(c, 2)).toBe(true)
    expect(c.isStartupRevealed()).toBe(false)
    c.reportStartup({ source: 'studio', sequence: 1, status: 'Ion Studio is ready', ready: true }, studio)
    expect(c.isStartupRevealed()).toBe(true)
  })

  // The server child starts before app.whenReady and replays its terminal
  // report the moment the wire opens, so a slow engine bootstrap (a reinstall
  // that copies a new binary and kickstarts the daemon) lets the server's
  // ready land while main is still reporting its own steps. A mid-boot reset
  // of the coordinator once wiped that ready; the server never sends it again
  // without a reconnect, and the splash sat on "Ion Studio is ready" forever.
  it('keeps a server ready that lands before main finishes its own startup steps', async () => {
    const c = await freshCoordinator()
    c.reportStartup({ source: 'main', sequence: 0, status: 'Preparing Ion…' })
    c.reportStartup({ source: 'main', sequence: 1, status: 'Checking system permissions…' })
    expect(serverReady(c, 49)).toBe(true)
    c.reportStartup({ source: 'main', sequence: 2, status: 'Starting Ion engine…' })
    c.reportStartup({ source: 'main', sequence: 3, status: 'Checking identity…' })
    c.reportStartup({ source: 'main', sequence: 4, status: 'Preparing your workspace…' })
    expect(c.getStartupState().serverReady).toBe(true)

    c.reportStartup({ source: 'studio', sequence: 4, status: 'Ion Studio is ready', ready: true }, studio)

    expect(c.isStartupRevealed()).toBe(true)
    expect(splash.destroy).toHaveBeenCalled()
  })

  it('notes a server replay after reveal without counting it as a dropped report', async () => {
    const c = await freshCoordinator()
    serverReady(c, 9)
    c.reportStartup({ source: 'studio', sequence: 1, status: 'Ion Studio is ready', ready: true }, studio)
    expect(c.isStartupRevealed()).toBe(true)
    warn.mockClear()
    // The wire reconnects; the server replays the same terminal report.
    expect(serverReady(c, 9)).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith('startup', 'server startup report after reveal ignored', expect.objectContaining({ sequence: 9, ready: true }))
  })

  it('drops a ready report that trails its own source, and says so in the log', async () => {
    // The shipped wedge: a renderer module's ready report arrived at a
    // sequence behind progress already accepted, and was discarded —
    // splash up forever, product window never shown.
    const c = await freshCoordinator()
    serverReady(c)
    for (let i = 1; i <= 78; i++) {
      c.reportStartup({ source: 'studio', sequence: i, status: `Restoring tab ${i}…` }, studio)
    }

    expect(c.reportStartup({ source: 'studio', sequence: 4, status: 'Ion is ready', ready: true }, studio)).toBe(false)

    expect(c.getStartupState().studioReady).toBe(false)
    expect(c.isStartupRevealed()).toBe(false)
    expect(splash.destroy).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      'startup',
      'startup report dropped: sequence not ahead of source',
      expect.objectContaining({ source: 'studio', report_sequence: 4, last_accepted_sequence: 78, ready: true }),
    )
  })

  it('enters required authentication mode without revealing product UI', async () => {
    const c = await freshCoordinator()
    c.requireStartupAuthentication()

    expect(c.getStartupState()).toMatchObject({
      mode: 'authentication',
      authenticationBusy: false,
      status: 'Sign in to continue',
    })
    expect(c.isStartupRevealed()).toBe(false)
    expect(revealStudioWindow).not.toHaveBeenCalled()
    expect(splash.destroy).not.toHaveBeenCalled()
  })

  it('completes required authentication and returns to loading state', async () => {
    const c = await freshCoordinator()
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

  // The reveal gate refuses while mode is 'authentication'. The ready report
  // can land before signIn() settles -- the main-process wait loop polls the
  // engine every 250ms and proceeds on the engine's view of the grant, which
  // flips the moment the token exchange completes. The splash must not sit on
  // "Signed in. Preparing your workspace…" over a fully booted app forever.
  it('reveals when the surface became ready during the sign-in', async () => {
    const c = await freshCoordinator()
    c.requireStartupAuthentication()

    let release: ((v: { user: string }) => void) | undefined
    signIn.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const pending = c.authenticateStartup()

    // Both surfaces finish booting while the gate is still up.
    serverReady(c)
    c.reportStartup({ source: 'studio', sequence: 1, status: 'Ion is ready', ready: true }, studio)
    expect(c.isStartupRevealed()).toBe(false)

    release?.({ user: 'someone@example.com' })
    await pending

    expect(c.isStartupRevealed()).toBe(true)
    expect(splash.destroy).toHaveBeenCalled()
  })

  // The engine's PKCE flow has no cancel: it holds a loopback listener open
  // and times out after five minutes, and nothing in that window tells the
  // desktop the user gave up. A user who closes the browser tab, or is handed
  // a provider error page, sat on a disabled "Waiting for browser…" button for
  // the full five minutes with quitting the app as the only way out.
  it('cancelling a sign-in attempt restores a usable gate', async () => {
    const c = await freshCoordinator()
    c.requireStartupAuthentication()

    let release: (() => void) | undefined
    signIn.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ user: 'someone@example.com' })
    }))
    const pending = c.authenticateStartup()
    expect(c.getStartupState().authenticationBusy).toBe(true)

    c.cancelStartupAuthentication()

    expect(c.getStartupState()).toMatchObject({
      mode: 'authentication',
      authenticationBusy: false,
      authenticationError: null,
      status: 'Sign in to continue',
    })
    // Still gated: cancelling abandons the attempt, it does not sign anyone in.
    expect(c.isStartupRevealed()).toBe(false)

    release?.()
    await pending
  })

  // A second attempt has to be possible, or the cancel button only changes the
  // label on a dead end.
  it('allows a fresh attempt after a cancel', async () => {
    const c = await freshCoordinator()
    c.requireStartupAuthentication()

    let release: (() => void) | undefined
    signIn.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ user: 'someone@example.com' })
    }))
    const abandoned = c.authenticateStartup()
    c.cancelStartupAuthentication()

    await c.authenticateStartup()

    expect(signIn).toHaveBeenCalledTimes(2)
    expect(c.getStartupState()).toMatchObject({ mode: 'loading', authenticationBusy: false })

    release?.()
    await abandoned
  })

  it('ignores a cancel when no sign-in gate is active', async () => {
    const c = await freshCoordinator()

    c.cancelStartupAuthentication()

    expect(c.getStartupState().mode).not.toBe('authentication')
  })

  it('rejects a report whose sender is not the source window', async () => {
    const c = await freshCoordinator()
    const impostor = { id: 1234 } as unknown as WebContents

    expect(c.reportStartup({ source: 'studio', sequence: 1, status: 'Ion is ready', ready: true }, impostor)).toBe(false)
    expect(c.getStartupState().studioReady).toBe(false)
    expect(c.isStartupRevealed()).toBe(false)
  })
})

describe('server startup reports', () => {
  const frame = (channel: string, payload: unknown) => ({ type: 'studio_event' as const, channel, payload })
  const report = (sequence: number, status: string) => ({ source: 'server', sequence, status })

  // The payload is the bare report object: a one-argument `broadcast()` is
  // condensed to its single value by the server's formatEventPayload. The
  // replay-on-attach used to wrap it in an array, and this test pinned the
  // array -- so the replay passed and every live report was rejected, which
  // is exactly how the splash froze on "Restoring tab 21 of 28" for a whole
  // restoration.
  it('rejects the old array-wrapped shape, which no producer sends any more', async () => {
    const mod = await freshCoordinator()
    expect(mod.relayServerStartupReport('local', frame('startup:progress', [report(0, 'Restoring tab 1 of 12…')]))).toBe(false)
  })

  it('relays the LOCAL server restore progress into the splash without a sender window', async () => {
    const mod = await freshCoordinator()
    expect(mod.relayServerStartupReport('local', frame('startup:progress', report(0, 'Restoring tab 1 of 12…')))).toBe(true)
    expect(mod.getStartupState().status).toBe('Restoring tab 1 of 12…')
    expect(mod.getStartupState().source).toBe('server')
    expect(mod.getStartupState().studioReady).toBe(false)
  })

  it('ignores a remote environment, other channels, and reports claiming another source', async () => {
    const mod = await freshCoordinator()
    expect(mod.relayServerStartupReport('remote-1', frame('startup:progress', report(5, 'Restoring 3 tabs…')))).toBe(false)
    expect(mod.relayServerStartupReport('local', frame('ion:settings-changed', report(5, 'x')))).toBe(false)
    expect(mod.relayServerStartupReport('local', frame('startup:progress', { source: 'studio', sequence: 5, status: 'x', ready: true }))).toBe(false)
    expect(mod.relayServerStartupReport('local', { type: 'studio_welcome' } as never)).toBe(false)
    expect(mod.getStartupState().studioReady).toBe(false)
  })

  it('keeps its own sequence per source, so server and studio never block each other', async () => {
    const mod = await freshCoordinator()
    expect(mod.relayServerStartupReport('local', frame('startup:progress', report(7, 'Loading saved tabs…')))).toBe(true)
    expect(mod.relayServerStartupReport('local', frame('startup:progress', report(7, 'stale')))).toBe(false)
    expect(mod.relayServerStartupReport('local', frame('startup:progress', report(8, 'Restoring 3 tabs…')))).toBe(true)
    expect(mod.getStartupState().status).toBe('Restoring 3 tabs…')
  })
})
