/**
 * TerminalManager.relaunch: a launch that reuses a terminal stops everything
 * the old shell ran, then starts a fresh shell under the same key.
 *
 * The contract these rows pin:
 *   - every process under the shell is signalled, not only the shell
 *   - a process that ignores the polite signal is force-killed
 *   - clients hear TERMINAL_RESTARTED, never the old shell's TERMINAL_EXIT
 *     (Studio respawns a shell on exit, which would race the relaunch)
 *   - the old shell's trailing output never reaches the new transcript
 *   - a client create racing the relaunch cannot win with its older cwd
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ scrollback: new Map<string, string>() }))

vi.mock('../../cli-env', () => ({
  getCliEnv: (extra?: Record<string, string>) => ({ PATH: '/usr/bin', ...extra }),
}))
vi.mock('../../deeplink/token', () => ({ getDeepLinkToken: () => 'token' }))
vi.mock('../../state', () => ({ terminalScrollback: mocks.scrollback }))
vi.mock('../terminal-spawn-helper', () => ({
  describeSpawnHelper: () => ({ path: '/helper', exists: true, executable: true }),
  ensureSpawnHelperExecutable: () => ({ status: { path: '/helper', exists: true, executable: true }, repaired: false }),
  spawnHelperHint: () => null,
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: () => true }
})

import { TerminalManager } from '../terminal-manager'
import { parseProcessTree } from '../terminal-process-tree'
import type { TerminalStopDeps } from '../terminal-stop'

interface FakePty {
  pid: number
  cwd: string
  kills: Array<string | undefined>
  fireData: (d: string) => void
  fireExit: (code: number) => void
}

const KEY = 'tab-a:inst-1'

let ptys: FakePty[] = []
let spawnFailure: Error | null = null
/** When false, a SIGHUP'd shell stays up until SIGKILL. */
let shellExitsOnHangup = true

function fakeSpawner() {
  return (_file: string, _args: string[], options: { cwd: string }) => {
    if (spawnFailure) throw spawnFailure
    let onData: ((d: string) => void) | null = null
    let onExit: ((e: { exitCode: number }) => void) | null = null
    const fake: FakePty & Record<string, unknown> = {
      pid: 100 + ptys.length,
      cwd: options.cwd,
      kills: [],
      fireData: (d) => onData?.(d),
      fireExit: (code) => onExit?.({ exitCode: code }),
      onData: (cb: (d: string) => void) => { onData = cb },
      onExit: (cb: (e: { exitCode: number }) => void) => { onExit = cb },
      write: () => {},
      resize: () => {},
      kill: (sig?: string) => {
        fake.kills.push(sig)
        if (shellExitsOnHangup || sig === 'SIGKILL') queueMicrotask(() => fake.fireExit(129))
      },
    }
    ptys.push(fake)
    return fake as never
  }
}

/** A process table in which `shellPid` runs npm, which runs node. */
function fakeTree(opts: { stubborn?: number[] } = {}) {
  const alive = new Set([501, 502])
  const signals: Array<[number, string]> = []
  const deps = (shellPid: number): TerminalStopDeps => ({
    readSnapshot: async () => parseProcessTree(`${shellPid} 1 zsh\n501 ${shellPid} npm\n502 501 node\n`),
    signal: (pid, sig) => {
      signals.push([pid, sig])
      if (sig === 'SIGKILL' || !opts.stubborn?.includes(pid)) alive.delete(pid)
      return true
    },
    isAlive: (pid) => alive.has(pid),
    sleep: () => Promise.resolve(),
    graceMs: 300,
    forceWaitMs: 200,
  })
  return { deps, signals, alive }
}

function makeManager() {
  const sent: Array<[string, unknown[]]> = []
  const manager = new TerminalManager((channel, ...args) => {
    sent.push([channel, args])
    if (channel === 'ion:terminal-incoming') {
      const [key, data] = args as [string, string]
      mocks.scrollback.set(key, (mocks.scrollback.get(key) ?? '') + data)
    }
  }, fakeSpawner(), () => false)
  return { manager, sent }
}

beforeEach(() => {
  mocks.scrollback.clear()
  ptys = []
  spawnFailure = null
  shellExitsOnHangup = true
})

describe('TerminalManager.relaunch', () => {
  it('stops the whole tree, then starts a fresh shell in the new directory', async () => {
    const { manager, sent } = makeManager()
    manager.create(KEY, '/old')
    ptys[0].fireData('old run output')
    const tree = fakeTree()
    manager.stopDeps = tree.deps(ptys[0].pid)

    await manager.relaunch(KEY, '/new')

    expect(tree.signals).toEqual([[501, 'SIGTERM'], [502, 'SIGTERM']])
    expect(ptys[0].kills).toEqual([undefined])
    expect(ptys).toHaveLength(2)
    expect(ptys[1].cwd).toBe('/new')
    const info = manager.attach(KEY)
    expect(info.running).toBe(true)
    expect(info.history).toBe('')
    expect(sent.filter(([channel]) => channel === 'ion:terminal-restarted')).toEqual([['ion:terminal-restarted', [KEY, null]]])
    expect(sent.some(([channel]) => channel === 'ion:terminal-exit')).toBe(false)
  })

  it('force-kills a process that ignores the polite signal', async () => {
    const { manager } = makeManager()
    manager.create(KEY, '/old')
    const tree = fakeTree({ stubborn: [502] })
    manager.stopDeps = tree.deps(ptys[0].pid)

    await manager.relaunch(KEY, '/old')

    expect(tree.signals).toContainEqual([502, 'SIGKILL'])
    expect(tree.signals).not.toContainEqual([501, 'SIGKILL'])
    expect(tree.alive.size).toBe(0)
  })

  it('force-kills a shell that survives its hangup', async () => {
    shellExitsOnHangup = false
    const { manager } = makeManager()
    manager.create(KEY, '/old')
    manager.stopDeps = fakeTree().deps(ptys[0].pid)

    await manager.relaunch(KEY, '/old')

    expect(ptys[0].kills).toEqual([undefined, 'SIGKILL'])
    expect(manager.attach(KEY).running).toBe(true)
  })

  it('keeps the old shell\'s trailing output out of the new transcript', async () => {
    const { manager, sent } = makeManager()
    manager.create(KEY, '/old')
    manager.stopDeps = fakeTree().deps(ptys[0].pid)
    await manager.relaunch(KEY, '/new')

    ptys[0].fireData('late output from the old shell')
    ptys[1].fireData('$ ')

    expect(manager.attach(KEY).history).toBe('$ ')
    expect(sent.filter(([channel]) => channel === 'ion:terminal-incoming').map(([, args]) => args[1])).toEqual(['$ '])
  })

  it('refuses a client create that races the relaunch', async () => {
    const { manager } = makeManager()
    manager.create(KEY, '/old')
    manager.stopDeps = fakeTree().deps(ptys[0].pid)

    const running = manager.relaunch(KEY, '/new')
    manager.create(KEY, '/old')
    expect(manager.attach(KEY, { restartIfNotRunning: true, cwd: '/old' }).running).toBe(false)
    await running

    expect(ptys.map((p) => p.cwd)).toEqual(['/old', '/new'])
  })

  it('starts a shell when the key has none running', async () => {
    const { manager, sent } = makeManager()

    await manager.relaunch(KEY, '/new')

    expect(ptys.map((p) => p.cwd)).toEqual(['/new'])
    expect(sent).toContainEqual(['ion:terminal-restarted', [KEY, null]])
  })

  it('rejects, and tells clients why, when the new shell cannot start', async () => {
    const { manager, sent } = makeManager()
    manager.create(KEY, '/old')
    manager.stopDeps = fakeTree().deps(ptys[0].pid)
    spawnFailure = new Error('posix_spawnp failed.')

    await expect(manager.relaunch(KEY, '/new')).rejects.toThrow('posix_spawnp failed.')

    expect(sent).toContainEqual(['ion:terminal-restarted', [KEY, 'Error: posix_spawnp failed.']])
    expect(manager.attach(KEY).startError).toBe('Error: posix_spawnp failed.')
  })
})
