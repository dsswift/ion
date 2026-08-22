/**
 * Terminal attach model (D2): snapshot fidelity, exit-code retention,
 * respawn-on-demand, dead-cwd fallback, detach-vs-destroy lifecycle.
 *
 * The contract these rows pin:
 *   - pty EXIT retains scrollback + exit code (dead terminal readable)
 *   - only explicit destroy forgets a terminal
 *   - attach(restartIfNotRunning) respawns a dead/never-created terminal
 *   - a respawn starts a clean transcript (no dead-run history repeat)
 *   - a dead cwd falls back to ~ and reports cwdFellBack
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  scrollback: new Map<string, string>(),
}))

vi.mock('../cli-env', () => ({
  getCliEnv: (extra?: Record<string, string>) => ({ PATH: '/usr/bin', ...extra }),
}))
vi.mock('../deeplink/token', () => ({
  getDeepLinkToken: () => 'test-token-value',
}))
vi.mock('../state', () => ({ terminalScrollback: mocks.scrollback }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  // '/dead' does not exist; everything else does.
  return { ...actual, existsSync: (p: string) => !String(p).includes('/dead') }
})

import { TerminalManager } from '../terminal-manager'

interface FakePty {
  fireData: (d: string) => void
  fireExit: (code: number) => void
  killed: boolean
}

const ptys = new Map<string, FakePty>()

function fakeSpawner() {
  return (_file: string, _args: string[], options: { cwd: string }) => {
    mocks.spawn(options.cwd)
    let onData: ((d: string) => void) | null = null
    let onExit: ((e: { exitCode: number }) => void) | null = null
    const fake: FakePty & Record<string, unknown> = {
      killed: false,
      fireData: (d: string) => onData?.(d),
      fireExit: (code: number) => onExit?.({ exitCode: code }),
      onData: (cb: (d: string) => void) => {
        onData = cb
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        onExit = cb
      },
      write: () => {},
      resize: () => {},
      kill: () => {
        fake.killed = true
      },
    }
    ptys.set(mocks.spawn.mock.calls.length + ':' + options.cwd, fake)
    lastPty = fake
    return fake as never
  }
}

let lastPty: FakePty | null = null

function makeManager(): { manager: TerminalManager; sent: Array<[string, unknown[]]> } {
  const sent: Array<[string, unknown[]]> = []
  const manager = new TerminalManager((channel, ...args) => {
    sent.push([channel, args])
    // Mirror broadcast.ts: TERMINAL_INCOMING accumulates scrollback.
    if (channel === 'ion:terminal-incoming') {
      const [key, data] = args as [string, string]
      mocks.scrollback.set(key, (mocks.scrollback.get(key) ?? '') + data)
    }
  }, fakeSpawner())
  return { manager, sent }
}

beforeEach(() => {
  mocks.spawn.mockReset()
  mocks.scrollback.clear()
  ptys.clear()
  lastPty = null
})

describe('terminal attach model', () => {
  it('attach returns history snapshot + running state', () => {
    const { manager } = makeManager()
    manager.create('studio:t1', '/repo')
    lastPty!.fireData('hello ')
    lastPty!.fireData('world')
    const info = manager.attach('studio:t1')
    expect(info.history).toBe('hello world')
    expect(info.running).toBe(true)
    expect(info.exitCode).toBeNull()
    expect(info.cwdFellBack).toBe(false)
  })

  it('exit retains scrollback + exit code; only destroy forgets', () => {
    const { manager } = makeManager()
    manager.create('studio:t1', '/repo')
    lastPty!.fireData('final output')
    lastPty!.fireExit(3)

    // Dead but readable: attach shows history + exited state.
    const info = manager.attach('studio:t1')
    expect(info.running).toBe(false)
    expect(info.exitCode).toBe(3)
    expect(info.history).toBe('final output')

    // Explicit destroy is the one forgetting path.
    manager.destroy('studio:t1')
    const after = manager.attach('studio:t1')
    expect(after.history).toBe('')
    expect(manager.getLifecycle('studio:t1')).toBeUndefined()
  })

  it('restartIfNotRunning respawns a dead terminal with a clean transcript', () => {
    const { manager } = makeManager()
    manager.create('studio:t1', '/repo')
    lastPty!.fireData('old run')
    lastPty!.fireExit(0)

    const info = manager.attach('studio:t1', { restartIfNotRunning: true })
    expect(info.running).toBe(true)
    // Clean transcript: the dead run's history does not repeat ahead of the
    // new shell.
    expect(info.history).toBe('')
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    // Respawn reuses the recorded cwd.
    expect(mocks.spawn.mock.calls[1][0]).toBe('/repo')
  })

  it('restartIfNotRunning creates a never-created terminal at the given cwd', () => {
    const { manager } = makeManager()
    const info = manager.attach('studio:new', { restartIfNotRunning: true, cwd: '/somewhere' })
    expect(info.running).toBe(true)
    expect(mocks.spawn).toHaveBeenCalledWith('/somewhere')
  })

  it('dead cwd falls back to ~ and reports cwdFellBack', () => {
    const { manager } = makeManager()
    manager.create('studio:t1', '/dead/path')
    const info = manager.attach('studio:t1')
    expect(info.cwdFellBack).toBe(true)
    expect(info.running).toBe(true)
  })

  it('attach without restart never spawns', () => {
    const { manager } = makeManager()
    const info = manager.attach('studio:ghost')
    expect(info.running).toBe(false)
    expect(info.history).toBe('')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
