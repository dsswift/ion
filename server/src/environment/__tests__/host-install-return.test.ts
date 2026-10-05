/** A host install outlives the server it replaces: the marker it leaves is how the next server says the host is back. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HOST_INSTALL_STALE_MS } from '@ion/shared/host-install'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
const paths = vi.hoisted(() => ({ dir: '' }))
vi.mock('../../paths', () => ({ dataDir: () => paths.dir }))
const host = vi.hoisted(() => ({ bundleRoot: null as string | null, connections: [] as unknown[] }))
vi.mock('../host-info', () => ({ studioBundleRoot: () => host.bundleRoot, serverInfo: (serverVersion: string) => ({ serverVersion }) }))
vi.mock('../../compat/runtime', () => ({ hostApp: () => ({ name: 'desktop', version: '1.0.0' }) }))
vi.mock('../../protocol/connection', () => ({ connectionRegistry: { all: () => host.connections } }))
vi.mock('../../protocol/hello', () => ({ connectionOnHost: () => true }))
const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }))
vi.mock('../../broadcast', () => ({ broadcast }))
const hubs = vi.hoisted(() => ({ install: vi.fn() }))
vi.mock('../../fleet/hub-links', () => ({ fleetHubLinks: () => hubs }))

import { announceHostInstallRestart, completePendingHostInstall, noteExternalHostInstall, publishHostInstallProgress, requestHostInstall } from '../host-install'

const marker = (): string => join(paths.dir, 'host-install-pending.json')
const steps = (): Array<Record<string, unknown>> => hubs.install.mock.calls.map((c) => c[0] as Record<string, unknown>)

beforeEach(() => {
  paths.dir = mkdtempSync(join(tmpdir(), 'ion-host-install-test-'))
  host.connections = [{ id: 'c', isClosed: false, connectedAt: 1, hasCapability: () => true, send: vi.fn() }]
  broadcast.mockClear()
  hubs.install.mockClear()
})
afterEach(() => rmSync(paths.dir, { recursive: true, force: true }))

describe('a host install as the server itself tells it', () => {
  it('tells its hubs every step it tells its clients', () => {
    publishHostInstallProgress({ stage: 'downloading', kind: 'release' })
    expect(broadcast.mock.calls.at(-1)?.[1]).toMatchObject({ stage: 'downloading', kind: 'release' })
    expect(steps()).toMatchObject([{ stage: 'downloading', kind: 'release' }])
  })

  it('says the host is going down, then that it is back and what it runs', () => {
    expect(requestHostInstall({ kind: 'release' })).toMatchObject({ ok: true })
    expect(existsSync(marker())).toBe(true)
    announceHostInstallRestart()
    // The server that boots after the install finds the marker the last one left.
    completePendingHostInstall('2.0.0')
    expect(steps().map((s) => s.stage)).toEqual(['requested', 'restarting', 'completed'])
    expect(steps().at(-1)).toMatchObject({ kind: 'release', version: '2.0.0' })
    expect(existsSync(marker())).toBe(false)
  })

  it('says nothing at boot, or at a stop, when no install was under way', () => {
    completePendingHostInstall('2.0.0')
    announceHostInstallRestart()
    expect(hubs.install).not.toHaveBeenCalled()
  })

  it('reports an install the fleet runs over SSH, which the server takes no part in', () => {
    noteExternalHostInstall()
    expect(steps()).toMatchObject([{ stage: 'installing', kind: 'artifact' }])
    completePendingHostInstall('2.0.0')
    expect(steps().at(-1)).toMatchObject({ stage: 'completed', kind: 'artifact', version: '2.0.0' })
  })

  it('forgets an install that was refused or failed: the next boot is not its return', () => {
    requestHostInstall({ kind: 'release' })
    publishHostInstallProgress({ stage: 'failed', kind: 'release', message: 'download failed' })
    expect(existsSync(marker())).toBe(false)
    hubs.install.mockClear()
    completePendingHostInstall('2.0.0')
    expect(hubs.install).not.toHaveBeenCalled()
  })

  it('drops a marker too old to be an install still under way, and one it cannot read', () => {
    writeFileSync(marker(), JSON.stringify({ kind: 'release', at: Date.now() - HOST_INSTALL_STALE_MS - 1 }))
    completePendingHostInstall('2.0.0')
    writeFileSync(marker(), 'not json')
    completePendingHostInstall('2.0.0')
    expect(hubs.install).not.toHaveBeenCalled()
    expect(existsSync(marker())).toBe(false)
  })
})
