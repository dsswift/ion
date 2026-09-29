/**
 * A failed log write must not be silent.
 *
 * `flush()` handed `appendFile` a callback that took the error parameter and
 * threw it away. When writing failed the lines were gone with no trace: the
 * file simply had nothing in it for that period, which reads identically to
 * "nothing happened". That is the exact ambiguity AGENTS.md § "No silent
 * failures" exists to prevent, and it cost a live investigation real time —
 * a browser client's forwarded log lines were missing and there was no way
 * to tell a dropped write from a client that never logged.
 *
 * The logger cannot report its own write failure through itself, so the
 * failure goes to stderr and the LOSS is counted and reported as an ERROR
 * line on the first write that succeeds afterwards. This test pins the
 * second half, which is the part that lands in the file an investigator reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, rmdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { warn, _resetForTest as resetLoggerForTest } from '../logger'

let dir: string
let prevDataDir: string | undefined

beforeEach(() => {
  prevDataDir = process.env.ION_DATA_DIR
  dir = mkdtempSync(join(tmpdir(), 'ion-logger-fail-'))
  process.env.ION_DATA_DIR = dir
  resetLoggerForTest()
})

afterEach(() => {
  resetLoggerForTest()
  if (prevDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = prevDataDir
  rmSync(dir, { recursive: true, force: true })
})

describe('log write failures', () => {
  it('reports the lines a failed write lost, once writing recovers', async () => {
    // A DIRECTORY where the log file belongs makes every append fail with
    // EISDIR — a real fs error, not a stubbed one.
    const logPath = join(dir, 'server.jsonl')
    mkdirSync(logPath)

    // The 500ms interval flush is the path under test: it is the one that
    // calls async `appendFile`. `flushLogs()` drains synchronously through a
    // different call and would not exercise the callback at all.
    warn('lost-line-tag', 'this line cannot be written')
    await new Promise((r) => setTimeout(r, 900))

    rmdirSync(logPath)

    warn('recovery-tag', 'writing works again')
    await new Promise((r) => setTimeout(r, 900))

    const contents = readFileSync(logPath, 'utf-8')
    expect(contents).toContain('writing works again')
    expect(contents).toContain('log file writes failed; lines were lost')
  })
})
