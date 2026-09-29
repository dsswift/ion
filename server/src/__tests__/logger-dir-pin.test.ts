/**
 * `configureLogger({ dir })` pins where server.jsonl is written, whatever
 * ION_DATA_DIR says, and `_resetForTest()` clears the pin.
 *
 * The test setup relies on this: many tests point ION_DATA_DIR at a temp
 * directory and delete it in afterEach, and the logger's async append into
 * that directory could land mid-delete and fail the run with ENOTEMPTY.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { configureLogger, flushLogs, log, _resetForTest } from '../logger'

let pinned: string
let dataDir: string
let prevDataDir: string | undefined

beforeEach(() => {
  prevDataDir = process.env.ION_DATA_DIR
  pinned = mkdtempSync(join(tmpdir(), 'ion-log-pin-'))
  dataDir = mkdtempSync(join(tmpdir(), 'ion-log-data-'))
  process.env.ION_DATA_DIR = dataDir
  _resetForTest()
  configureLogger({ disableRotation: true })
})

afterEach(() => {
  _resetForTest()
  if (prevDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = prevDataDir
  rmSync(pinned, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

const read = (dir: string): string => {
  const path = join(dir, 'server.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf-8') : ''
}

describe('logger directory pin', () => {
  it('writes to the pinned directory, not ION_DATA_DIR', () => {
    configureLogger({ dir: pinned })
    log('probe', 'pinned-line')
    flushLogs()
    expect(read(pinned)).toContain('pinned-line')
    expect(read(dataDir)).toBe('')
  })

  it('follows ION_DATA_DIR again after a reset', () => {
    configureLogger({ dir: pinned })
    _resetForTest()
    log('probe', 'unpinned-line')
    flushLogs()
    expect(read(dataDir)).toContain('unpinned-line')
    expect(read(pinned)).toBe('')
  })
})
