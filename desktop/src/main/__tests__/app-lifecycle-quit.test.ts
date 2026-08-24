import { describe, expect, it, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => ({
  events: [] as string[],
  appHandlers: new Map<string, () => void>(),
}))
vi.mock('electron', () => ({
  app: {
    exit: vi.fn(() => calls.events.push('exit')),
    getPath: vi.fn(() => '/tmp'),
    on: vi.fn((event: string, handler: () => void) => calls.appHandlers.set(event, handler)),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  globalShortcut: { unregisterAll: vi.fn(() => calls.events.push('shortcuts')) },
}))
vi.mock('fs', () => ({ rmSync: vi.fn() }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), flushLogs: vi.fn(() => calls.events.push('logs')) }))
vi.mock('../state', () => ({
  state: { forceQuit: false, tray: null, remoteTransport: null },
  sessionPlane: {
    shutdown: vi.fn(() => calls.events.push('sessions')),
    drain: vi.fn(() => Promise.resolve()),
  },
  engineBridge: { shutdownAndWait: vi.fn(async () => calls.events.push('engine')) },
  fileWatchers: new Map(),
  bashProcesses: new Map(),
}))
vi.mock('../terminal-manager-instance', () => ({ terminalManager: { destroyAll: vi.fn(() => calls.events.push('terminals')) } }))
vi.mock('../remote/snapshot-polling', () => ({ stopTabSnapshotPolling: vi.fn() }))
vi.mock('../worktree/freshness-poll', () => ({ stopWorktreeFreshnessPoll: vi.fn() }))
vi.mock('../studio-terminal-persistence', () => ({ saveStudioTerminals: vi.fn() }))
vi.mock('../watchdog', () => ({ stopWatchdog: vi.fn() }))
vi.mock('../log-egress', () => ({ closeEgress: vi.fn(() => Promise.resolve()) }))
vi.mock('../log-egress-tailer', () => ({ stopEgressTailers: vi.fn() }))

import { state, sessionPlane } from '../state'
import { installQuitHandlers, quitForUpdate } from '../app-lifecycle-quit'

describe('quitForUpdate', () => {
  beforeEach(() => {
    calls.events.length = 0
    calls.appHandlers.clear()
    state.forceQuit = false
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('forces the normal quit dialog off before stopping sessions and the engine', async () => {
    await quitForUpdate()

    expect(state.forceQuit).toBe(true)
    expect(sessionPlane.shutdown).toHaveBeenCalledWith({ stopSessions: true })
    expect(calls.events.indexOf('sessions')).toBeLessThan(calls.events.indexOf('engine'))
    expect(calls.events).toContain('exit')
  })

  it('drains indefinitely on SIGUSR1 instead of force-quitting after five minutes', () => {
    vi.useFakeTimers()
    ;(sessionPlane.drain as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>(() => {}))
    installQuitHandlers(async () => {})
    calls.appHandlers.get('SIGUSR1')?.()

    vi.advanceTimersByTime(6 * 60 * 1000)
    expect(sessionPlane.shutdown).not.toHaveBeenCalled()
  })
})
