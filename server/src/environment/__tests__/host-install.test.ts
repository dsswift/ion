/** The host installs on itself: a bundle runs its own command, a desktop-run server asks its desktop, anything else refuses and says why. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
const proc = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref: vi.fn(), pid: 4242 })),
  spawnSync: vi.fn(() => ({ status: 0 })),
}))
vi.mock('child_process', () => proc)
const fsState = vi.hoisted(() => ({ existing: new Set<string>() }))
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()), existsSync: (p: string) => fsState.existing.has(p) }))
const host = vi.hoisted(() => ({ bundleRoot: null as string | null, app: null as { name: 'desktop'; version: string } | null, connections: [] as unknown[] }))
vi.mock('../host-info', () => ({ studioBundleRoot: () => host.bundleRoot, serverInfo: (serverVersion: string) => ({ serverVersion }) }))
vi.mock('../../compat/runtime', () => ({ hostApp: () => host.app }))
vi.mock('../../paths', () => ({ dataDir: () => '/data' }))
vi.mock('../../protocol/connection', () => ({ connectionRegistry: { all: () => host.connections } }))
vi.mock('../../protocol/hello', () => ({ connectionOnHost: (c: { transport: string }) => c.transport === 'local' }))
const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }))
vi.mock('../../broadcast', () => ({ broadcast }))

import { _resetSudoProbeForTest, hostInstallAvailability, requestHostInstall, serverInfoWithInstall } from '../host-install'

function connection(over: Record<string, unknown> = {}): { send: ReturnType<typeof vi.fn> } & Record<string, unknown> {
  return { id: 'c', isClosed: false, transport: 'local', connectedAt: 1, hasCapability: (c: string) => c === 'host-install', send: vi.fn(), ...over }
}
const lastProgress = (): Record<string, unknown> => broadcast.mock.calls.at(-1)?.[1] as Record<string, unknown>

beforeEach(() => {
  proc.spawn.mockClear()
  proc.spawnSync.mockReset().mockReturnValue({ status: 0 })
  _resetSudoProbeForTest()
  broadcast.mockClear()
  fsState.existing = new Set()
  host.bundleRoot = null
  host.app = null
  host.connections = []
})

describe('a Studio Server bundle', () => {
  beforeEach(() => {
    host.bundleRoot = '/data/studio-server'
    fsState.existing.add('/data/studio-server/current/bin/ion')
  })

  it('runs its own studio command, detached, for a restart, a release, and a sent build', () => {
    expect(requestHostInstall({ kind: 'restart' })).toEqual({ ok: true, value: { scheduled: true, by: 'bundle' } })
    requestHostInstall({ kind: 'release' })
    requestHostInstall({ kind: 'release', version: '1.2.3' })
    requestHostInstall({ kind: 'artifact', path: '/data/host-install/b.tar.gz' })
    expect(proc.spawn.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      ['studio', 'restart'],
      ['studio', 'update', '--yes'],
      ['studio', 'update', '1.2.3', '--yes'],
      ['studio', 'update', '--bundle', '/data/host-install/b.tar.gz', '--yes'],
    ])
    expect((proc.spawn.mock.calls[0] as unknown[])[2]).toMatchObject({ detached: true, stdio: 'ignore' })
    expect(lastProgress()).toMatchObject({ stage: 'requested', kind: 'artifact' })
  })

  it('refuses when its system services need a sudo password nobody can type', () => {
    if (process.platform !== 'darwin') return
    fsState.existing.add('/Library/LaunchDaemons/com.ion.studio-server.plist')
    proc.spawnSync.mockReturnValue({ status: 1 })
    expect(requestHostInstall({ kind: 'restart' })).toMatchObject({ ok: false, refusal: { code: 'needs_sudo' } })
    expect(proc.spawn).not.toHaveBeenCalled()
    expect(lastProgress()).toMatchObject({ stage: 'refused', code: 'needs_sudo' })
  })

  it('asks sudo once for many reads of whether it can install, and afresh for a real install', () => {
    if (process.platform !== 'darwin') return
    fsState.existing.add('/Library/LaunchDaemons/com.ion.studio-server.plist')
    proc.spawnSync.mockReturnValue({ status: 1 })
    for (let i = 0; i < 5; i++) expect(hostInstallAvailability()).toEqual({ available: false, code: 'needs_sudo' })
    expect(proc.spawnSync).toHaveBeenCalledTimes(1)
    proc.spawnSync.mockReturnValue({ status: 0 })
    expect(requestHostInstall({ kind: 'restart' })).toMatchObject({ ok: true })
    expect(proc.spawnSync).toHaveBeenCalledTimes(2)
    expect(hostInstallAvailability()).toEqual({ available: true })
    expect(proc.spawnSync).toHaveBeenCalledTimes(2)
  })

  it('reports a bundle whose ion is missing', () => {
    fsState.existing.clear()
    expect(requestHostInstall({ kind: 'restart' })).toMatchObject({ ok: false, error: { code: 'bundle_incomplete' } })
  })
})

describe('a server a desktop runs', () => {
  beforeEach(() => { host.app = { name: 'desktop', version: '1.0.0' } })

  it('hands the request to that desktop, on its on-host connection only', () => {
    const remote = connection({ transport: 'relay' })
    const old = connection({ connectedAt: 1 })
    const desktop = connection({ connectedAt: 2 })
    host.connections = [remote, old, desktop]
    expect(requestHostInstall({ kind: 'release', version: '2.0.0' })).toEqual({ ok: true, value: { scheduled: true, by: 'desktop' } })
    expect(desktop.send).toHaveBeenCalledWith({ type: 'studio_event', channel: 'ion:host-install-requested', payload: { kind: 'release', version: '2.0.0' } })
    expect(old.send).not.toHaveBeenCalled()
    expect(remote.send).not.toHaveBeenCalled()
    expect(proc.spawn).not.toHaveBeenCalled()
  })

  it('refuses when that desktop is not connected, or cannot install', () => {
    host.connections = [connection({ hasCapability: () => false }), connection({ isClosed: true })]
    expect(requestHostInstall({ kind: 'restart' })).toMatchObject({ ok: false, refusal: { code: 'host_app_unreachable' } })
    expect(lastProgress()).toMatchObject({ stage: 'refused', kind: 'restart', code: 'host_app_unreachable' })
  })
})

describe('a server started by hand', () => {
  it('refuses: nothing here can replace or restart it', () => {
    expect(requestHostInstall({ kind: 'restart' })).toMatchObject({ ok: false, refusal: { code: 'no_bundle' } })
  })
})

describe('whether the host can install on itself', () => {
  it('answers by the same rules as a request, without starting anything', () => {
    expect(hostInstallAvailability()).toEqual({ available: false, code: 'no_bundle' })
    host.app = { name: 'desktop', version: '1.0.0' }
    expect(hostInstallAvailability()).toEqual({ available: false, code: 'host_app_unreachable' })
    host.connections = [connection()]
    expect(hostInstallAvailability()).toEqual({ available: true })
    host.app = null
    host.bundleRoot = '/data/studio-server'
    expect(hostInstallAvailability()).toEqual({ available: true })
    expect(proc.spawn).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('rides the server facts, so a client can choose between asking the host and SSH', () => {
    expect(serverInfoWithInstall('1.2.3', {} as never)).toEqual({ serverVersion: '1.2.3', hostInstall: { available: false, code: 'no_bundle' } })
  })
})
