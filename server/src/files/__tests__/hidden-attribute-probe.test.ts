/**
 * The hidden-attribute probe must never stop the event loop and must never
 * start a process per listing.
 *
 * The listing it serves is asked for per open folder. The probe this
 * replaces started PowerShell synchronously on every one, so an Explorer
 * with several folders open froze the server for the length of several
 * PowerShell starts, every time it refreshed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { createHiddenAttributeProbe, PROBE_READY_LINE, type HiddenAttributeProbe } from '../hidden-attribute-probe'

interface FakeHelper extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  unref: () => void
}

/**
 * A helper that answers each request line through `answer`, or stays silent
 * when it returns null. It reports ready at once unless `silentStart` is
 * set; then `helper.ready()` reports it, and answers to requests written
 * before that are held until then, as a shell still starting holds them.
 */
function fakeSpawn(answer: (id: string, directory: string) => string | null, { silentStart = false } = {}) {
  const helpers: Array<FakeHelper & { ready: () => void }> = []
  const spawn = vi.fn(() => {
    const helper = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 4242 + helpers.length,
      unref: () => undefined,
      ready: () => {
        helper.stdout.write(`${PROBE_READY_LINE}\n`)
        running = true
        for (const reply of held.splice(0)) helper.stdout.write(`${reply}\n`)
      },
    }) as FakeHelper & { ready: () => void }
    let running = false
    const held: string[] = []
    if (!silentStart) helper.ready()
    let buffered = ''
    helper.stdin.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf-8')
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        const [id, encoded] = line.split(' ')
        const reply = answer(id, Buffer.from(encoded, 'base64').toString('utf-8'))
        if (reply === null) continue
        if (running) helper.stdout.write(`${reply}\n`)
        else held.push(reply)
      }
    })
    helper.stdin.on('end', () => helper.emit('exit', 0, null))
    helpers.push(helper)
    return helper
  })
  return { spawn, helpers }
}

const ok = (id: string, names: string[]): string => `${id} ok ${Buffer.from(names.join('\n'), 'utf-8').toString('base64')}`

const probes: HiddenAttributeProbe[] = []
const dirs: string[] = []
afterEach(() => {
  for (const probe of probes.splice(0)) probe.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

function probeWith(deps: Parameters<typeof createHiddenAttributeProbe>[0]): HiddenAttributeProbe {
  const probe = createHiddenAttributeProbe(deps)
  probes.push(probe)
  return probe
}

describe('hidden attribute probe', () => {
  it('starts no process at all off Windows', async () => {
    const { spawn } = fakeSpawn(() => null)
    const probe = probeWith({ platform: 'darwin', spawn: spawn as never })
    expect(await probe.hiddenNames('/work')).toEqual(new Set())
    expect(spawn).not.toHaveBeenCalled()
  })

  it('answers every listing from one helper process', async () => {
    const { spawn } = fakeSpawn((id, directory) => ok(id, directory.endsWith('Users') ? ['AppData', 'Überwachung'] : []))
    const probe = probeWith({ platform: 'win32', spawn: spawn as never })
    const [first, second, third] = await Promise.all([
      probe.hiddenNames('C:\\Users'),
      probe.hiddenNames('C:\\Users\\repo'),
      probe.hiddenNames('C:\\Users'),
    ])
    expect(first).toEqual(new Set(['AppData', 'Überwachung']))
    expect(second).toEqual(new Set())
    expect(third).toEqual(first)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('renders a directory unhidden when the helper reports an error for it', async () => {
    const { spawn } = fakeSpawn((id) => `${id} err ${Buffer.from('Access denied').toString('base64')}`)
    const probe = probeWith({ platform: 'win32', spawn: spawn as never })
    expect(await probe.hiddenNames('C:\\locked')).toEqual(new Set())
  })

  it('gives up on a silent helper after the timeout instead of holding the listing', async () => {
    vi.useFakeTimers()
    const { spawn } = fakeSpawn(() => null)
    const probe = probeWith({ platform: 'win32', spawn: spawn as never, requestTimeoutMs: 1_000 })
    const answer = probe.hiddenNames('C:\\slow')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await answer).toEqual(new Set())
  })

  it('does not count a slow helper start against the answer wait', async () => {
    vi.useFakeTimers()
    const { spawn, helpers } = fakeSpawn((id, directory) => ok(id, directory.endsWith('Users') ? ['AppData'] : []), { silentStart: true })
    const probe = probeWith({ platform: 'win32', spawn: spawn as never, requestTimeoutMs: 1_000, startTimeoutMs: 10_000 })
    let settled = false
    const answer = probe.hiddenNames('C:\\Users').then((names) => { settled = true; return names })
    // Longer than the answer wait, but the helper is still starting.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(settled).toBe(false)
    helpers[0].ready()
    expect(await answer).toEqual(new Set(['AppData']))
  })

  it('stops a helper that never reports ready and answers its listings', async () => {
    vi.useFakeTimers()
    const { spawn, helpers } = fakeSpawn(() => null, { silentStart: true })
    const probe = probeWith({ platform: 'win32', spawn: spawn as never, requestTimeoutMs: 1_000, startTimeoutMs: 10_000 })
    const ended = vi.fn()
    const answer = probe.hiddenNames('C:\\a')
    helpers[0].stdin.on('finish', ended)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await answer).toEqual(new Set())
    expect(ended).toHaveBeenCalled()
  })

  it('answers waiting listings when the helper dies, and does not restart it per listing', async () => {
    let at = 0
    const { spawn, helpers } = fakeSpawn(() => null)
    const probe = probeWith({ platform: 'win32', spawn: spawn as never, restartGapMs: 5_000, now: () => at })
    const waiting = probe.hiddenNames('C:\\a')
    helpers[0].emit('exit', 1, null)
    expect(await waiting).toEqual(new Set())

    at = 1_000
    expect(await probe.hiddenNames('C:\\b')).toEqual(new Set())
    expect(spawn).toHaveBeenCalledTimes(1)

    at = 6_000
    void probe.hiddenNames('C:\\c')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('stops an idle helper and starts a new one on the next listing', async () => {
    vi.useFakeTimers()
    let at = 0
    const { spawn, helpers } = fakeSpawn((id) => ok(id, []))
    const probe = probeWith({ platform: 'win32', spawn: spawn as never, idleExitMs: 60_000, restartGapMs: 0, now: () => at })
    await probe.hiddenNames('C:\\a')
    const ended = vi.fn()
    helpers[0].stdin.on('finish', ended)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ended).toHaveBeenCalled()
    at = 61_000
    await probe.hiddenNames('C:\\a')
    expect(spawn).toHaveBeenCalledTimes(2)
  })
})

/**
 * The real program, run by a real PowerShell. On Windows the attribute is
 * set with `attrib`; elsewhere .NET reports a dot-prefixed name as hidden,
 * which exercises the same program end to end.
 */
const realShell = process.platform === 'win32'
  ? 'powershell.exe'
  : (spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0 ? 'pwsh' : null)

describe.skipIf(realShell === null)('hidden attribute probe against a real PowerShell', () => {
  it('names exactly the hidden entries, including a name outside ASCII', { timeout: 60_000 }, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ion-hidden-probe-')))
    dirs.push(dir)
    const hidden = process.platform === 'win32' ? ['secret.txt', 'Überwachung'] : ['.secret.txt', '.Überwachung']
    writeFileSync(join(dir, hidden[0]), 'x')
    mkdirSync(join(dir, hidden[1]))
    writeFileSync(join(dir, 'plain.txt'), 'x')
    mkdirSync(join(dir, 'src'))
    if (process.platform === 'win32') for (const name of hidden) execFileSync('attrib', ['+h', join(dir, name)])

    const probe = probeWith({ platform: 'win32', shell: realShell ?? undefined })
    expect(await probe.hiddenNames(dir)).toEqual(new Set(hidden))
    // A second listing is answered by the helper that is already running.
    expect(await probe.hiddenNames(join(dir, 'src'))).toEqual(new Set())
    expect(await probe.hiddenNames(join(dir, 'does-not-exist'))).toEqual(new Set())
  })
})
