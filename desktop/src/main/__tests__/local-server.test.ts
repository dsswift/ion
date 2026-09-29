/**
 * local-server: the child-process respawn ladder (spec 12 §Acceptance
 * Criteria "Local server test"). A fake child that exits five times drives
 * `offline{server_unreachable}`; `restart()` re-arms the ladder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

const electronApp = vi.hoisted(() => ({ isPackaged: false, getAppPath: () => '/fake/app' }))
vi.mock('electron', () => ({ app: electronApp }))
vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }))
const logger = vi.hoisted(() => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../logger', () => logger)

import { LocalServerSupervisor, resolveServerEntryPath } from '../local-server'

/**
 * A real piped child emits 'exit' and then 'close', the latter once stdout and
 * stderr have drained. The supervisor listens for 'close', so these tests
 * drive that.
 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn(() => true)

  /**
   * End the way a real piped child does: 'exit' when the process goes, then
   * 'close' once stdout and stderr have drained. `waitForExit()` listens for
   * the first; the respawn ladder for the second, so that a crash's last
   * stderr lines are in hand before the exit is reported.
   */
  end(code: number | null, signal: string | null = null): void {
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
}

function makeSpawnFn() {
  const children: FakeChild[] = []
  const spawnFn = vi.fn(() => {
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ReturnType<typeof import('child_process').spawn>
  })
  return { spawnFn, children }
}

describe('LocalServerSupervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    for (const fn of Object.values(logger)) fn.mockClear()
  })

  it('hands the child the bundled Visualizer theme-pack directory', () => {
    const { spawnFn } = makeSpawnFn()
    const supervisor = new LocalServerSupervisor({ entryPath: '/fake/server/main.js', spawnFn: spawnFn as unknown as typeof import('child_process').spawn })
    supervisor.start()
    const env = (spawnFn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env
    expect(env.ION_STUDIO_THEMES_BUNDLED_DIR).toBe('/fake/app/resources/studio/themes')
    expect(env.ION_SUPERVISOR_PID).toBe(String(process.pid))
    // The built-in server is its owner's own install: without this a second
    // laptop paired to it saw none of the owner's conversations.
    expect(env.ION_STUDIO_PROFILE).toBe('personal')
    expect(env.ION_HOST_APP_VERSION).toBeUndefined()
    supervisor.stop()
  })

  it('tells the server which desktop version runs it', () => {
    const { spawnFn } = makeSpawnFn()
    const supervisor = new LocalServerSupervisor({ entryPath: '/fake/server/main.js', hostAppVersion: '1.101.0', spawnFn: spawnFn as unknown as typeof import('child_process').spawn })
    supervisor.start()
    const env = (spawnFn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env
    expect(env.ION_HOST_APP_VERSION).toBe('1.101.0')
    supervisor.stop()
  })

  it('reports offline after five exits within the five-minute window, and restart re-arms the ladder', async () => {
    const { spawnFn, children } = makeSpawnFn()
    const supervisor = new LocalServerSupervisor({ entryPath: '/fake/server/main.js', spawnFn: spawnFn as unknown as typeof import('child_process').spawn })
    const offline = vi.fn()
    supervisor.on('offline', offline)

    supervisor.start()
    expect(spawnFn).toHaveBeenCalledTimes(1)

    // Ladder: 1s, 2s, 4s, 8s, 8s(capped) -- five retries (matching the
    // Broker's identical ladder shape, see connections/__tests__/broker.test.ts);
    // the sixth failure (which never schedules another retry) lands on offline.
    for (let i = 0; i < 5; i++) {
      children[i].end(1, null)
      await vi.advanceTimersByTimeAsync(8000)
    }
    expect(spawnFn).toHaveBeenCalledTimes(6)
    expect(offline).not.toHaveBeenCalled()

    children[5].end(1, null)
    expect(offline).toHaveBeenCalledTimes(1)
    expect(offline).toHaveBeenCalledWith('exit code 1')
    // No further spawn scheduled once offline.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawnFn).toHaveBeenCalledTimes(6)

    supervisor.restart()
    expect(spawnFn).toHaveBeenCalledTimes(7)
  })

  it('does not respawn after a deliberate stop(), which asks nicely first', async () => {
    const { spawnFn, children } = makeSpawnFn()
    const supervisor = new LocalServerSupervisor({ entryPath: '/fake/server/main.js', spawnFn: spawnFn as unknown as typeof import('child_process').spawn })
    supervisor.start()
    const stopping = supervisor.stop()
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM')
    children[0].end(0, null)
    await stopping
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    expect(spawnFn).toHaveBeenCalledTimes(1)
    expect(supervisor.pid).toBeNull()
  })

  it('kills a child that ignores SIGTERM once the graceful window has passed', async () => {
    const { spawnFn, children } = makeSpawnFn()
    const supervisor = new LocalServerSupervisor({ entryPath: '/fake/server/main.js', spawnFn: spawnFn as unknown as typeof import('child_process').spawn })
    supervisor.start()
    const stopping = supervisor.stop(500)
    await vi.advanceTimersByTimeAsync(600)
    expect(children[0].kill).toHaveBeenLastCalledWith('SIGKILL')
    children[0].end(null, 'SIGKILL')
    await stopping
  })

  it('signal() forwards to the child and waitForExit() resolves on its exit or the timeout', async () => {
    const { spawnFn, children } = makeSpawnFn()
    const supervisor = new LocalServerSupervisor({ entryPath: '/fake/server/main.js', spawnFn: spawnFn as unknown as typeof import('child_process').spawn })
    expect(supervisor.signal('SIGUSR1')).toBe(false)
    supervisor.start()
    expect(supervisor.signal('SIGUSR1')).toBe(true)
    expect(children[0].kill).toHaveBeenCalledWith('SIGUSR1')
    const timedOut = supervisor.waitForExit(100)
    await vi.advanceTimersByTimeAsync(150)
    expect(await timedOut).toBe(false)
    const exited = supervisor.waitForExit()
    children[0].end(0, null)
    expect(await exited).toBe(true)
  })

  it('reports offline immediately when the server entry path cannot be resolved', () => {
    const offline = vi.fn()
    const supervisor = new LocalServerSupervisor({ entryPath: null })
    supervisor.on('offline', offline)
    supervisor.start()
    expect(offline).toHaveBeenCalledWith('server entry not found')
  })

  it('resolves the packaged server entry inside app.asar.unpacked, beside node-pty', () => {
    // The bundle keeps node-pty external, so main.js must sit where Node's
    // upward walk reaches app.asar.unpacked/node_modules. A copy under
    // Resources/server/ has nothing above it and dies on its first import.
    const previous = process.resourcesPath
    electronApp.isPackaged = true
    Object.defineProperty(process, 'resourcesPath', { value: '/Applications/Ion.app/Contents/Resources', configurable: true })
    try {
      expect(resolveServerEntryPath()).toBe(
        '/Applications/Ion.app/Contents/Resources/app.asar.unpacked/dist/server/main.js',
      )
    } finally {
      electronApp.isPackaged = false
      Object.defineProperty(process, 'resourcesPath', { value: previous, configurable: true })
    }
  })

  it('resolves the dev server entry from the workspace root', () => {
    expect(resolveServerEntryPath()).toBe('/fake/server/dist/main.js')
  })

  it('records the child\'s stderr as a warning, not a debug detail', () => {
    // The server logs to its own file, so the only thing reaching this pipe is
    // what its logger could not write -- a crash's stack trace. At DEBUG that
    // was discarded at any level above it, which is every non-dev install.
    const { spawnFn, children } = makeSpawnFn()
    const supervisor = new LocalServerSupervisor({ entryPath: '/fake/server/main.js', spawnFn: spawnFn as unknown as typeof import('child_process').spawn })
    supervisor.start()
    children[0].stderr.emit('data', Buffer.from('Error: socket exploded\n'))

    expect(logger.warn).toHaveBeenCalledWith('local-server', 'local server stderr', { line: 'Error: socket exploded' })
    expect(logger.debug).not.toHaveBeenCalledWith('local-server', 'local server stderr', expect.anything())
  })

  it('reports the last stderr lines with the exit, and drops them for the next child', () => {
    const { spawnFn, children } = makeSpawnFn()
    const supervisor = new LocalServerSupervisor({ entryPath: '/fake/server/main.js', spawnFn: spawnFn as unknown as typeof import('child_process').spawn })
    supervisor.start()
    children[0].stderr.emit('data', Buffer.from('Error: boom\n    at thing()\n'))
    // A crash's final line has no trailing newline. 'close' fires once the
    // pipes have drained, so it is still in hand here; flushing on 'exit'
    // dropped exactly this line -- often the one naming the error.
    children[0].stderr.emit('data', Buffer.from('    at other()'))
    children[0].end(1, null)

    const exitLine = logger.warn.mock.calls.find((c) => c[1] === 'local server exited')
    expect(exitLine?.[2]).toMatchObject({ code: 1, stderr_tail_lines: 3 })
    expect(String(exitLine?.[2].stderr_tail)).toContain('Error: boom')
    expect(String(exitLine?.[2].stderr_tail)).toContain('at other()')

    // The next child starts with a clean slate: a later exit must not report
    // the previous crash's output as its own.
    vi.advanceTimersByTime(60_000)
    children[1].end(0, null)
    const second = logger.warn.mock.calls.filter((c) => c[1] === 'local server exited').at(-1)
    expect(second?.[2]).toMatchObject({ stderr_tail: '', stderr_tail_lines: 0 })
  })

  it('keeps only the last lines of a noisy failure', () => {
    const { spawnFn, children } = makeSpawnFn()
    const supervisor = new LocalServerSupervisor({ entryPath: '/fake/server/main.js', spawnFn: spawnFn as unknown as typeof import('child_process').spawn })
    supervisor.start()
    for (let i = 0; i < 50; i++) children[0].stderr.emit('data', Buffer.from(`line ${i}\n`))
    children[0].end(1, null)

    const exitLine = logger.warn.mock.calls.find((c) => c[1] === 'local server exited')
    expect(exitLine?.[2].stderr_tail_lines).toBe(20)
    expect(String(exitLine?.[2].stderr_tail)).toContain('line 49')
    expect(String(exitLine?.[2].stderr_tail)).not.toContain('line 29')
  })
})
