import { describe, expect, it, vi, beforeEach } from 'vitest'

const order = vi.hoisted(() => [] as string[])
const deps = vi.hoisted(() => ({
  setWatchdogSuspended: vi.fn(),
  flushLogs: vi.fn(),
  renewRelayClientsAfterWake: vi.fn(() => 2),
  runServerShutdown: vi.fn(async () => undefined),
  state: { remoteTransport: { id: 't' } },
  sessionPlane: { hasRunningTabs: vi.fn(() => true), getHealth: vi.fn(() => ({ ok: true })) },
}))
vi.mock('../../watchdog', () => ({ setWatchdogSuspended: deps.setWatchdogSuspended }))
vi.mock('../../remote/relay-client', () => ({ renewRelayClientsAfterWake: deps.renewRelayClientsAfterWake }))
vi.mock('../../shutdown', () => ({ runServerShutdown: deps.runServerShutdown }))
vi.mock('../../state', () => ({ state: deps.state, sessionPlane: deps.sessionPlane }))
vi.mock('../../paths', () => ({ dataDir: () => '/nonexistent/ion-lifecycle-test' }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), flushLogs: deps.flushLogs }))

import { LIFECYCLE_ACTIONS, _setExitAfterShutdownForTest } from '../lifecycle-actions'
import type { Connection } from '../connection'

const desktop = { id: 'd', transport: 'local', clientKind: 'desktop', scopes: ['admin'] } as unknown as Connection
const localWeb = { id: 'w', transport: 'local', clientKind: 'web', scopes: ['admin'] } as unknown as Connection

beforeEach(() => { deps.setWatchdogSuspended.mockClear(); deps.renewRelayClientsAfterWake.mockClear(); deps.runServerShutdown.mockClear() })

describe('LIFECYCLE_ACTIONS', () => {
  it('suspend pauses the watchdog; wake resumes it and renews the relay sockets', async () => {
    expect(await LIFECYCLE_ACTIONS['lifecycle.systemSuspend'].handler(desktop, [])).toEqual({ ok: true, value: null })
    expect(deps.setWatchdogSuspended).toHaveBeenLastCalledWith(true)
    expect(await LIFECYCLE_ACTIONS['lifecycle.systemWake'].handler(desktop, [])).toEqual({ ok: true, value: null })
    expect(deps.setWatchdogSuspended).toHaveBeenLastCalledWith(false)
    expect(deps.renewRelayClientsAfterWake).toHaveBeenCalledOnce()
  })

  it('status reports whether engine sessions are running', async () => {
    expect(await LIFECYCLE_ACTIONS['lifecycle.status'].handler(desktop, [])).toEqual({ ok: true, value: { hasRunningTabs: true } })
  })

  it('shutdown runs the server sequence with the requested stopSessions, replies ok, and exits only afterwards', async () => {
    const exits: number[] = []
    order.length = 0
    deps.flushLogs.mockImplementation(() => { order.push('flush-logs') })
    _setExitAfterShutdownForTest((code) => { order.push('exit'); exits.push(code) })
    try {
      const outcome = await LIFECYCLE_ACTIONS['lifecycle.shutdown'].handler(desktop, [{ stopSessions: true }])
      expect(deps.runServerShutdown).toHaveBeenCalledWith(expect.objectContaining({ stopSessions: true }))
      expect(outcome).toEqual({ ok: true, value: { ok: true } })
      // The reply is in hand before the exit seam fires.
      expect(exits).toEqual([])
      await new Promise((r) => setImmediate(r))
      expect(exits).toEqual([0])
      // 'exiting after shutdown reply' is logged on the same tick as the exit,
      // so without this drain it was the one line guaranteed never to reach
      // the file.
      expect(order).toEqual(['flush-logs', 'exit'])
    } finally {
      _setExitAfterShutdownForTest(null)
    }
  })

  it('diagnostics carries the session-plane health and the log tail', async () => {
    const outcome = await LIFECYCLE_ACTIONS['lifecycle.diagnostics'].handler(desktop, [])
    expect(outcome).toMatchObject({ ok: true, value: { health: { ok: true }, recentLogs: '', logPath: expect.stringContaining('server.jsonl') } })
  })

  it('refuses anything that is not the local desktop', async () => {
    expect(await LIFECYCLE_ACTIONS['lifecycle.systemWake'].handler(localWeb, [])).toMatchObject({ ok: false, error: { code: 'local_only' } })
    expect(await LIFECYCLE_ACTIONS['lifecycle.shutdown'].handler(localWeb, [{ stopSessions: true }])).toMatchObject({ ok: false, error: { code: 'local_only' } })
    expect(deps.renewRelayClientsAfterWake).not.toHaveBeenCalled()
    expect(deps.runServerShutdown).not.toHaveBeenCalled()
  })
})
