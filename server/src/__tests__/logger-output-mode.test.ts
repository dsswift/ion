/**
 * `docker logs` on a Studio server was empty: the logger only ever wrote its
 * file, which lives on the volume and dies with the pod. Every container log
 * collector reads stdout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { flushLogs, log, error, _resetForTest as resetLoggerForTest } from '../logger'

let dir: string
let prevDataDir: string | undefined
let prevOutput: string | undefined
let written: string[]
let writeSpy: ReturnType<typeof vi.spyOn>

function fileLines(): string[] {
  const path = join(dir, 'server.jsonl')
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf-8').trim()
  return raw === '' ? [] : raw.split('\n')
}

beforeEach(() => {
  prevDataDir = process.env.ION_DATA_DIR
  prevOutput = process.env.ION_LOG_OUTPUT
  dir = mkdtempSync(join(tmpdir(), 'ion-log-output-'))
  process.env.ION_DATA_DIR = dir
  written = []
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk))
    return true
  })
  resetLoggerForTest()
})

afterEach(() => {
  writeSpy.mockRestore()
  resetLoggerForTest()
  if (prevDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = prevDataDir
  if (prevOutput === undefined) delete process.env.ION_LOG_OUTPUT
  else process.env.ION_LOG_OUTPUT = prevOutput
  rmSync(dir, { recursive: true, force: true })
})

describe('ION_LOG_OUTPUT', () => {
  it('writes only the file by default, so a desktop does not record every line twice', () => {
    delete process.env.ION_LOG_OUTPUT
    log('boot', 'a line')
    flushLogs()

    expect(fileLines().join('')).toContain('a line')
    expect(written).toEqual([])
  })

  it('writes the same line to both when asked, which is what a container needs', () => {
    process.env.ION_LOG_OUTPUT = 'both'
    log('boot', 'a line for the collector')
    flushLogs()

    const onDisk = fileLines()
    expect(onDisk).toHaveLength(1)
    expect(written).toHaveLength(1)
    // Byte-identical: a collector reading stdout and a person reading the file
    // must not be looking at two different records.
    expect(written[0]).toBe(onDisk[0] + '\n')
  })

  it('writes only stdout when asked, leaving no file behind', () => {
    process.env.ION_LOG_OUTPUT = 'stdout'
    log('boot', 'stream only')
    error('boot', 'an error, stream only')
    flushLogs()

    expect(written.join('')).toContain('stream only')
    expect(written.join('')).toContain('an error, stream only')
    expect(fileLines()).toEqual([])
  })

  it('falls back to the file when the value is not one it knows', () => {
    process.env.ION_LOG_OUTPUT = 'syslog'
    log('boot', 'a line')
    flushLogs()

    expect(fileLines().join('')).toContain('a line')
    expect(written).toEqual([])
  })

  it('streams an ERROR line too, which is written synchronously', () => {
    process.env.ION_LOG_OUTPUT = 'both'
    error('boot', 'the diagnostic')

    expect(written.join('')).toContain('the diagnostic')
    expect(fileLines().join('')).toContain('the diagnostic')
  })
})
