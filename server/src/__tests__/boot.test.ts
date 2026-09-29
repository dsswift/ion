import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir, homedir, userInfo } from 'os'
import { join } from 'path'
import { createServer } from 'net'

/**
 * Boot-order, corrupt-refusal, server-id-mint, and backfill regression pins
 * (manifest spec 06 Phase 4 / Acceptance Criteria).
 *
 * The engine bridge is mocked -- no real engine socket exists in a test temp
 * dir -- following the `vi.mock('./state', ...)` pattern already used by
 * `engine/event-wiring-resources-subscribe.test.ts`.
 */
const bridge = vi.hoisted(() => ({
  connect: vi.fn(() => Promise.resolve()),
  connected: true,
  request: vi.fn(() => Promise.resolve({ ok: true, data: { home: '/tmp', username: 'test', hostname: 'test-host', os: 'darwin', pathSep: '/' } })),
  on: vi.fn(),
}))
vi.mock('../state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state')>()
  return { ...actual, engineBridge: bridge }
})
// `engine-bridge-fs` sits inside the state -> control-plane -> engine-bridge-fs
// -> state import cycle, so it resolves the REAL bridge while the state
// mock's factory is still loading the original module; its reads would wait
// on a socket that does not exist and the readiness chain after
// `connect()` would never run. Its engine reads are mocked at the module
// seam instead (the same pattern `command-senders.test.ts` uses).
vi.mock('../engine/engine-bridge-fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/engine-bridge-fs')>()),
  getEngineHostInfo: vi.fn(async () => ({ ok: true, data: { version: '9.9.9', home: '/tmp', username: 'test', hostname: 'test-host', os: 'darwin', pathSep: '/' } })),
  getEnterprisePolicy: vi.fn(async () => null),
  getEnterprisePolicyNewConversationDefaults: vi.fn(async () => null),
}))
// The store-driven snapshot feed and the stall watchdog are started by
// main() and nowhere else; each is mocked so a boot in a temp dir never
// spawns a worker.
const owned = vi.hoisted(() => ({
  startStructuralSnapshotFeed: vi.fn(() => () => {}),
  startWatchdog: vi.fn(),
}))
vi.mock('../remote/structural-poll', () => ({ startStructuralSnapshotFeed: owned.startStructuralSnapshotFeed }))
vi.mock('../watchdog', async (importOriginal) => ({ ...(await importOriginal<typeof import('../watchdog')>()), startWatchdog: owned.startWatchdog }))

import { main, _setExitProcessForTest } from '../main'
import { sessionPlane } from '../state'
import { loadStateFiles, StateFileCorrupt } from '../persistence/state-files'
import { runPrincipalBackfill } from '../persistence/principal-backfill'
import { checkEngineVersion } from '../engine/version-check'
import { localPrincipal } from '../identity/local-principal'
import { dataDir } from '../paths'
import type { HealthHandle } from '../http/health'

let tmp: string
let originalIonDataDir: string | undefined
const openHandles: HealthHandle[] = []

beforeEach(() => {
  originalIonDataDir = process.env.ION_DATA_DIR
  tmp = mkdtempSync(join(tmpdir(), 'ion-server-test-'))
  process.env.ION_DATA_DIR = tmp
  bridge.connect.mockClear().mockImplementation(() => Promise.resolve())
  bridge.connected = true
  bridge.request.mockClear().mockImplementation(() =>
    Promise.resolve({ ok: true, data: { home: '/tmp', username: 'test', hostname: 'test-host', os: 'darwin', pathSep: '/' } }),
  )
  bridge.on.mockClear()
})

afterEach(async () => {
  for (const handle of openHandles.splice(0)) {
    await handle.close()
  }
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(tmp, { recursive: true, force: true })
})

/** Ephemeral port (0 = OS-assigned) so repeated `main()` calls across tests never collide on 7331. */
function writeEphemeralServerConfig(dir: string): void {
  writeFileSync(join(dir, 'server.json'), JSON.stringify({ listen: { tcp: { port: 0 } } }))
}

describe('main() boot order', () => {
  it('mints a server-id file when absent', async () => {
    writeEphemeralServerConfig(tmp)
    const health = await main()
    openHandles.push(health)

    const idPath = join(tmp, 'server-id')
    expect(existsSync(idPath)).toBe(true)
    const id = readFileSync(idPath, 'utf-8').trim()
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('starts the snapshot feed and the watchdog: the server owns them, not the desktop', async () => {
    writeEphemeralServerConfig(tmp)
    const health = await main()
    openHandles.push(health)
    expect(owned.startStructuralSnapshotFeed).toHaveBeenCalled()
    expect(owned.startWatchdog).toHaveBeenCalled()
  })

  it('answers the engine tool gate itself: the responder and Guided Questions both listen on the bridge', async () => {
    writeEphemeralServerConfig(tmp)
    const health = await main()
    openHandles.push(health)
    // Both wire an 'event' listener on the engine bridge at boot; a desktop
    // no longer answers gates, so a missing listener here means no client
    // tool ever runs.
    const eventListeners = bridge.on.mock.calls.filter(([name]) => name === 'event')
    expect(eventListeners.length).toBeGreaterThanOrEqual(2)
  })

  it('reuses an existing server-id file rather than minting a new one', async () => {
    writeEphemeralServerConfig(tmp)
    writeFileSync(join(tmp, 'server-id'), 'existing-id-123\n')
    const health = await main()
    openHandles.push(health)

    expect(readFileSync(join(tmp, 'server-id'), 'utf-8').trim()).toBe('existing-id-123')
  })

  it('wires sessionPlane so an engine_dead-triggered error event does not crash the process', async () => {
    // Regression pin for a real production crash: wireSessionPlaneEvents()
    // (which attaches sessionPlane's 'error' listener) was only ever called
    // from Electron's main/index.ts, never from this standalone server's own
    // boot -- so any EngineControlPlane emit('error', ...), e.g. from
    // handleDeadEvent when an engine process exits non-zero during boot
    // restoration, threw as an unhandled Node EventEmitter error and killed
    // the whole process. Without the fix, this test's emit() call below
    // throws synchronously and the test fails with the exact same
    // ERR_UNHANDLED_ERROR seen in production.
    writeEphemeralServerConfig(tmp)
    const health = await main()
    openHandles.push(health)

    expect(() => {
      sessionPlane.emit('error', 'regression-test-tab', {
        message: 'Engine process exited with code 1',
        stderrTail: [],
        exitCode: 1,
        elapsedMs: 0,
        toolCallCount: 0,
        sawPermissionRequest: false,
      })
    }).not.toThrow()
  })

  it('refuses to run when another server already owns the local studio socket', async () => {
    // The orphan case: a previous desktop's server child was never stopped
    // and still owns studio.sock. A second server must exit rather than run
    // half-bound beside it, adopting the same tabs against the engine.
    writeEphemeralServerConfig(tmp)
    const owner = createServer()
    await new Promise<void>((resolve) => owner.listen(join(tmp, 'studio.sock'), () => resolve()))
    const exits: number[] = []
    _setExitProcessForTest((code) => { exits.push(code) })
    try {
      const health = await main()
      openHandles.push(health)
      // The probe is asynchronous; give it a tick to connect and report.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(exits).toEqual([2])
    } finally {
      _setExitProcessForTest(null)
      await new Promise<void>((resolve) => owner.close(() => resolve()))
    }
  })

  it('corrupt tabs.json refuses to boot the store/engine wiring and reports state_file_corrupt', async () => {
    writeEphemeralServerConfig(tmp)
    writeFileSync(join(tmp, 'tabs.json'), '{')

    const health = await main()
    openHandles.push(health)

    expect(health.getReadiness()).toEqual({
      ready: false,
      reason: 'state_file_corrupt',
      detail: expect.stringContaining('tabs.json'),
    })
    // The store/engine wiring never ran: no server-id was minted, since that
    // step comes after the state-files gate in boot order.
    expect(existsSync(join(tmp, 'server-id'))).toBe(false)
    expect(bridge.connect).not.toHaveBeenCalled()
  })
})

describe('loadStateFiles', () => {
  it('throws StateFileCorrupt naming the file for invalid JSON', () => {
    writeFileSync(join(tmp, 'settings.json'), '{ not json')
    expect(() => loadStateFiles(tmp)).toThrowError(StateFileCorrupt)
    let caught: unknown
    try {
      loadStateFiles(tmp)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(StateFileCorrupt)
    expect((caught as StateFileCorrupt).filename).toBe('settings.json')
  })

  it('treats a missing file as fine', () => {
    const files = loadStateFiles(tmp)
    expect(files['tabs.json'].present).toBe(false)
  })
})

describe('runPrincipalBackfill', () => {
  it('stamps every unowned tab with the local principal subject and keeps a verified backup', async () => {
    const tabs = [
      { id: 't1', conversationId: null, title: 'a', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [] },
      { id: 't2', conversationId: null, title: 'b', customTitle: null, workingDirectory: '/b', hasChosenDirectory: true, additionalDirs: [] },
      { id: 't3', conversationId: null, title: 'c', customTitle: null, workingDirectory: '/c', hasChosenDirectory: true, additionalDirs: [] },
    ]
    writeFileSync(join(tmp, 'tabs.json'), JSON.stringify({ activeSessionId: null, tabs }))

    const principal = localPrincipal()
    await runPrincipalBackfill(tmp, principal)

    const after = JSON.parse(readFileSync(join(tmp, 'tabs.json'), 'utf-8'))
    expect(after.tabs).toHaveLength(3)
    for (const tab of after.tabs) {
      expect(tab.principalSubject).toBe(`local:${userInfo().username}`)
    }

    const backupPath = join(tmp, 'tabs.json.pre-principal.bak')
    expect(existsSync(backupPath)).toBe(true)
    const backup = JSON.parse(readFileSync(backupPath, 'utf-8'))
    expect(backup.tabs).toHaveLength(3)
  })

  it('is a no-op on a second call once the marker file exists', async () => {
    writeFileSync(join(tmp, 'tabs.json'), JSON.stringify({
      activeSessionId: null,
      tabs: [{ id: 't1', conversationId: null, title: 'a', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [] }],
    }))
    const principal = localPrincipal()
    await runPrincipalBackfill(tmp, principal)
    rmSync(join(tmp, 'tabs.json.pre-principal.bak'))

    // Second call: marker now present, so no new backup should appear even
    // though a fresh tab file is missing its stamp.
    writeFileSync(join(tmp, 'tabs.json'), JSON.stringify({
      activeSessionId: null,
      tabs: [{ id: 't2', conversationId: null, title: 'b', customTitle: null, workingDirectory: '/b', hasChosenDirectory: true, additionalDirs: [] }],
    }))
    await runPrincipalBackfill(tmp, principal)
    expect(existsSync(join(tmp, 'tabs.json.pre-principal.bak'))).toBe(false)
  })
})

describe('checkEngineVersion', () => {
  it('passes when the engine version meets minVersion', () => {
    expect(checkEngineVersion('1.2.3', '1.0.0')).toEqual({ ok: true, version: '1.2.3', minVersion: '1.0.0' })
  })

  it('reports engine_incompatible when the engine version is below minVersion', () => {
    expect(checkEngineVersion('0.9.0', '1.0.0')).toEqual({
      ok: false,
      version: '0.9.0',
      minVersion: '1.0.0',
      reason: 'engine_incompatible',
    })
  })

  it('passes against the manifest C5 default minVersion of 0.0.0', () => {
    expect(checkEngineVersion('0.0.1', '0.0.0').ok).toBe(true)
  })
})

describe('dataDir backward compatibility', () => {
  it('resolves to ~/.ion when ION_DATA_DIR is unset', () => {
    delete process.env.ION_DATA_DIR
    expect(dataDir()).toBe(join(homedir(), '.ion'))
  })

  it('resolves to ION_DATA_DIR verbatim when set', () => {
    process.env.ION_DATA_DIR = tmp
    expect(dataDir()).toBe(tmp)
  })
})
