/**
 * A file that does not exist when the tailer starts is created later, so it
 * has no history: the tailer reads it from its first line. An ephemeral data
 * directory creates its logs mid-run, and starting at the end lost them all.
 * Mirrors engine/internal/filetail/follower_born_test.go.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import type { EgressRecord } from '../log-egress'
import {
  startEgressTailers,
  stopEgressTailers,
  _makeStateForTest,
  _pollOnceForTest,
  _closeFdForTest,
  _setShipFnForTest,
  _restoreShipFnForTest,
} from '../log-egress-tailer'

function line(msg: string): string {
  return JSON.stringify({ ts: new Date().toISOString(), level: 'INFO', msg, component: 'engine', tag: 'test' })
}

describe('tailer reads a file born after it started', () => {
  let dir: string
  const shipped: EgressRecord[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ion-tailer-born-'))
    process.env.ION_DATA_DIR = dir
    shipped.length = 0
    _setShipFnForTest((rec) => { shipped.push(rec) })
  })
  afterEach(() => {
    _restoreShipFnForTest()
    delete process.env.ION_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('ships every line of a file that appears after the first poll', async () => {
    const filePath = join(dir, 'telemetry.jsonl')
    const state = _makeStateForTest(filePath)
    await _pollOnceForTest(state, {})

    writeFileSync(filePath, line('first') + '\n' + line('second') + '\n', 'utf-8')
    await _pollOnceForTest(state, {}) // opens the new file
    await _pollOnceForTest(state, {}) // drains it
    expect(shipped.map((r) => r.msg)).toEqual(['first', 'second'])
    _closeFdForTest(state)
  })

  it('still skips history in a file present at the first poll', async () => {
    const filePath = join(dir, 'engine.jsonl')
    writeFileSync(filePath, line('history') + '\n', 'utf-8')
    const state = _makeStateForTest(filePath)
    await _pollOnceForTest(state, {})
    appendFileSync(filePath, line('new') + '\n', 'utf-8')
    await _pollOnceForTest(state, {})
    expect(shipped.map((r) => r.msg)).toEqual(['new'])
    _closeFdForTest(state)
  })
})

describe('tailer looks at its files when it starts', () => {
  let dir: string
  const shipped: EgressRecord[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ion-tailer-start-'))
    process.env.ION_DATA_DIR = dir
    shipped.length = 0
    _setShipFnForTest((rec) => { shipped.push(rec) })
  })
  afterEach(() => {
    stopEgressTailers()
    _restoreShipFnForTest()
    delete process.env.ION_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  // History is what exists at start. A line written before the first tick is
  // new; the old first look at the tick took it for history and skipped it.
  it('ships a line written before the first tick', async () => {
    const serverLog = join(dir, 'server.jsonl')
    writeFileSync(serverLog, line('history') + '\n', 'utf-8')
    startEgressTailers(['server'])
    await new Promise((resolve) => setTimeout(resolve, 50))
    appendFileSync(serverLog, line('early') + '\n', 'utf-8')
    await new Promise((resolve) => setTimeout(resolve, 2_300))
    expect(shipped.map((r) => r.msg)).toEqual(['early'])
  })
})
