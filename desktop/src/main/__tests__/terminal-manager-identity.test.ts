/**
 * Tests for PTY environment identity.
 *
 * Every terminal PTY carries the ids of the conversation and instance it
 * belongs to, plus the deep-link capability token. This is the mechanism that
 * lets a tool run inside a pane (`dev run`) open FURTHER panes in the same
 * conversation — resolved by id, never by which tab happens to be focused, so
 * it still lands correctly after the operator navigates away.
 *
 * Each assertion here is load-bearing rather than incidental:
 *   - `ION_DESKTOP_TAB_ID` is the whole targeting mechanism.
 *   - `ION_DESKTOP_TERMINAL_INSTANCE_ID` is what makes nesting work: a pane
 *     spawned by a tool gets its own id, so a tool inside THAT pane targets
 *     correctly too.
 *   - `ION_DESKTOP_DEEPLINK_TOKEN` is what marks a local request trusted; its
 *     absence would send every `dev run` through a confirmation dialog.
 *   - The first-colon split matters because the ids are concatenated into the
 *     session key.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    userInfo: vi.fn(),
  }
})

// A real PATH probe shells out to zsh; the identity overlay is what is under
// test, so the base env is stubbed to a fixed value.
vi.mock('../cli-env', () => ({
  getCliEnv: (extra?: Record<string, string>) => ({ PATH: '/usr/bin', ...extra }),
}))

vi.mock('../deeplink/token', () => ({
  getDeepLinkToken: () => 'test-token-value',
}))

vi.mock('../state', () => ({ terminalScrollback: new Map<string, string>() }))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  // Every cwd resolves, so the manager does not fall back to homedir().
  return { ...actual, existsSync: () => true }
})

import { TerminalManager } from '../terminal-manager'

/** A spawner that records its arguments instead of starting a shell. */
function recordingSpawner() {
  return (file: string, args: string[], options: { env: Record<string, string> }) => {
    mocks.spawn(file, args, options)
    return {
      pid: 123, process: '/bin/zsh',
      onData: () => {}, onExit: () => {}, write: () => {},
      resize: () => {}, kill: () => {},
    } as never
  }
}

function spawnedEnv(index = 0): Record<string, string> {
  const call = mocks.spawn.mock.calls[index]
  return (call[2] as { env: Record<string, string> }).env
}

describe('TerminalManager PTY identity', () => {
  beforeEach(() => {
    mocks.spawn.mockReset()
  })

  it('injects the tab id, instance id, and deep-link token', () => {
    new TerminalManager(() => {}, recordingSpawner()).create('tab-abc:inst-123', '/repo')

    const env = spawnedEnv()
    expect(env.ION_DESKTOP_TAB_ID).toBe('tab-abc')
    expect(env.ION_DESKTOP_TERMINAL_INSTANCE_ID).toBe('inst-123')
    expect(env.ION_DESKTOP_DEEPLINK_TOKEN).toBe('test-token-value')
  })

  it('preserves the base CLI environment alongside the identity overlay', () => {
    new TerminalManager(() => {}, recordingSpawner()).create('tab-abc:inst-123', '/repo')

    // The overlay must not replace the discovered PATH — a pane with no PATH
    // could not run `dev` at all.
    expect(spawnedEnv().PATH).toBe('/usr/bin')
  })

  it('splits on the FIRST colon so a colon in the instance id is preserved', () => {
    new TerminalManager(() => {}, recordingSpawner()).create('tab-abc:inst:with:colons', '/repo')

    const env = spawnedEnv()
    expect(env.ION_DESKTOP_TAB_ID).toBe('tab-abc')
    expect(env.ION_DESKTOP_TERMINAL_INSTANCE_ID).toBe('inst:with:colons')
  })

  it('gives each pane its own identity, so nesting resolves correctly', () => {
    const mgr = new TerminalManager(() => {}, recordingSpawner())
    mgr.create('tab-abc:inst-1', '/repo')
    mgr.create('tab-abc:inst-2', '/repo')

    expect(spawnedEnv(0).ION_DESKTOP_TERMINAL_INSTANCE_ID).toBe('inst-1')
    expect(spawnedEnv(1).ION_DESKTOP_TERMINAL_INSTANCE_ID).toBe('inst-2')
    // Same conversation for both.
    expect(spawnedEnv(1).ION_DESKTOP_TAB_ID).toBe('tab-abc')
  })

  it('uses the account login shell and exports SHELL even when inherited SHELL is /bin/sh', () => {
    vi.mocked(os.userInfo).mockReturnValue({ shell: '/bin/zsh' } as os.UserInfo<string>)
    const inheritedShell = process.env.SHELL
    process.env.SHELL = '/bin/sh'

    try {
      new TerminalManager(() => {}, recordingSpawner()).create('tab-abc:inst-123', '/repo')

      const call = mocks.spawn.mock.calls[0]
      expect(call[0]).toBe('/bin/zsh')
      expect(call[1]).toEqual(['-l'])
      expect(spawnedEnv().SHELL).toBe('/bin/zsh')
    } finally {
      if (inheritedShell === undefined) delete process.env.SHELL
      else process.env.SHELL = inheritedShell
    }
  })

  it('keeps tab activity true until every PTY in that tab becomes idle', () => {
    vi.useFakeTimers()
    const events: Array<{ channel: string; payload: unknown }> = []
    let spawned = 0
    const mgr = new TerminalManager(
      (channel, payload) => events.push({ channel, payload }),
      () => {
        spawned += 1
        return {
          pid: spawned, process: spawned === 2 ? 'build' : '/bin/zsh',
          onData: () => {}, onExit: () => {}, write: () => {},
          resize: () => {}, kill: () => {},
        } as never
      },
    )
    mgr.create('tab-activity:inst-1', '/repo')
    mgr.create('tab-activity:inst-2', '/repo')

    expect(events).toContainEqual({
      channel: 'ion:terminal-activity',
      payload: { key: 'tab-activity:inst-2', tabId: 'tab-activity', active: true },
    })

    mgr.destroy('tab-activity:inst-1')
    expect(events).not.toContainEqual({
      channel: 'ion:terminal-activity',
      payload: { key: 'tab-activity:inst-1', tabId: 'tab-activity', active: false },
    })

    mgr.destroy('tab-activity:inst-2')
    expect(events).toContainEqual({
      channel: 'ion:terminal-activity',
      payload: { key: 'tab-activity:inst-2', tabId: 'tab-activity', active: false },
    })
    vi.useRealTimers()
  })

  it('uses node-pty foreground-process title without process lookup', () => {
    const events: Array<{ channel: string; payload: unknown }> = []
    const mgr = new TerminalManager(
      (channel, payload) => events.push({ channel, payload }),
      () => ({
        pid: 123, process: '/usr/local/bin/build',
        onData: () => {}, onExit: () => {}, write: () => {},
        resize: () => {}, kill: () => {},
      }) as never,
    )

    mgr.create('tab-activity:inst-1', '/repo')

    expect(events).toContainEqual({
      channel: 'ion:terminal-activity',
      payload: { key: 'tab-activity:inst-1', tabId: 'tab-activity', active: true },
    })
    mgr.destroy('tab-activity:inst-1')
  })

  it('self-schedules one future activity check after each probe', () => {
    vi.useFakeTimers()
    let probeCalls = 0
    const mgr = new TerminalManager(
      () => {},
      recordingSpawner(),
      () => {
        probeCalls += 1
        return false
      },
    )

    mgr.create('tab-activity:inst-1', '/repo')
    expect(probeCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(500)
    expect(probeCalls).toBe(2)
    expect(vi.getTimerCount()).toBe(1)

    mgr.destroy('tab-activity:inst-1')
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('stops activity watch on terminal exit and destroy', () => {
    vi.useFakeTimers()
    let probeCalls = 0
    let onExit: ((event: { exitCode: number }) => void) | undefined
    const mgr = new TerminalManager(
      () => {},
      () => ({
        pid: 123, process: '/bin/zsh',
        onData: () => {},
        onExit: (listener: (event: { exitCode: number }) => void) => { onExit = listener },
        write: () => {}, resize: () => {}, kill: () => {},
      }) as never,
      () => {
        probeCalls += 1
        return false
      },
    )

    mgr.create('tab-exit:inst-1', '/repo')
    expect(probeCalls).toBe(1)
    onExit?.({ exitCode: 0 })
    vi.advanceTimersByTime(1000)
    expect(probeCalls).toBe(1)

    mgr.create('tab-destroy:inst-1', '/repo')
    expect(probeCalls).toBe(2)
    mgr.destroy('tab-destroy:inst-1')
    vi.advanceTimersByTime(1000)
    expect(probeCalls).toBe(2)
    vi.useRealTimers()
  })
})
