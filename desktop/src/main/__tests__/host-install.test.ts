// The desktop that runs a server carries out the restarts and updates that
// server is asked for, tells it each step, and refuses with the reason when
// it will not replace its own app.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

const el = vi.hoisted(() => ({ app: { isPackaged: true, relaunch: vi.fn(), getVersion: () => '1.5.0' } }))
vi.mock('electron', () => el)
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../install-dispatch', () => ({ installedAppPath: () => '/Applications/Ion.app' }))
const fs = vi.hoisted(() => ({ writable: true }))
vi.mock('node:fs', () => ({
  accessSync: () => { if (!fs.writable) throw new Error('EACCES') },
  constants: { W_OK: 2 },
}))
const updater = vi.hoisted(() => ({
  hasUpdateFeed: vi.fn(() => true),
  installArchiveNow: vi.fn(async (_path: string, onStage: (s: string) => void) => { onStage('installing'); onStage('restarting') }),
  installLatestReleaseNow: vi.fn(async (onStage: (s: string) => void) => { onStage('downloading'); return true }),
}))
vi.mock('../updater', () => updater)
const quit = vi.hoisted(() => ({ quitForUpdate: vi.fn(async () => {}) }))
vi.mock('../app-lifecycle-quit', () => quit)

import { installRefusal, wireHostInstall } from '../host-install'

let deliver: (environmentId: string, frame: StudioFrame) => void
const sendAction = vi.fn(async () => null)
const source = { onFrame: (cb: typeof deliver) => { deliver = cb; return () => {} }, sendAction }

const request = (payload: unknown, environmentId = 'local'): void => deliver(environmentId, { type: 'studio_event', channel: 'ion:host-install-requested', payload } as StudioFrame)
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const reports = (): Array<Record<string, unknown>> => sendAction.mock.calls.map((c) => (c as unknown[])[2] as unknown[]).map((args) => args[0] as Record<string, unknown>)

// The install path depends on the platform; every case runs as the one named
// here, whatever the test host is.
const realPlatform = process.platform
const setPlatform = (platform: NodeJS.Platform): void => { Object.defineProperty(process, 'platform', { value: platform, configurable: true }) }

afterEach(() => setPlatform(realPlatform))

beforeEach(() => {
  vi.clearAllMocks()
  setPlatform('darwin')
  el.app.isPackaged = true
  fs.writable = true
  updater.hasUpdateFeed.mockReturnValue(true)
  wireHostInstall(source, { disableAutoUpdate: false })
})

describe('a request from the local server', () => {
  it('restarts the app', async () => {
    request({ kind: 'restart' })
    await settle()
    expect(el.app.relaunch).toHaveBeenCalled()
    expect(quit.quitForUpdate).toHaveBeenCalled()
    expect(sendAction).toHaveBeenCalledWith('local', 'environment.server.reportInstall', [{ stage: 'restarting', kind: 'restart' }])
  })

  it('installs the newest release and reports each step', async () => {
    request({ kind: 'release' })
    await settle()
    expect(updater.installLatestReleaseNow).toHaveBeenCalled()
    expect(reports()).toEqual([{ stage: 'downloading', kind: 'release' }])
  })

  it('says so when it already runs the newest release, or the version asked for', async () => {
    updater.installLatestReleaseNow.mockResolvedValueOnce(false)
    request({ kind: 'release' })
    await settle()
    expect(reports()[0]).toMatchObject({ stage: 'refused', code: 'up_to_date' })
    sendAction.mockClear()
    request({ kind: 'release', version: 'v1.5.0' })
    await settle()
    expect(reports()[0]).toMatchObject({ stage: 'refused', code: 'up_to_date' })
    expect(updater.installLatestReleaseNow).toHaveBeenCalledTimes(1)
  })

  it('installs a build that was sent', async () => {
    request({ kind: 'artifact', path: '/data/host-install/Ion.zip' })
    await settle()
    expect(updater.installArchiveNow).toHaveBeenCalledWith('/data/host-install/Ion.zip', expect.any(Function))
    expect(reports().map((r) => r.stage)).toEqual(['installing', 'restarting'])
  })

  it('reports an install that fails', async () => {
    updater.installArchiveNow.mockRejectedValueOnce(new Error('downloaded update does not contain Ion.app'))
    request({ kind: 'artifact', path: '/data/host-install/Ion.zip' })
    await settle()
    expect(reports().at(-1)).toMatchObject({ stage: 'failed', kind: 'artifact', message: 'downloaded update does not contain Ion.app' })
  })

  it('ignores another environment\'s frames and a malformed request', async () => {
    request({ kind: 'restart' }, 'env-remote')
    request({ kind: 'artifact' })
    request({ kind: 'reformat' })
    await settle()
    expect(el.app.relaunch).not.toHaveBeenCalled()
    expect(sendAction).not.toHaveBeenCalled()
  })
})

describe('a desktop that will not replace its own app', () => {
  it('refuses a release with the reason, and still restarts', async () => {
    fs.writable = false
    request({ kind: 'release' })
    await settle()
    expect(reports()[0]).toMatchObject({ stage: 'refused', kind: 'release', code: 'not_admin' })
    expect(updater.installLatestReleaseNow).not.toHaveBeenCalled()
    sendAction.mockClear()
    request({ kind: 'restart' })
    await settle()
    expect(el.app.relaunch).toHaveBeenCalled()
  })

  it('refuses a release and a sent build on Windows', async () => {
    setPlatform('win32')
    request({ kind: 'release' })
    await settle()
    request({ kind: 'artifact', path: '/data/host-install/Ion.zip' })
    await settle()
    expect(reports().map((r) => r.code)).toEqual(['needs_administrator', 'needs_administrator'])
    expect(updater.installLatestReleaseNow).not.toHaveBeenCalled()
    expect(updater.installArchiveNow).not.toHaveBeenCalled()
  })

  it('names the reason for each case', () => {
    expect(installRefusal({ disableAutoUpdate: true }, 'darwin')).toBe('updates_disabled')
    expect(installRefusal({ disableAutoUpdate: false }, 'win32')).toBe('needs_administrator')
    expect(installRefusal({ disableAutoUpdate: false }, 'darwin')).toBeNull()
    fs.writable = false
    expect(installRefusal({ disableAutoUpdate: false }, 'darwin')).toBe('not_admin')
    expect(installRefusal({ disableAutoUpdate: false }, 'linux')).toBeNull()
    el.app.isPackaged = false
    expect(installRefusal({ disableAutoUpdate: false }, 'darwin')).toBe('not_packaged')
  })

  it('refuses a release when the build has no feed', async () => {
    updater.hasUpdateFeed.mockReturnValue(false)
    request({ kind: 'release' })
    await settle()
    expect(reports()[0]).toMatchObject({ stage: 'refused', code: 'no_update_feed' })
  })
})
