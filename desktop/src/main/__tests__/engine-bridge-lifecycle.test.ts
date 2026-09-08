/**
 * engine-bridge-lifecycle.test.ts — daemon stop mechanics.
 *
 * The engine is a persistent daemon under a per-user supervisor that outlives
 * the desktop. Only the paths that intentionally STOP the engine (Quit All,
 * backend switch/relaunch) call shutdownAndWait, which must:
 *   1. Send the graceful `shutdown` command, then
 *   2. Stop it through its supervisor, because on every platform a supervisor
 *      exists to bring the process back: launchd respawns a booted-in agent,
 *      and a Windows Scheduled Task is simply still registered and running.
 *
 * "Quit Desktop" does NOT call this path (verified in window-manager wiring),
 * so the daemon is left running with background schedules + iOS/relay intact.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const stopEngineDaemon = vi.hoisted(() => vi.fn(async () => true))

vi.mock('../engine-bootstrap', () => ({ stopEngineDaemon }))

vi.mock('../engine-address', () => ({
  resolveEngineAddress: () => ({ kind: 'tcp', host: '127.0.0.1', port: 21017 }),
  // Engine refuses connections immediately so the wait loop exits fast.
  probeEngine: vi.fn(async () => false),
}))

import { shutdownAndWait } from '../engine-bridge-lifecycle'
import type { EngineBridge } from '../engine-bridge'

const originalPlatform = process.platform

function makeFakeBridge() {
  const sent: any[] = []
  const bridge = {
    conn: { destroyed: false, destroy: vi.fn() },
    connected: true,
    reconnectDisabled: false,
    reconnectTimer: null,
    _send: vi.fn((msg: any) => sent.push(msg)),
    _sentMessages: sent,
  }
  return bridge as unknown as EngineBridge & { _sentMessages: any[] }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

describe('shutdownAndWait (engine-stopping path)', () => {
  // The regression this pins: the supervisor stop used to be an inline
  // `launchctl bootout` behind a darwin check, so on Windows Quit All stopped
  // nothing. The Scheduled Task kept the engine serving after the desktop
  // exited, and since engine.json is read once at start, an operator who quit,
  // edited config and relaunched was still talking to the old daemon.
  it.each(['darwin', 'win32', 'linux'])(
    'sends shutdown then stops the daemon through its supervisor on %s',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      const bridge = makeFakeBridge()

      await shutdownAndWait(bridge, 100)

      expect((bridge as any)._sentMessages).toEqual([{ cmd: 'shutdown' }])
      expect(stopEngineDaemon).toHaveBeenCalledTimes(1)
      // Reconnect is disabled so the bridge does not fight the intentional stop.
      expect(bridge.reconnectDisabled).toBe(true)
    },
  )

  // The desktop must still exit when the stop fails, or a broken supervisor
  // registration becomes a desktop that cannot be quit.
  it('completes even when the supervisor stop fails', async () => {
    stopEngineDaemon.mockResolvedValueOnce(false)
    const bridge = makeFakeBridge()

    await expect(shutdownAndWait(bridge, 100)).resolves.toBeUndefined()
    expect(bridge.connected).toBe(false)
  })
})
