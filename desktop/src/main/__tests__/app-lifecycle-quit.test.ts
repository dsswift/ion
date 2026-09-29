/**
 * Every quit is carried out by the Studio server through `lifecycle.shutdown`;
 * this process decides the answer, waits (bounded) for the server, then
 * tears down what is its own. Pinned against a mocked broker and local
 * server so the ordering survives the process boundary.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => ({
  events: [] as string[],
  appHandlers: new Map<string, (e: { preventDefault: () => void }) => void>(),
}))
const mockShowMessageBoxSync = vi.hoisted(() => vi.fn())
const broker = vi.hoisted(() => ({
  phaseOf: vi.fn((): { phase: string } | undefined => ({ phase: 'connected' })),
  sendAction: vi.fn(async (_env: string, action: string) => {
    calls.events.push(action)
    if (action === 'lifecycle.status') return { hasRunningTabs: true }
    return { ok: true }
  }),
}))
const local = vi.hoisted(() => ({
  stop: vi.fn(async () => { calls.events.push('local-server-stop') }),
  waitForExit: vi.fn(() => new Promise<boolean>(() => {})),
  signal: vi.fn(() => { calls.events.push('signal'); return true }),
}))
const engine = vi.hoisted(() => ({
  stopEngineDaemon: vi.fn(async () => { calls.events.push('engine-stop'); return true }),
  waitForEngineStopped: vi.fn(async () => true),
}))

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(() => calls.events.push('exit')),
    getPath: vi.fn(() => '/tmp'),
    on: vi.fn((event: string, handler: (e: { preventDefault: () => void }) => void) => calls.appHandlers.set(event, handler)),
  },
  globalShortcut: { unregisterAll: vi.fn(() => calls.events.push('shortcuts')) },
  dialog: { showMessageBoxSync: mockShowMessageBoxSync },
}))
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()), rmSync: vi.fn() }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), flushLogs: vi.fn(() => calls.events.push('logs')) }))
vi.mock('../state', () => ({ state: { forceQuit: false, tray: null, studioWindow: null } }))
vi.mock('../connections/broker-instance', () => ({ broker }))
vi.mock('../local-server-instance', () => ({ localServer: local }))
vi.mock('@ion/server/engine/engine-bootstrap', () => ({ stopEngineDaemon: engine.stopEngineDaemon }))
vi.mock('@ion/server/engine/engine-address', () => ({ waitForEngineStopped: engine.waitForEngineStopped }))
vi.mock('@ion/server/watchdog', () => ({ stopWatchdog: vi.fn() }))
vi.mock('@ion/shared/log-egress', () => ({ closeEgress: vi.fn(() => Promise.resolve()) }))
vi.mock('@ion/shared/log-egress-tailer', () => ({ stopEgressTailers: vi.fn() }))

import { state } from '../state'
import { FORCE_QUIT_ARG } from '../force-quit-arg'
import { installQuitHandlers, installBeforeQuitDialog, quitForUpdate, quitThroughServer, SHUTDOWN_TIMEOUT_MS, _resetQuitForTest } from '../app-lifecycle-quit'

function captureSignal(signal: 'SIGUSR1' | 'SIGUSR2'): () => void {
  const spy = vi.spyOn(process, 'on')
  installQuitHandlers()
  const registration = spy.mock.calls.find(([event]) => event === signal)
  spy.mockRestore()
  if (!registration) throw new Error(`installQuitHandlers registered no ${signal} handler`)
  const handler = registration[1] as () => void
  process.removeListener(signal, handler)
  return handler
}
const captureSigusr1 = (): (() => void) => captureSignal('SIGUSR1')

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  calls.events.length = 0
  calls.appHandlers.clear()
  state.forceQuit = false
  _resetQuitForTest()
  vi.clearAllMocks()
  vi.useRealTimers()
  broker.phaseOf.mockImplementation(() => ({ phase: 'connected' }))
  broker.sendAction.mockImplementation(async (_env: string, action: string) => {
    calls.events.push(action)
    if (action === 'lifecycle.status') return { hasRunningTabs: true }
    return { ok: true }
  })
  local.waitForExit.mockImplementation(() => new Promise<boolean>(() => {}))
})

describe('quitThroughServer', () => {
  it('skips the wire entirely when the local connection is not open, and still stops the child and exits', async () => {
    // The splash's Quit button before the server answered: a queued frame
    // would only wait out the shutdown timeout.
    broker.phaseOf.mockImplementation(() => ({ phase: 'connecting' }))
    await quitThroughServer({ stopSessions: true })
    expect(broker.sendAction).not.toHaveBeenCalled()
    expect(calls.events).toEqual(['local-server-stop', 'engine-stop', 'shortcuts', 'logs', 'exit'])
  })

  it('a second quit request joins the one in flight rather than starting another', async () => {
    let release!: () => void
    local.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { release = () => { calls.events.push('local-server-stop'); resolve() } }))
    const first = quitThroughServer({ stopSessions: false })
    const second = quitThroughServer({ stopSessions: false })
    expect(second).toBe(first)
    await settle()
    release()
    await first
    expect(calls.events.filter((e) => e === 'lifecycle.shutdown')).toHaveLength(1)
    expect(calls.events.filter((e) => e === 'exit')).toHaveLength(1)
  })

  it('Quit All: the server shuts down (stopping sessions) before the engine daemon is booted out, then the desktop exits', async () => {
    await quitThroughServer({ stopSessions: true })
    expect(state.forceQuit).toBe(true)
    expect(broker.sendAction).toHaveBeenCalledWith('local', 'lifecycle.shutdown', [{ stopSessions: true }])
    const order = ['lifecycle.shutdown', 'local-server-stop', 'engine-stop', 'shortcuts', 'logs', 'exit']
    expect(order.map((e) => calls.events.indexOf(e))).toEqual([...order.map((e) => calls.events.indexOf(e))].sort((a, b) => a - b))
    expect(engine.waitForEngineStopped).toHaveBeenCalled()
  })

  it('Quit Desktop: leaves the engine daemon alone', async () => {
    await quitThroughServer({ stopSessions: false })
    expect(broker.sendAction).toHaveBeenCalledWith('local', 'lifecycle.shutdown', [{ stopSessions: false }])
    expect(calls.events).not.toContain('engine-stop')
    expect(calls.events).toContain('exit')
    expect(calls.events.indexOf('local-server-stop')).toBeLessThan(calls.events.indexOf('exit'))
  })

  it('still exits when the server never answers: the wait is bounded', async () => {
    vi.useFakeTimers()
    broker.sendAction.mockImplementation(() => new Promise(() => {}))
    const quit = quitThroughServer({ stopSessions: false })
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS + 10)
    await quit
    expect(calls.events).toContain('exit')
  })

  it('treats the child exiting on its own as the shutdown having happened', async () => {
    broker.sendAction.mockImplementation(() => new Promise(() => {}))
    local.waitForExit.mockImplementation(async () => true)
    await quitThroughServer({ stopSessions: false })
    expect(calls.events).toContain('exit')
  })
})

describe('quitForUpdate', () => {
  it('is a Quit All with the dialog bypassed', async () => {
    await quitForUpdate()
    expect(state.forceQuit).toBe(true)
    expect(broker.sendAction).toHaveBeenCalledWith('local', 'lifecycle.shutdown', [{ stopSessions: true }])
    expect(calls.events).toContain('engine-stop')
  })
})

describe('installBeforeQuitDialog', () => {
  it('prevents the default quit, asks the server whether sessions run, and prompts', async () => {
    mockShowMessageBoxSync.mockReturnValue(2) // Cancel
    installBeforeQuitDialog()
    const prevented = vi.fn()
    calls.appHandlers.get('before-quit')?.({ preventDefault: prevented })
    await settle()
    expect(prevented).toHaveBeenCalled()
    expect(broker.sendAction).toHaveBeenCalledWith('local', 'lifecycle.status', [])
    expect(mockShowMessageBoxSync.mock.calls[0]![0]).toMatchObject({ message: 'Sessions are running in the engine.' })
    // Cancel: nothing torn down.
    expect(calls.events).not.toContain('lifecycle.shutdown')
  })

  it('Quit All asks the server to stop sessions and boots the engine out', async () => {
    mockShowMessageBoxSync.mockReturnValue(1)
    installBeforeQuitDialog()
    calls.appHandlers.get('before-quit')?.({ preventDefault: vi.fn() })
    await settle()
    expect(broker.sendAction).toHaveBeenCalledWith('local', 'lifecycle.shutdown', [{ stopSessions: true }])
    expect(calls.events).toContain('engine-stop')
    expect(calls.events).toContain('exit')
  })

  it('Quit Desktop leaves the engine running', async () => {
    mockShowMessageBoxSync.mockReturnValue(0)
    installBeforeQuitDialog()
    calls.appHandlers.get('before-quit')?.({ preventDefault: vi.fn() })
    await settle()
    expect(broker.sendAction).toHaveBeenCalledWith('local', 'lifecycle.shutdown', [{ stopSessions: false }])
    expect(calls.events).not.toContain('engine-stop')
    expect(calls.events).toContain('exit')
  })

  it('a forced quit (update restart) never shows the dialog', () => {
    state.forceQuit = true
    installBeforeQuitDialog()
    const prevented = vi.fn()
    calls.appHandlers.get('before-quit')?.({ preventDefault: prevented })
    expect(prevented).not.toHaveBeenCalled()
    expect(mockShowMessageBoxSync).not.toHaveBeenCalled()
  })
})

describe('SIGUSR1 drain-quit', () => {
  it('signals the server to drain, waits for its exit without a timeout, then boots the engine out', async () => {
    let resolveExit: (v: boolean) => void = () => {}
    local.waitForExit.mockImplementation(() => new Promise<boolean>((r) => { resolveExit = r }))
    const sigusr1 = captureSigusr1()
    sigusr1()
    await settle()
    expect(calls.events).toContain('signal')
    expect(calls.events).not.toContain('engine-stop')
    resolveExit(true)
    await settle()
    expect(calls.events).toContain('engine-stop')
    expect(calls.events).toContain('exit')
  })

  it('drains indefinitely instead of force-quitting after five minutes', async () => {
    vi.useFakeTimers()
    local.waitForExit.mockImplementation(() => new Promise<boolean>(() => {}))
    const sigusr1 = captureSigusr1()
    sigusr1()
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
    expect(calls.events).not.toContain('engine-stop')
    expect(calls.events).not.toContain('exit')
  })
})

describe('SIGUSR2 forced quit', () => {
  it('quits without the dialog and without waiting for active work: stops sessions, boots the engine out, exits', async () => {
    const sigusr2 = captureSignal('SIGUSR2')
    sigusr2()
    await settle()
    expect(state.forceQuit).toBe(true)
    expect(mockShowMessageBoxSync).not.toHaveBeenCalled()
    expect(broker.sendAction).toHaveBeenCalledWith('local', 'lifecycle.shutdown', [{ stopSessions: true }])
    expect(calls.events).not.toContain('signal')
    expect(calls.events).toContain('engine-stop')
    expect(calls.events).toContain('exit')
  })

  it('does not wait forever on a server that never answers', async () => {
    vi.useFakeTimers()
    broker.sendAction.mockImplementation(() => new Promise(() => {}))
    const sigusr2 = captureSignal('SIGUSR2')
    sigusr2()
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS + 1000)
    expect(calls.events).toContain('exit')
  })
})

describe('forced quit by second launch (Windows)', () => {
  function secondInstance(): (event: unknown, argv: string[]) => void {
    installQuitHandlers()
    const handler = calls.appHandlers.get('second-instance') as unknown as ((event: unknown, argv: string[]) => void) | undefined
    if (!handler) throw new Error('installQuitHandlers registered no second-instance handler')
    return handler
  }

  it('quits the way SIGUSR2 does when the launch carries the force-quit argument', async () => {
    secondInstance()({}, ['C:\\Program Files\\Ion\\Ion.exe', FORCE_QUIT_ARG])
    await settle()
    expect(state.forceQuit).toBe(true)
    expect(mockShowMessageBoxSync).not.toHaveBeenCalled()
    expect(broker.sendAction).toHaveBeenCalledWith('local', 'lifecycle.shutdown', [{ stopSessions: true }])
    expect(calls.events).toContain('engine-stop')
    expect(calls.events).toContain('exit')
  })

  it('ignores an ordinary second launch', async () => {
    secondInstance()({}, ['C:\\Program Files\\Ion\\Ion.exe'])
    await settle()
    expect(broker.sendAction).not.toHaveBeenCalled()
    expect(calls.events).not.toContain('exit')
  })
})
