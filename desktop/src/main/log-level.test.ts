import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Log-level resolution pins.
 *
 * THE BUG THIS EXISTS FOR: the DEBUG default was added to SETTINGS_DEFAULTS,
 * but the resolver read `readSettings().logLevel` directly. `readSettings`
 * returns the settings FILE as written — it does not merge defaults — so a key
 * the operator has never toggled is simply absent. On every existing install
 * the resolver saw `undefined`, took the "not recognized" branch, and left
 * logging at INFO.
 *
 * The consequence was not cosmetic: three debugging rounds were spent reading
 * the absence of `rDebug` lines as proof that code had not run, when the lines
 * were merely filtered. The one machine that most needed DEBUG never got it.
 */

const logger = vi.hoisted(() => ({ log: vi.fn(), setLogLevel: vi.fn() }))
vi.mock('./logger', () => ({ log: logger.log, setLogLevel: logger.setLogLevel }))

const settings = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./settings-store', () => ({
  readSettings: settings.read,
  // The real default; the point of these tests is that it is actually applied.
  SETTINGS_DEFAULTS: { logLevel: 'DEBUG' },
}))

import { applyConfiguredLogLevel } from './log-level'

describe('applyConfiguredLogLevel', () => {
  beforeEach(() => {
    logger.log.mockClear()
    logger.setLogLevel.mockClear()
    settings.read.mockReset()
  })

  it('applies the DEBUG default when the key is absent from the settings file', () => {
    // The exact shipped defect: an install that never toggled the setting.
    settings.read.mockReturnValue({ selectedTheme: 'ion-dark' })
    applyConfiguredLogLevel()
    expect(logger.setLogLevel).toHaveBeenCalledWith('DEBUG')
  })

  it('applies the default when settings are empty entirely', () => {
    // readSettings returns {} when the file does not exist yet.
    settings.read.mockReturnValue({})
    applyConfiguredLogLevel()
    expect(logger.setLogLevel).toHaveBeenCalledWith('DEBUG')
  })

  it('honors an explicit operator choice over the default', () => {
    settings.read.mockReturnValue({ logLevel: 'WARN' })
    applyConfiguredLogLevel()
    expect(logger.setLogLevel).toHaveBeenCalledWith('WARN')
  })

  it('accepts every supported level', () => {
    for (const level of ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR']) {
      logger.setLogLevel.mockClear()
      settings.read.mockReturnValue({ logLevel: level })
      applyConfiguredLogLevel()
      expect(logger.setLogLevel).toHaveBeenCalledWith(level)
    }
  })

  it('keeps the current level and says why when the value is unrecognized', () => {
    settings.read.mockReturnValue({ logLevel: 'verbose' })
    applyConfiguredLogLevel()
    expect(logger.setLogLevel).not.toHaveBeenCalled()
    const [, msg] = logger.log.mock.calls[0] as [string, string]
    expect(msg).toContain('not recognized')
  })

  it('applies the default rather than giving up when settings cannot be read', () => {
    // A logger left at its compiled-in level would hide the cause of its own
    // failure, which is the one outcome that must not happen.
    settings.read.mockImplementation(() => { throw new Error('EACCES') })
    applyConfiguredLogLevel()
    expect(logger.setLogLevel).toHaveBeenCalledWith('DEBUG')
  })
})
