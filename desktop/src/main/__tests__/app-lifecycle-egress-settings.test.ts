/**
 * app-lifecycle-egress-settings.test.ts — pins initEgressFromSettingsConfig().
 *
 * The settings-driven egress path is independent of the engine.json path:
 * the desktop ships every local log source (its own, the engine's, the
 * server's, iOS's and telemetry) to whatever endpoint settings.json names
 * under logging.egressOtel. The engine's own egress is governed by
 * engine.json only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EgressConfig } from '@ion/shared/log-egress'

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports that use them.
// ---------------------------------------------------------------------------

let fakeSettings: Record<string, unknown> = {}

vi.mock('@ion/server/persistence/settings-store', async (importOriginal) => ({ ...(await importOriginal()), ...{
  engineConfigFile: () => '/fake/.ion/engine.json',
  tabsFileForBackend: vi.fn(() => '/fake/.ion/tabs-api.json'),
  sessionChainsFileForBackend: vi.fn(() => '/fake/.ion/session-chains-api.json'),
  sessionLabelsFileForBackend: vi.fn(() => '/fake/.ion/session-labels-api.json'),
  readSettings: vi.fn(() => ({ ...fakeSettings })),
  readEngineConfig: vi.fn(() => ({})),
  writeEngineConfig: vi.fn(),
  readGitWatcherIgnoredDirectories: vi.fn(() => []),
} }))

const configureEgressMock = vi.fn()
const startEgressTailersMock = vi.fn()
const setEgressUserMock = vi.fn()

vi.mock('@ion/shared/log-egress', () => ({
  configureEgress: (...args: unknown[]) => configureEgressMock(...args),
  closeEgress: vi.fn(() => Promise.resolve()),
  setEgressUser: (...args: unknown[]) => setEgressUserMock(...args),
  shipToEgress: vi.fn(),
  shipTailedToEgress: vi.fn(),
}))

vi.mock('@ion/shared/log-egress-tailer', () => ({
  startEgressTailers: (...args: unknown[]) => startEgressTailersMock(...args),
  stopEgressTailers: vi.fn(),
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  flushLogs: vi.fn(),
}))

vi.mock('@ion/server/oauth/entra-flow', () => ({
  getAccessToken: vi.fn(() => Promise.resolve(null)),
  getSignedInIdentity: vi.fn(() => Promise.resolve(null)),
  ensureEntraAuthConfig: vi.fn(),
}))

type BrokerReply = { identity?: { user: string } | null; token?: string | null }
const brokerSendAction = vi.fn(async (_env: string, action: string): Promise<BrokerReply> => {
  if (action === 'entra.identity') return { identity: null }
  if (action === 'entra.accessToken') return { token: null }
  return {}
})
vi.mock('../connections/broker-instance', () => ({ broker: { sendAction: (...args: unknown[]) => brokerSendAction(...(args as [string, string])) } }))

vi.mock('../engine-egress-claim', () => ({
  claimEngineEgressForDesktop: vi.fn(() => false),
}))

// Stub heavy startup dependencies so importing app-lifecycle doesn't explode.
vi.mock('electron', () => ({
  app: {
    whenReady: vi.fn(() => ({ then: vi.fn() })),
    on: vi.fn(),
    getPath: vi.fn(() => '/fake/userData'),
    getVersion: vi.fn(() => '4.5.6'),
    dock: { hide: vi.fn() },
    quit: vi.fn(),
    exit: vi.fn(),
    name: 'Ion',
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  globalShortcut: { register: vi.fn(() => true), unregisterAll: vi.fn() },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  screen: { on: vi.fn() },
  Tray: vi.fn(() => ({ destroy: vi.fn(), setContextMenu: vi.fn(), setToolTip: vi.fn(), on: vi.fn() })),
  nativeImage: { createFromPath: vi.fn(() => ({})) },
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

vi.mock('@ion/server/state', async (importOriginal) => ({ ...(await importOriginal()), ...{
  state: { mainWindow: null, tray: null, remoteTransport: null, forceQuit: false },
  SPACES_DEBUG: false,
  sessionPlane: { shutdown: vi.fn(), drain: vi.fn(() => Promise.resolve()) },
  engineBridge: { connect: vi.fn(() => Promise.resolve()), shutdownAndWait: vi.fn(() => Promise.resolve()) },
  fileWatchers: new Map(),
  bashProcesses: new Set(),
} }))

vi.mock('@ion/server/terminal/terminal-manager-instance', async (importOriginal) => ({ ...(await importOriginal()), ...{ terminalManager: { destroyAll: vi.fn() } } }))
vi.mock('@ion/server/remote/snapshot-polling', async (importOriginal) => ({ ...(await importOriginal()), ...{ stopTabSnapshotPolling: vi.fn() } }))
vi.mock('../window-manager', () => ({
  createTray: vi.fn(),
  createWindow: vi.fn(),
  installContentSecurityPolicy: vi.fn(),
  snapshotWindowState: vi.fn(),
  showWindow: vi.fn(),
  toggleWindow: vi.fn(),
}))
vi.mock('../permissions-preflight', () => ({ requestPermissions: vi.fn(() => Promise.resolve()) }))
vi.mock('@ion/server/git/git-runner', () => ({ cleanOrphanedWorktrees: vi.fn(() => Promise.resolve()) }))
vi.mock('@ion/server/git/focus-state', async (importOriginal) => ({ ...(await importOriginal()), ...{ focusState: { setFocused: vi.fn() } } }))
vi.mock('../conversation-cleanup', () => ({ startConversationCleanup: vi.fn() }))
vi.mock('@ion/server/engine/engine-bootstrap', async (importOriginal) => ({ ...(await importOriginal()), ...{ ensureEngineDaemon: vi.fn(() => Promise.resolve()) } }))
vi.mock('@ion/server/watchdog', () => ({ startWatchdog: vi.fn(), stopWatchdog: vi.fn() }))
vi.mock('@ion/server/utils/atomicWrite', async (importOriginal) => ({ ...(await importOriginal()), ...{ atomicWriteFileSync: vi.fn() } }))

// ---------------------------------------------------------------------------
// Import the module under test AFTER all mocks are established.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The module under test, imported AFTER the mocks above are established.
//
// This file used to re-implement initEgressFromSettingsConfig's body and
// assert on that copy, under a comment claiming the function was not
// exported. It is exported, and a test that runs its own copy of the logic
// cannot fail when the real one changes -- which is exactly what happened
// when `server` joined the shipped sources.
// ---------------------------------------------------------------------------

import { readSettings } from '@ion/server/persistence/settings-store'
import { getSignedInIdentity } from '@ion/server/oauth/entra-flow'
import { initEgressFromSettingsConfig } from '../app-lifecycle-egress'

/** Run the real function and let its fire-and-forget identity read settle. */
async function runInitEgressFromSettingsConfig(): Promise<void> {
  initEgressFromSettingsConfig()
  await Promise.resolve()
  await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  fakeSettings = {}
  vi.clearAllMocks()
  ;(readSettings as ReturnType<typeof vi.fn>).mockImplementation(() => ({ ...fakeSettings }))
  // clearAllMocks clears recorded calls, not implementations: without this a
  // signed-in case leaks its identity into the next test.
  brokerSendAction.mockImplementation(async (_env: string, action: string) =>
    action === 'entra.identity' ? { identity: null } : { token: null },
  )
})

describe('initEgressFromSettingsConfig', () => {
  it('configures egress and tails every local log file when settings has otel targets', async () => {
    fakeSettings = {
      logging: {
        egressTargets: ['otel'],
        egressOtel: { endpoint: 'https://telemetry.example.com' },
      },
    }

    await runInitEgressFromSettingsConfig()

    expect(configureEgressMock).toHaveBeenCalledOnce()
    const [cfg, , opts] = configureEgressMock.mock.calls[0] as [EgressConfig, unknown, { shipOwnRecords: boolean; version?: string }]
    expect(cfg.egressTargets).toEqual(['otel'])
    expect(cfg.egressOtel).toEqual({ endpoint: 'https://telemetry.example.com' })
    expect(opts.shipOwnRecords).toBe(true)
    // The desktop's build version becomes the OTLP service.version of what it ships.
    expect(opts.version).toBe('4.5.6')

    expect(startEgressTailersMock).toHaveBeenCalledOnce()
    expect(startEgressTailersMock).toHaveBeenCalledWith(['desktop', 'engine', 'server', 'ios', 'telemetry'])
  })

  it('passes http target config through correctly', async () => {
    fakeSettings = {
      logging: {
        egressTargets: ['http'],
        egressEndpoint: 'https://sink.example.com/logs',
        egressHeaders: { Authorization: 'Bearer static-token' },
        egressBatchSize: 50,
        egressFlushIntervalMs: 3000,
      },
    }

    await runInitEgressFromSettingsConfig()

    expect(configureEgressMock).toHaveBeenCalledOnce()
    const [cfg] = configureEgressMock.mock.calls[0] as [EgressConfig]
    expect(cfg.egressTargets).toEqual(['http'])
    expect(cfg.egressEndpoint).toBe('https://sink.example.com/logs')
    expect(cfg.egressHeaders).toEqual({ Authorization: 'Bearer static-token' })
    expect(cfg.egressBatchSize).toBe(50)
    expect(cfg.egressFlushIntervalMs).toBe(3000)
    expect(cfg.egressOtel).toBeUndefined()
  })

  it('is a no-op when logging block is absent from settings', async () => {
    fakeSettings = { themeMode: 'dark', preferredModel: 'claude-opus-4-6' }

    await runInitEgressFromSettingsConfig()

    expect(configureEgressMock).not.toHaveBeenCalled()
    expect(startEgressTailersMock).not.toHaveBeenCalled()
  })

  it('is a no-op when egressTargets is an empty array', async () => {
    fakeSettings = { logging: { egressTargets: [] } }

    await runInitEgressFromSettingsConfig()

    expect(configureEgressMock).not.toHaveBeenCalled()
    expect(startEgressTailersMock).not.toHaveBeenCalled()
  })

  it('is a no-op when settings.json is empty', async () => {
    fakeSettings = {}

    await runInitEgressFromSettingsConfig()

    expect(configureEgressMock).not.toHaveBeenCalled()
    expect(startEgressTailersMock).not.toHaveBeenCalled()
  })

  it('sets user attribution when signed in', async () => {
    fakeSettings = {
      logging: {
        egressTargets: ['otel'],
        egressOtel: { endpoint: 'https://sink.example.com' },
      },
    }
    brokerSendAction.mockImplementation(async (_env: string, action: string) =>
      action === 'entra.identity' ? { identity: { user: 'josh@example.com' } } : { token: null },
    )

    await runInitEgressFromSettingsConfig()
    // Wait for the promise chain to resolve.
    await new Promise((r) => setTimeout(r, 0))

    expect(setEgressUserMock).toHaveBeenCalledWith('josh@example.com')
  })

  it('does not set user attribution when not signed in', async () => {
    fakeSettings = {
      logging: {
        egressTargets: ['otel'],
        egressOtel: { endpoint: 'https://sink.example.com' },
      },
    }
    ;(getSignedInIdentity as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)

    await runInitEgressFromSettingsConfig()
    await new Promise((r) => setTimeout(r, 0))

    expect(setEgressUserMock).not.toHaveBeenCalled()
  })
})
