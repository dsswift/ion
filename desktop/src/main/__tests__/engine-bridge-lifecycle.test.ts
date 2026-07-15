/**
 * engine-bridge-lifecycle.test.ts — daemon stop mechanics.
 *
 * The engine is a persistent launchd daemon that outlives the desktop. Only the
 * paths that intentionally STOP the engine (Quit All, backend switch/relaunch)
 * call shutdownAndWait, which must:
 *   1. Send the graceful `shutdown` command, then
 *   2. `launchctl bootout` the agent so KeepAlive does not respawn it — the
 *      daemon stays down until the next desktop launch re-bootstraps it, and
 *      that fresh start re-reads engine.json.
 *
 * "Quit Desktop" does NOT call this path (verified in window-manager wiring),
 * so the daemon is left running with background schedules + iOS/relay intact.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const execSyncCalls: string[] = []

vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    execSyncCalls.push(cmd)
    return ''
  }),
}))

vi.mock('fs', () => ({
  // Socket disappears immediately so shutdownAndWait's wait loop exits fast.
  existsSync: vi.fn(() => false),
}))

vi.mock('os', () => ({
  homedir: () => '/Users/testuser',
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  warn: vi.fn(),
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
  execSyncCalls.length = 0
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
})

describe('shutdownAndWait (engine-stopping path)', () => {
  it('sends shutdown then boots the daemon out so KeepAlive cannot respawn it', async () => {
    const bridge = makeFakeBridge()

    await shutdownAndWait(bridge, 100)

    // Graceful shutdown command sent first.
    expect((bridge as any)._sentMessages).toEqual([{ cmd: 'shutdown' }])
    // launchctl bootout issued so the next launch brings up a FRESH daemon
    // that re-reads engine.json.
    const bootoutCall = execSyncCalls.find((c) => c.includes('launchctl bootout'))
    expect(bootoutCall).toBeDefined()
    expect(bootoutCall).toContain('com.ion.engine.plist')
    // It must NOT kickstart -k here: this path STOPS the engine, it does not
    // recycle it in place.
    expect(execSyncCalls.some((c) => c.includes('kickstart'))).toBe(false)
    // Reconnect is disabled so the bridge does not fight the intentional stop.
    expect(bridge.reconnectDisabled).toBe(true)
  })

  it('does not run launchctl on non-darwin platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const bridge = makeFakeBridge()

    await shutdownAndWait(bridge, 100)

    // Still sends the graceful shutdown, but no launchctl on non-macOS.
    expect((bridge as any)._sentMessages).toEqual([{ cmd: 'shutdown' }])
    expect(execSyncCalls.length).toBe(0)

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })
})
