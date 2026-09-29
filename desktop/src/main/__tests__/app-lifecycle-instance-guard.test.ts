/**
 * app-lifecycle-instance-guard.test.ts — pins the already-running refusal path.
 *
 * The guard runs before app.whenReady() resolves, and Electron throws
 * "dialog module can only be used after app is ready" on any dialog call made
 * that early. The refusal must therefore be decided synchronously but told
 * only once the app is ready, and the process must still exit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The desktop version is a build-time constant (electron.vite.config.ts);
// the local server reads it as the module loads.
vi.hoisted(() => { (globalThis as { __ION_DESKTOP_VERSION__?: string }).__ION_DESKTOP_VERSION__ = '1.0.0-test' })

let readyResolve: () => void
let readyPromise: Promise<void>

const showMessageBoxSync = vi.fn()
const appExit = vi.fn()
const appQuit = vi.fn()

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/fake/app',
    whenReady: vi.fn(() => readyPromise),
    on: vi.fn(),
    getPath: vi.fn(() => '/fake/userData'),
    dock: { hide: vi.fn() },
    quit: () => appQuit(),
    exit: (code: number) => appExit(code),
    name: 'Ion',
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showMessageBoxSync: (...args: unknown[]) => showMessageBoxSync(...args) },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  powerMonitor: { on: vi.fn() },
  screen: { on: vi.fn() },
}))

const detectRunningIonMock = vi.fn()
vi.mock('../instance-guard', () => ({
  detectRunningIon: () => detectRunningIonMock(),
}))

const claimSingleInstanceMock = vi.fn(() => true)
vi.mock('../deeplink-setup', () => ({
  claimSingleInstance: () => claimSingleInstanceMock(),
  setupDeepLinks: vi.fn(),
  consumeLaunchUrl: vi.fn(() => null),
  bindDeepLinkRenderer: vi.fn(),
}))

vi.mock('../logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  flushLogs: vi.fn(), initLoggerMachineIdentity: vi.fn(),
}))
vi.mock('../log-level', () => ({ applyConfiguredLogLevel: vi.fn() }))
vi.mock('../chart-restore', () => ({ hydrateChartCatalogFromDisk: vi.fn() }))
vi.mock('@ion/server/machine-identity', () => ({ loadMachineIdentity: vi.fn(() => Promise.resolve({})) }))
vi.mock('../utils/temp-dir', () => ({ pruneOperationDirs: vi.fn() }))
vi.mock('@ion/server/state', async (importOriginal) => ({ ...(await importOriginal()), ...{
  state: { mainWindow: null, tray: null, remoteTransport: null, forceQuit: false },
  SPACES_DEBUG: false,
  engineBridge: { connect: vi.fn(), shutdownAndWait: vi.fn() },
  enterprisePolicyCache: {},
} }))
vi.mock('../window-manager', () => ({
  createWindow: vi.fn(), installContentSecurityPolicy: vi.fn(),
  snapshotWindowState: vi.fn(), showWindow: vi.fn(),
}))
vi.mock('../studio-window-manager', () => ({ focusStudioWindow: vi.fn(), isStudioWindowOpen: vi.fn(() => false) }))
vi.mock('../worktree-overlap-window', () => ({ focusWorktreeOverlapWindow: vi.fn() }))
vi.mock('../studio-terminal-persistence', () => ({ restoreStudioTerminals: vi.fn() }))
vi.mock('../permissions-preflight', () => ({ requestPermissions: vi.fn(() => Promise.resolve()) }))
vi.mock('../deeplink/dispatch', () => ({ markDeepLinksReady: vi.fn() }))
vi.mock('@ion/server/git/git-runner', () => ({ cleanOrphanedWorktrees: vi.fn(() => Promise.resolve()) }))
vi.mock('../git/focus-state', () => ({ focusState: { setFocused: vi.fn() } }))
vi.mock('../conversation-cleanup', () => ({ startConversationCleanup: vi.fn() }))
vi.mock('../worktree/freshness-poll', () => ({ startWorktreeFreshnessPoll: vi.fn() }))
vi.mock('../settings-store', () => ({
  tabsFile: () => '/fake/tabs.json',
  sessionChainsFile: () => '/fake/chains.json',
  sessionLabelsFile: () => '/fake/labels.json',
  legacyTabsFileForBackend: vi.fn(() => '/fake/tabs-api.json'),
  legacySessionChainsFileForBackend: vi.fn(() => '/fake/chains-api.json'),
  legacySessionLabelsFileForBackend: vi.fn(() => '/fake/labels-api.json'),
  engineConfigFile: () => '/fake/engine.json',
  ensureHybridBackendConfig: vi.fn(() => false),
  readSettings: vi.fn(() => ({})),
}))
vi.mock('../engine-bootstrap', () => ({ ensureEngineDaemon: vi.fn(() => Promise.resolve()), restartEngineDaemon: vi.fn() }))
vi.mock('../engine-egress-claim', () => ({ claimEngineEgressForDesktop: vi.fn(() => false) }))
vi.mock('@ion/shared/log-egress', () => ({ configureEgress: vi.fn(), setEgressUser: vi.fn() }))
vi.mock('@ion/shared/log-egress-tailer', () => ({ startEgressTailers: vi.fn() }))
vi.mock('@ion/server/oauth/entra-flow', () => ({
  getAccessToken: vi.fn(() => Promise.resolve(null)),
  getOperatorIdentityState: vi.fn(() => ({})),
  getSignedInIdentity: vi.fn(() => Promise.resolve(null)),
  ensureEntraAuthConfig: vi.fn(() => false),
}))
vi.mock('../engine-bridge-fs', () => ({
  getEnterprisePolicy: vi.fn(() => null),
  getEnterprisePolicyNewConversationDefaults: vi.fn(() => null),
}))
vi.mock('../updater', () => ({ initAutoUpdater: vi.fn() }))
vi.mock('@ion/server/watchdog', () => ({ startWatchdog: vi.fn(), setWatchdogSuspended: vi.fn() }))
vi.mock('../remote/transport-wake', () => ({ renewRelaysAfterWake: vi.fn() }))
vi.mock('../startup-window', () => ({ createStartupWindow: vi.fn() }))
vi.mock('../app-lifecycle-quit', () => ({ installQuitHandlers: vi.fn() }))
vi.mock('../startup-coordinator', () => ({
  failStartup: vi.fn(), isStartupRevealed: vi.fn(() => false), reportStartup: vi.fn(),
  requireStartupAuthentication: vi.fn(() => Promise.resolve(true)), startStartup: vi.fn(),
}))

import { setupAppLifecycle } from '../app-lifecycle'

describe('setupAppLifecycle — a current Ion is already running', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readyPromise = new Promise<void>((resolve) => { readyResolve = resolve })
    claimSingleInstanceMock.mockReturnValue(false)
    detectRunningIonMock.mockReturnValue({ pid: 4242, source: 'pid_file' })
  })

  it('hands the launch to it: no dialog, no older-copy check, and this process quits', async () => {
    setupAppLifecycle()
    readyResolve()
    await readyPromise
    await Promise.resolve()

    expect(appQuit).toHaveBeenCalled()
    expect(showMessageBoxSync).not.toHaveBeenCalled()
    expect(detectRunningIonMock).not.toHaveBeenCalled()
  })
})

describe('setupAppLifecycle — an Ion older than the single-instance lock is running', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readyPromise = new Promise<void>((resolve) => { readyResolve = resolve })
    claimSingleInstanceMock.mockReturnValue(true)
    detectRunningIonMock.mockReturnValue({ pid: 4242, source: 'pid_file' })
  })

  it('does not touch the dialog module before the app is ready', () => {
    setupAppLifecycle()

    expect(showMessageBoxSync).not.toHaveBeenCalled()
    expect(appExit).not.toHaveBeenCalled()
    // The lock came first; the older copy cannot receive this launch.
    expect(claimSingleInstanceMock).toHaveBeenCalled()
  })

  it('shows the notice and exits once the app becomes ready', async () => {
    setupAppLifecycle()
    readyResolve()
    await readyPromise
    await Promise.resolve()

    expect(showMessageBoxSync).toHaveBeenCalledTimes(1)
    expect(showMessageBoxSync.mock.calls[0][0]).toMatchObject({
      title: 'Ion is already running',
    })
    expect(appExit).toHaveBeenCalledWith(0)
  })
})
