/**
 * A main-process crash used to leave nothing in desktop.jsonl: Electron shows
 * a dialog and keeps running, and an unhandled rejection only reached the
 * console. desktop/AGENTS.md told readers to diagnose a boot crash from that
 * file, which nothing wrote to.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const logger = vi.hoisted(() => ({ error: vi.fn(), flushLogs: vi.fn() }))
vi.mock('../logger', () => logger)
vi.mock('electron', () => ({ dialog: { showErrorBox: vi.fn() } }))

import { installMainCrashLogging, _setShowErrorForTest } from '../crash-logging'

const shown: Array<[string, string]> = []

beforeEach(() => {
  logger.error.mockClear()
  logger.flushLogs.mockClear()
  shown.length = 0
  _setShowErrorForTest((title, content) => shown.push([title, content]))
})

afterEach(() => {
  process.removeAllListeners('uncaughtException')
  process.removeAllListeners('unhandledRejection')
  _setShowErrorForTest(null)
})

describe('installMainCrashLogging', () => {
  it('records an uncaught exception with its stack and drains the buffer', () => {
    installMainCrashLogging()
    const err = new Error('main thread exploded')
    process.emit('uncaughtException', err)

    expect(logger.error).toHaveBeenCalledWith('crash', 'uncaught exception in the main process', expect.objectContaining({
      error: 'main thread exploded',
      error_name: 'Error',
      stack: expect.stringContaining('main thread exploded'),
    }))
    // The run-up sits in the logger's 500ms buffer; without this it dies with
    // the process.
    expect(logger.flushLogs).toHaveBeenCalledOnce()
  })

  it('still shows the operator the dialog Electron would have shown', () => {
    // Installing a handler suppresses Electron's own dialog, so the visible
    // behaviour has to be put back deliberately.
    installMainCrashLogging()
    process.emit('uncaughtException', new Error('visible failure'))

    expect(shown).toHaveLength(1)
    expect(shown[0][0]).toBe('A JavaScript error occurred in the main process')
    expect(shown[0][1]).toContain('visible failure')
  })

  it('records an unhandled rejection without a dialog', () => {
    installMainCrashLogging()
    process.emit('unhandledRejection', new Error('promise gave up'), Promise.resolve())

    expect(logger.error).toHaveBeenCalledWith('crash', 'unhandled promise rejection in the main process', expect.objectContaining({
      error: 'promise gave up',
    }))
    expect(logger.flushLogs).toHaveBeenCalledOnce()
    expect(shown).toEqual([])
  })

  it('records a rejection that was not an Error', () => {
    installMainCrashLogging()
    process.emit('unhandledRejection', 'just a string', Promise.resolve())

    expect(logger.error).toHaveBeenCalledWith('crash', 'unhandled promise rejection in the main process', expect.objectContaining({
      error: 'just a string',
    }))
  })
})
