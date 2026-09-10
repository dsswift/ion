import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const calls = vi.hoisted(() => ({
  quitAndInstall: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock('electron-updater', () => ({
  autoUpdater: { quitAndInstall: calls.quitAndInstall },
}))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp') } }))
vi.mock('node:child_process', () => ({
  execFile: calls.execFile,
  spawn: calls.spawn,
}))
vi.mock('../logger', () => ({ log: vi.fn(), error: vi.fn() }))

import { dispatchUpdateInstall } from '../install-dispatch'

const originalPlatform = process.platform

describe('dispatchUpdateInstall — win32', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('calls autoUpdater.quitAndInstall(false, true) and never spawns ditto', async () => {
    const pid = await dispatchUpdateInstall('C:\\Users\\x\\AppData\\Local\\Temp\\Ion-Setup.exe')

    expect(calls.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(calls.execFile).not.toHaveBeenCalled()
    expect(calls.spawn).not.toHaveBeenCalled()
    expect(typeof pid).toBe('number')
  })
})
