/**
 * What a crash leaves behind.
 *
 * The server had no `uncaughtException` or `unhandledRejection` handler and
 * never called `flushLogs()`, so a crash reached stderr only and the log file
 * ended at the last healthy line -- indistinguishable from a clean shutdown.
 * Worse, the logger buffers non-ERROR lines for up to 500 ms, so the run-up
 * that explains the crash was still in memory when the process died.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { flushLogs, log, logWeb, _resetForTest as resetLoggerForTest } from '../logger'
import {
  applyMachineIdentity,
  egressAuthHeaderProvider,
  initServerEgress,
  installCrashHandlers,
  _setExitForTest,
} from '../process-logging'
import { _getBufferLengthForTest, _resetEgressForTest } from '@ion/shared/log-egress'
import { defaultEgressServiceName, setEgressProcess } from '@ion/shared/log-egress-process'
import { defaultLoggingConfig, type ServerLoggingConfig } from '../config/logging-config'

let dir: string
let prevDataDir: string | undefined

/** Every line in server.jsonl, parsed. */
function lines(): Array<{ level: string; msg: string; tag?: string; fields: Record<string, unknown> }> {
  const raw = readFileSync(join(dir, 'server.jsonl'), 'utf-8').trim()
  return raw === '' ? [] : raw.split('\n').map((l) => JSON.parse(l) as never)
}

beforeEach(() => {
  prevDataDir = process.env.ION_DATA_DIR
  dir = mkdtempSync(join(tmpdir(), 'ion-process-logging-'))
  process.env.ION_DATA_DIR = dir
  resetLoggerForTest()
})

afterEach(() => {
  process.removeAllListeners('uncaughtException')
  process.removeAllListeners('unhandledRejection')
  _setExitForTest(null)
  resetLoggerForTest()
  if (prevDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = prevDataDir
  rmSync(dir, { recursive: true, force: true })
})

describe('crash handlers', () => {
  it('writes the exception and its stack, drains the buffer, and exits 1', async () => {
    const exits: number[] = []
    _setExitForTest((code) => exits.push(code))
    installCrashHandlers()

    // An INFO line stays in the 500ms buffer: this is the run-up that used to
    // die with the process.
    log('boot', 'the last thing that happened before the crash')

    const err = new Error('socket exploded')
    process.emit('uncaughtException', err)
    await vi.waitFor(() => expect(exits).toEqual([1]), { timeout: 2_000, interval: 10 })

    const written = lines()
    const crash = written.find((l) => l.msg === 'uncaught exception; exiting')
    expect(crash?.level).toBe('ERROR')
    expect(crash?.fields.error).toBe('socket exploded')
    expect(String(crash?.fields.stack)).toContain('socket exploded')
    expect(written.some((l) => l.msg === 'the last thing that happened before the crash')).toBe(true)
  })

  it('records an unhandled rejection the same way', async () => {
    const exits: number[] = []
    _setExitForTest((code) => exits.push(code))
    installCrashHandlers()

    process.emit('unhandledRejection', new Error('promise gave up'), Promise.resolve())
    await vi.waitFor(() => expect(exits).toEqual([1]), { timeout: 2_000, interval: 10 })

    const rejection = lines().find((l) => l.msg === 'unhandled promise rejection; exiting')
    expect(rejection?.level).toBe('ERROR')
    expect(rejection?.fields.error).toBe('promise gave up')
  })

  it('records a rejection that was not thrown as an Error', async () => {
    const exits: number[] = []
    _setExitForTest((code) => exits.push(code))
    installCrashHandlers()

    process.emit('unhandledRejection', 'just a string', Promise.resolve())
    await vi.waitFor(() => expect(exits).toEqual([1]), { timeout: 2_000, interval: 10 })

    const rejection = lines().find((l) => l.msg === 'unhandled promise rejection; exiting')
    expect(rejection?.fields.error).toBe('just a string')
  })
})

describe('machine identity', () => {
  it('stamps host and machine id onto every later line', () => {
    applyMachineIdentity({ host: 'studio-host', machineId: 'MID-1', mdmDeviceId: 'DEV-9', mdmSerial: '' })
    log('after', 'a line written once the identity is known')
    flushLogs() // INFO lines sit in the 500ms buffer until something drains them.

    const written = lines()
    const line = written.find((l) => l.msg === 'a line written once the identity is known')
    expect(line?.fields.host).toBe('studio-host')
    expect(line?.fields.machine_id).toBe('MID-1')
    expect(line?.fields.mdm_device_id).toBe('DEV-9')
    // An empty value is omitted entirely, never written as "".
    expect(line?.fields).not.toHaveProperty('mdm_serial')
  })
})

describe('server log shipping', () => {
  beforeEach(() => {
    _resetEgressForTest()
    setEgressProcess('server')
  })
  afterEach(() => {
    _resetEgressForTest()
    setEgressProcess('server')
  })

  it('ships nothing until an operator configures it', () => {
    initServerEgress(defaultLoggingConfig(), async () => ({ ok: true }))
    log('after', 'a line with nowhere to go')
    expect(_getBufferLengthForTest()).toBe(0)
  })

  it('carries this server\'s own lines, and the browser lines it records', async () => {
    // The gap this closes: server.jsonl was the one surface nothing collected,
    // so a container's logs died with the pod.
    initServerEgress(
      { egress: { egressTargets: ['http'], egressEndpoint: 'https://sink/logs' }, shipSources: ['server'], tokenScope: '' },
      async () => ({ ok: true }),
    )

    // initServerEgress logs its own decision, and that line ships too, so
    // measure what the two lines below add rather than the absolute count.
    const before = _getBufferLengthForTest()
    log('boot', 'a server line')
    logWeb('WARN', 'web:boot', 'a browser line')

    expect(_getBufferLengthForTest() - before).toBe(2)
  })

  it('names the service after the server, so its lines are not attributed to a desktop', () => {
    initServerEgress(
      { egress: { egressTargets: ['otel'], egressOtel: { endpoint: 'https://otlp' } }, shipSources: ['server'], tokenScope: '' },
      async () => ({ ok: true }),
    )
    expect(defaultEgressServiceName()).toBe('ion-server')
  })

  it('asks the engine for a token when a scope is configured', async () => {
    const asked: string[] = []
    const logging: ServerLoggingConfig = {
      egress: { egressTargets: ['http'], egressEndpoint: 'https://sink' },
      shipSources: ['server'],
      tokenScope: 'api://ion/Telemetry.Write',
    }
    const headers = egressAuthHeaderProvider(logging, async (scope) => {
      asked.push(scope)
      return { ok: true, data: { accessToken: 'tok-1' } }
    })

    await expect(headers()).resolves.toEqual({ Authorization: 'Bearer tok-1' })
    expect(asked).toEqual(['api://ion/Telemetry.Write'])
  })

  it('ships without authorization when the engine cannot mint a token', async () => {
    // A sink that wants no auth keeps working, and one that does answers 401 --
    // either is better than the server giving up on logging.
    const logging: ServerLoggingConfig = {
      egress: { egressTargets: ['http'], egressEndpoint: 'https://sink' },
      shipSources: ['server'],
      tokenScope: 'api://ion/Telemetry.Write',
    }
    await expect(egressAuthHeaderProvider(logging, async () => ({ ok: false, error: 'not signed in' }))()).resolves.toEqual({})
    await expect(egressAuthHeaderProvider(logging, async () => { throw new Error('bridge down') })()).resolves.toEqual({})
  })

  it('asks for no token when no scope is configured', async () => {
    const asked: string[] = []
    const logging = { ...defaultLoggingConfig(), egress: { egressTargets: ['http'] } }
    await expect(egressAuthHeaderProvider(logging, async (s) => { asked.push(s); return { ok: true } })()).resolves.toEqual({})
    expect(asked).toEqual([])
  })
})
