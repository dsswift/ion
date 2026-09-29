/**
 * The adapter is what every `@ion/server` module desktop main runs logs
 * through, so its job is to forward faithfully to the desktop logger: same
 * tag, same fields, same level. Anything it dropped would be a line that
 * silently left `desktop.jsonl`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const desktopLogger = vi.hoisted(() => ({
  log: vi.fn(),
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  flushLogs: vi.fn(),
}))

vi.mock('../logger', () => desktopLogger)

import {
  log,
  trace,
  debug,
  info,
  warn,
  error,
  logWeb,
  flushLogs,
  setLogLevel,
  initLoggerMachineIdentity,
  configureLogger,
} from '../server-logger-adapter'

describe('server logger adapter', () => {
  beforeEach(() => {
    for (const fn of Object.values(desktopLogger)) fn.mockClear()
  })

  it('forwards each level to the desktop logger with the tag and fields intact', () => {
    log('engine-bootstrap', 'daemon started', { pid: 7 })
    trace('a', 'b')
    debug('c', 'd', { k: 1 })
    info('e', 'f')
    warn('g', 'h', { why: 'x' })
    error('i', 'j', { error: 'boom' })

    expect(desktopLogger.log).toHaveBeenCalledWith('engine-bootstrap', 'daemon started', { pid: 7 })
    expect(desktopLogger.trace).toHaveBeenCalledWith('a', 'b', undefined)
    expect(desktopLogger.debug).toHaveBeenCalledWith('c', 'd', { k: 1 })
    expect(desktopLogger.info).toHaveBeenCalledWith('e', 'f', undefined)
    expect(desktopLogger.warn).toHaveBeenCalledWith('g', 'h', { why: 'x' })
    expect(desktopLogger.error).toHaveBeenCalledWith('i', 'j', { error: 'boom' })
  })

  it('records a web line rather than dropping it, and reports it written', () => {
    expect(logWeb('WARN', 'web:boot', 'slow paint', { ms: 900 })).toBe(true)
    expect(desktopLogger.warn).toHaveBeenCalledWith('web:boot', 'slow paint', { ms: 900 })
  })

  it('drains through the desktop logger', () => {
    flushLogs()
    expect(desktopLogger.flushLogs).toHaveBeenCalledOnce()
  })

  it('leaves level, identity and rotation to the desktop logger that owns the file', () => {
    // A second configuration of one file is the defect these no-ops prevent:
    // desktop main already sets its own level and identity in app-lifecycle.
    setLogLevel('ERROR')
    initLoggerMachineIdentity({ host: 'h', machineId: 'm', mdmDeviceId: '', mdmSerial: '' })
    configureLogger({ disableRotation: true, dir: '/tmp/nope' })
    for (const fn of Object.values(desktopLogger)) expect(fn).not.toHaveBeenCalled()
  })
})
