/**
 * The server must apply `server.json`'s `logLevel` at boot.
 *
 * ── The failure this pins ───────────────────────────────────────────────────
 * `config/server-config.ts` parsed `logLevel` (defaulting to DEBUG) and nothing
 * ever applied it. `logger.ts`'s `minLevel` stayed at its compiled-in INFO for
 * the life of the process, so a deployment configured for DEBUG wrote 2916
 * INFO, 423 WARN, 7 ERROR -- and zero DEBUG.
 *
 * The cost is not verbosity. Every diagnostic at DEBUG -- studio-wire fan-out
 * decisions, snapshot hydration, queued user-turn echoes -- was discarded
 * before reaching the file, and their ABSENCE reads as "that code path never
 * ran". It sent a live investigation after the wrong cause twice.
 *
 * Two assertions, because either alone still passes while the defect is
 * present: the mechanism gates emission, and boot is wired to the CONFIG's
 * level rather than the desktop settings file's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const serverSrc = join(dirname(fileURLToPath(import.meta.url)), '..')
let dir: string
let prevDataDir: string | undefined

beforeEach(() => {
  prevDataDir = process.env.ION_DATA_DIR
  dir = mkdtempSync(join(tmpdir(), 'ion-log-level-'))
  process.env.ION_DATA_DIR = dir
})

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = prevDataDir
  rmSync(dir, { recursive: true, force: true })
})

function written(): string {
  const path = join(dir, 'server.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf-8') : ''
}

describe('server log level', () => {
  it('wires boot to the parsed config level, from server.json', () => {
    const main = readFileSync(join(serverSrc, 'main.ts'), 'utf-8')

    expect(main, 'main.ts must apply the configured level at boot').toMatch(/setLogLevel\(\s*config\.logLevel\s*\)/)

    // The desktop resolver reads settings.json -- a different file with a
    // different owner. Reusing it here would silently ignore server.json.
    //
    // Matched as a CALL, not a substring: the comment above the real wiring
    // names this function to explain why it is not used, and a bare
    // `includes()` matched that prose and failed on correct code.
    const callsDesktopResolver = /(?<!#)\bapplyConfiguredLogLevel\s*\(/.test(
      main.split('\n').filter((line) => !/^\s*(\*|\/\/)/.test(line)).join('\n'),
    )
    expect(callsDesktopResolver, 'main.ts must not resolve its level from the desktop settings file').toBe(false)
  })

  it('suppresses DEBUG at INFO and emits it at DEBUG', async () => {
    const logger = await import('../logger')
    logger._resetForTest()
    logger.configureLogger({ disableRotation: true })

    logger.setLogLevel('INFO')
    logger.debug('probe', 'debug-while-info')
    logger.log('probe', 'info-while-info')
    logger.flushLogs()
    expect(written()).not.toContain('debug-while-info')
    expect(written()).toContain('info-while-info')

    logger.setLogLevel('DEBUG')
    logger.debug('probe', 'debug-while-debug')
    logger.flushLogs()
    expect(written()).toContain('debug-while-debug')
  })
})
