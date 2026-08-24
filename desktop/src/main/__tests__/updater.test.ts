import { describe, expect, it, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => ({
  on: [] as Array<[string, (...args: unknown[]) => void]>,
  broadcast: vi.fn(),
  dispatch: vi.fn(),
  quit: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: vi.fn(() => '/tmp'), exit: vi.fn() },
  ipcMain: { on: vi.fn((channel, handler) => calls.on.push([channel, handler])) },
}))
vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }))
vi.mock('../logger', () => ({ info: vi.fn(), error: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcast: calls.broadcast }))
vi.mock('../install-dispatch', () => ({ dispatchUpdateInstall: calls.dispatch }))
vi.mock('../app-lifecycle-quit', () => ({ quitForUpdate: calls.quit }))
vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: vi.fn(),
    checkForUpdates: vi.fn(() => Promise.resolve()),
    autoDownload: false,
    autoInstallOnAppQuit: true,
  },
}))

import { autoUpdater } from 'electron-updater'
import { IPC } from '../../shared/types-ipc'
import { initAutoUpdater } from '../updater'

describe('auto updater install handoff', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'resourcesPath', { value: '/tmp/resources', configurable: true })
    calls.on.length = 0
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  it('disables install-on-quit and stages the detached worker instead of quitAndInstall', async () => {
    calls.dispatch.mockResolvedValue(912)
    initAutoUpdater()

    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
    const downloaded = (autoUpdater.on as ReturnType<typeof vi.fn>).mock.calls
      .find(([name]) => name === 'update-downloaded')?.[1] as (event: { version: string; downloadedFile: string }) => void
    downloaded({ version: '2.0.0', downloadedFile: '/tmp/Ion.zip' })

    const install = calls.on.find(([channel]) => channel === IPC.INSTALL_UPDATE)?.[1]
    install?.()
    await Promise.resolve()
    expect(calls.dispatch).toHaveBeenCalledWith('/tmp/Ion.zip')
    expect(calls.broadcast).toHaveBeenCalledWith(IPC.UPDATE_STAGED, { workerPid: 912 })
  })
})
